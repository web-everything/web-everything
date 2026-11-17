/** The single gh pr view files connection truncated a 129-file PR at 100, leaving the stall judge null. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-sweep.mjs';

export default {
  id: 'stall-sweep-pages-files-past-100',
  title: 'a 129-file stalled PR reproduces the old null verdict, pages all files, and refuses incomplete evidence',
  card: '#8534 stall sweep: page PR files past 100',
  fixedBy: { sha: '2f25ca8a85', where: 'stall-sweep file pagination', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('/files?per_page=100&page=${page}') && source.includes('list.length !== view.changedFiles');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-stall-files-'));
    const violations = [];
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { runStallSweep, STALL_SWEEP_DEFAULTS } = await load(SOURCE);
      const { judgeRound } = await load('scripts/lib/round-judge.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 8534, head = 'a'.repeat(40);
      const now = Date.parse('2026-11-16T18:00:00Z');
      const old = new Date(now - 3 * 3600_000).toISOString();
      const files = Array.from({ length: 129 }, (_, i) => `scripts/file-${i}.mjs`);
      const pagePath = page => `repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`;
      const fixture = (truncated = false) => {
        const calls = [];
        const gh = (bin, args) => {
          calls.push(args);
          if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view'
            && args[2] === String(pr) && args[3] === '-R' && args[4] === repo && args[5] === '--json') {
            if (args[6] === 'files,changedFiles') {
              return JSON.stringify({ changedFiles: files.length, files: files.slice(0, 100).map(path => ({ path })) });
            }
            if (args[6] === 'changedFiles') return JSON.stringify({ changedFiles: files.length });
          }
          if (bin === 'gh' && args.length === 2 && args[0] === 'api') {
            if (args[1] === pagePath(1)) return JSON.stringify(files.slice(0, 100).map(filename => ({ filename })));
            if (args[1] === pagePath(2)) return JSON.stringify((truncated ? [] : files.slice(100)).map(filename => ({ filename })));
          }
          throw new Error(`unexpected GitHub call: ${JSON.stringify(args)}`);
        };
        return { gh, calls };
      };
      const sweep = async (name, { gh, readFiles }) => {
        const judged = [];
        const out = await runStallSweep({ now, env: {}, dir: join(dir, name), log: () => {}, gh,
          settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: { mode: 'soak' }, errors: [] },
          ...(readFiles ? { readFiles } : {}),
          judge: args => { judged.push(args); return judgeRound(args); },
          dispatchRestart: () => { throw new Error('unexpected restart dispatch'); },
          read: () => ({ now, unreadable: [], liveJobs: [], drainSkips: [], prs: [{ repo, number: pr,
            title: '129-file PR at the round cap', state: 'OPEN', isDraft: false, headRefOid: head,
            updatedAt: old, createdAt: old, headCommittedAt: old, body: '',
            labels: [{ name: 'status:at-round-limit' }], statusCheckRollup: [], labelEvents: [], comments: [] }] }) });
        return { out, judged };
      };

      // Replay the pre-fix single-connection loader through the sweep's existing readFiles seam.
      const legacy = fixture();
      let legacyCount = null;
      const before = await sweep('legacy', { gh: legacy.gh, readFiles: (r, n) => {
        const view = JSON.parse(legacy.gh('gh', ['pr', 'view', String(n), '-R', r, '--json', 'files,changedFiles']));
        legacyCount = view.files.length;
        if (view.files.length !== view.changedFiles) throw new Error('unreadable or truncated file list');
        return view.files.map(file => file.path);
      } });
      const closed = ({ out, judged }) => out.incomplete === true && out.act.length === 0 && judged.length === 0
        && out.errors.some(error => error.includes('unreadable or truncated file list'))
        && out.items.length === 1 && out.items[0].verdict === null && out.items[0].lane === 'operator';
      if (legacyCount !== 100 || !closed(before) || legacy.calls.length !== 1) {
        violations.push('[pre-fix-truncation] 100 of 129 files must throw and leave an operator null verdict');
      }

      // No readFiles override: exercise the real fixed loader and real judge.
      const paged = fixture();
      const after = await sweep('paged', paged);
      if (after.judged.length !== 1 || JSON.stringify(after.judged[0].files) !== JSON.stringify(files)
        || after.out.incomplete || after.out.errors.length || after.out.act.length
        || after.out.items.length !== 1 || after.out.items[0].verdict !== 'send-back'
        || JSON.stringify(after.out).includes('not an object')) {
        violations.push(`[paged-complete-verdict] all 129 files must reach the judge without a null verdict: ${JSON.stringify(after.out)}`);
      }
      if (JSON.stringify(paged.calls) !== JSON.stringify([
        ['pr', 'view', String(pr), '-R', repo, '--json', 'changedFiles'],
        ['api', pagePath(1)], ['api', pagePath(2)],
      ])) violations.push('[bounded-pagination] expected exactly one count read and two read-only file pages');

      const missing = fixture(true);
      const incomplete = await sweep('missing-second-page', missing);
      if (!closed(incomplete) || missing.calls.length !== 3) {
        violations.push('[missing-second-page-fails-closed] 100 of 129 paged files must refuse judging and automatic action');
      }
      return { violations };
    } catch (error) { return { violations: [...violations, error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
