/** PR #5948: discovered identities survive failed readiness reads and budget deferral. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMergeWatch } from '../../pass-daemons/pr-merge-watch-pass.mjs';

const SOURCE = 'scripts/conveyor/pass-daemons/pr-merge-watch-pass.mjs';
const repo = 'example/widgets';
const head = 'a'.repeat(40);
const at = minute => new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString();
export default {
  id: 'merge-watch-discovery-before-evidence',
  title: 'discovered PRs merge before their first successful readiness read',
  card: 'PR #5948',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-events-merge', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('// Persist discovery before readiness reads or budget deferral.');
  },
  async run({ log = () => {}, runPass = runMergeWatch } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-merge-discovery-'));
    const violations = [], events = [];
    let tick = 0, calls = 0;
    const attempts = new Map();
    try {
      const gh = args => {
        calls++;
        if (args[0] === 'pr' && args[1] === 'view') {
          const number = Number(args[2]);
          if (number % 3 === 0) throw Error('view unavailable');
          return { number, state: number % 3 === 1 ? 'CLOSED' : 'OPEN', headRefOid: head,
            isDraft: false, labels: [{ name: 'review:accepted' }, { name: 'red-team:clear' }],
            mergeStateStatus: 'CLEAN' };
        }
        if (args[0] !== 'api' || args.length !== 2) throw Error('unexpected GitHub call');
        const [path, query] = args[1].split('?');
        if (path === `repos/${repo}/pulls`) {
          const page = Number(new URLSearchParams(query).get('page'));
          return tick === 0 ? Array.from({ length: 140 }, (_, i) => ({
            number: i + 1, state: 'open', head: { sha: head },
          })).slice((page - 1) * 100, page * 100) : [];
        }
        if (path.endsWith('/comments')) throw Error('comments unavailable');
        if (/\/pulls\/\d+$/.test(path)) return {
          number: Number(path.split('/').at(-1)), state: 'closed', merged_at: at(1),
        };
        throw Error('unexpected GitHub endpoint');
      };
      for (tick = 0; tick < 6; tick++) {
        calls = 0;
        // Each invocation reloads persisted state, including after refused event delivery.
        await runPass({ repos: [repo], gh, now: at(tick), stateDir: root,
          settings: { readyNotMergingMinutes: 60 }, signalLogs: () => [], log: () => {},
          emitEvent: async event => {
            const attempt = (attempts.get(event.pr) ?? 0) + 1;
            attempts.set(event.pr, attempt);
            if (event.pr === 140 && attempt === 1) return false;
            events.push(event);
            return true;
          } });
        if (calls > 128) violations.push(`tick ${tick} exceeded the request budget`);
        if (tick === 0) {
          let saved;
          try { saved = JSON.parse(readFileSync(join(root, `${encodeURIComponent(repo)}.json`), 'utf8')); }
          catch { /* Missing state is the original defect, reported below. */ }
          if (Object.keys(saved?.prs ?? {}).length !== 140) violations.push('discovery did not persist all 140 PRs');
          if (events.length) violations.push('incomplete readiness evidence emitted an event');
        }
      }
      for (let pr = 1; pr <= 140; pr++) {
        if (events.filter(e => e.kind === 'pr-merged' && e.repo === repo && e.pr === pr).length !== 1) {
          violations.push(`PR ${pr} did not deliver exactly one merge event`);
        }
      }
      if (events.some(e => e.kind !== 'pr-merged')) violations.push('unexpected readiness event');
      log(`6 ticks; ${events.length}/140 merge events; ${violations.length} violations`);
    } finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
