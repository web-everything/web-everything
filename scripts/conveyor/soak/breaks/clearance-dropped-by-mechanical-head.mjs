/**
 * Operator 2026-10-21: #5742 lost clear-human three times to drain numbering,
 * #5530 to numbering after a rebase, and #5485 to a plain accept on the SAME head.
 * Replay real git history through the production human-surface reader, with local
 * coverage/formal-review readers. No GitHub, daemon, host git config or hooks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SETTINGS = { bindTo: { value: 'fingerprint', source: 'soak' },
  normalizeNumbering: { value: true, source: 'soak' } };
const APP = (context = 3, value = 5) => ['const a = 1;', 'const b = 2;', `const c = ${context};`,
  'const d = 4;', `const e = ${value};`, 'const f = 6;', 'const g = 7;', 'const h = 8;', ''].join('\n');
const trusted = body => ({ body, viewerDidAuthor: true });

export default {
  id: 'clearance-dropped-by-mechanical-head',
  title: 'operator clearance survives mechanical heads and fresh plain accepts, but never a one-byte content change',
  card: 'live PRs #5742 (3x), #5530 and #5485; operator 2026-10-21',
  fixedBy: {
    sha: '9a086707d', where: 'lane/approval-fingerprint',
    paths: ['scripts/lib/approval-binding.mjs', 'scripts/lib/review-escalation.mjs',
      'scripts/conveyor/human-surface-repark.mjs'],
  },
  fixPresent(root) {
    try {
      return /export function clearanceCovers\b/.test(readFileSync(join(root, 'scripts/lib/approval-binding.mjs'), 'utf8'))
        && readFileSync(join(root, 'scripts/conveyor/human-surface-repark.mjs'), 'utf8').includes('clearanceBindsHead(');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const temp = mkdtempSync(join(tmpdir(), 'soak-approval-fingerprint-'));
    const deadline = Date.now() + 20_000;
    try {
      // These modules exist before the fix too: never import approval-binding
      // just to set up git or stamp the operator's original clearance.
      const { planHumanSurfaceRepark } = await load('scripts/conveyor/human-surface-repark.mjs');
      const { buildReviewedShaMarker, buildReviewedDiffMarker, buildReviewedContributionMarker,
        buildClearedHumanMarker, REVIEW_LABELS } = await load('scripts/lib/review-escalation.mjs');
      const binding = existsSync(join(sourceRoot, 'scripts/lib/approval-binding.mjs'))
        ? await load('scripts/lib/approval-binding.mjs') : null;
      // A pre-fix reader has no coverage injection. Let its own output establish
      // the regression; the missing module itself is never a violation.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      Object.assign(env, { HOME: temp, XDG_CONFIG_HOME: temp, GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'file' });
      writeFileSync(env.GIT_CONFIG_GLOBAL, '');
      const cwd = join(temp, 'repo');
      mkdirSync(cwd);
      mkdirSync(join(temp, 'hooks'));
      const exec = (tool, args, options = {}) => {
        if (tool !== 'git') throw new Error(`unexpected tool: ${tool}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('scenario exceeded its 20-second budget');
        return execFileSync(tool, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options, cwd, env,
          timeout: Math.min(options.timeout ?? 2000, 2000, remaining),
          maxBuffer: Math.min(options.maxBuffer ?? 4 * 1024 * 1024, 4 * 1024 * 1024) });
      };
      const git = args => exec('git', args).trim();
      const write = (path, text) => writeFileSync(join(cwd, path), text);
      const commit = message => {
        git(['add', '-A']);
        git(['commit', '-q', '-m', message]);
        return git(['rev-parse', 'HEAD']);
      };
      git(['init', '-q', '--template=', '-b', 'main']);
      for (const [key, value] of [['user.email', 'soak@example.com'], ['user.name', 'Approval Soak'],
        ['core.hooksPath', join(temp, 'hooks')], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
        git(['config', key, value]);
      }
      for (const dir of ['backlog', 'scripts', '.github/workflows']) mkdirSync(join(cwd, dir), { recursive: true });
      write('backlog/0001-parent.md', 'parent card\n');
      write('scripts/app.mjs', APP());
      write('.github/workflows/merge-gate.yml', 'name: old\n');
      const base = commit('base');
      git(['update-ref', 'refs/remotes/origin/main', base]);
      git(['checkout', '-q', '-b', 'pr']);
      write('backlog/xabc123-foo.md', '---\nkind: story\n---\nfollow-up of the app change\n');
      write('backlog/0001-parent.md', 'parent card\nsee #xabc123\n');
      write('scripts/app.mjs', APP(3, 50));
      write('.github/workflows/merge-gate.yml', 'name: new\n');
      const cleared = commit('the change the operator cleared');
      const netDiff = sha => exec('git', ['diff', '--no-ext-diff', '--no-relative', '--end-of-options',
        git(['merge-base', 'origin/main', sha]), sha]);
      const markers = (sha, diff) => [buildReviewedShaMarker(sha), buildReviewedDiffMarker(diff),
        buildReviewedContributionMarker(diff)].join('\n');
      const clearance = trusted(['✅ review — `review:human` cleared via the sanctioned path', '',
        'Cleared by chalbert via `review-set-label.mjs --to=clear-human`', '', markers(cleared, netDiff(cleared)),
        buildClearedHumanMarker('chalbert')].join('\n'));
      const number = () => {
        const content = readFileSync(join(cwd, 'backlog/xabc123-foo.md'), 'utf8');
        git(['mv', 'backlog/xabc123-foo.md', 'backlog/7001-foo.md']);
        write('backlog/7001-foo.md', content.replace(/^---\n/, '---\nbornAs: xabc123\n'));
        write('backlog/0001-parent.md', 'parent card\nsee #7001\n');
        return commit('drain: JIT-number xabc123→#7001 at land (#2288)');
      };
      const readPlan = headSha => {
        // A new plain acceptance (including a drain restamp) must not erase the
        // earlier operator record, nor lend that clearance to changed content.
        const comments = [clearance, trusted(`✅ review — accepted\n\n${markers(headSha, netDiff(headSha))}`)];
        return planHumanSurfaceRepark({ currentLabels: [REVIEW_LABELS.accepted], headSha, comments,
          files: git(['diff', '--name-only', 'origin/main', headSha]).split('\n'), surfaces: 'narrow',
          clearanceCoverage: binding ? () => {
            const coverage = binding.computeClearanceCoverage({ comments, liveHead: headSha,
              exec, cwd, settings: SETTINGS, reviews: () => [], log: () => {} });
            return coverage;
          } : null });
      };
      const retained = (name, head) => {
        const plan = readPlan(head);
        log?.(`${name}: repark=${plan.repark}, addLabel=${plan.decision?.addLabel ?? 'none'}`);
        check(plan.repark === false && plan.decision?.addLabel !== REVIEW_LABELS.human,
          `${name}: reader re-parks review:human after losing the operator clearance`);
      };
      retained('#5742 drain numbering', number());
      git(['reset', '-q', '--hard', cleared]);
      retained('#5485 same-head plain accept', cleared);

      // Never weakened: change exactly one byte on top of H, with a plain accept
      // of X. Both the old and new reader must require human clearance again.
      write('scripts/app.mjs', APP(3, 51));
      const changed = commit('one-byte content change');
      const control = readPlan(changed);
      log?.(`one-byte control: repark=${control.repark}, addLabel=${control.decision?.addLabel ?? 'none'}`);
      check(control.repark === true && control.decision?.addLabel === REVIEW_LABELS.human,
        'one-byte control: reader retained clearance for changed content');

      git(['reset', '-q', '--hard', cleared]);
      git(['checkout', '-q', 'main']);
      write('scripts/app.mjs', APP(33));
      const main2 = commit('main changes a context line');
      git(['update-ref', 'refs/remotes/origin/main', main2]);
      git(['checkout', '-q', 'pr']);
      git(['rebase', '-q', 'main']);
      retained('#5530 numbering after rebase', number());
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: r => r.violations,
};
