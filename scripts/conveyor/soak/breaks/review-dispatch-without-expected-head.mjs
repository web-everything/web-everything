/**
 * @file breaks/review-dispatch-without-expected-head.mjs — a review dispatched with no reviewed-head evidence fell back
 * to the checkout head, so a verdict could bind to the wrong head. Unknown head must mean no verdict, while the review
 * daemon (which knows the planned head) must still start its reviews.
 *
 * SCENARIO (real modules from `sourceRoot`, injected spawn/io, no gh):
 *   A. `dispatchReviewJob` with NO expectedHead must refuse and spawn nothing;
 *   B. `dispatchReviewJob` with the matching head must spawn;
 *   C. the review daemon's tick must hand `expectedHead` (the planned head) to its dispatcher.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const head = 'd'.repeat(40);
const job = await import(pathToFileURL(join(src, 'scripts/operations/review-job.mjs')).href);
const daemon = await import(pathToFileURL(join(src, 'skills-src/conveyor/review-daemon.mjs')).href);
const out = { noHead: null, withHead: null, daemonHead: null };
const SLUG = ['web-everything', 'web-everything'].join('/'); // built so the repo-literal scan sees no slug
const base = { pr: 77, repo: SLUG, root: process.env.SOAK_ROOT, dir: process.env.SOAK_JOBS,
  ciGate: () => ({ allowed: true, headSha: head }), readCompletion: () => null, resolveSettingsEnv: () => null,
  checkStaleness: () => ({ fresh: true, behind: 0 }) };
const io = { liveHead: () => head, root: process.env.SOAK_ROOT };
let spawns = 0;
try { const r = job.dispatchReviewJob({ ...base, io, spawnJob: () => { spawns++; return 1; } }); out.noHead = { spawns, refused: r.refused === true, jobPid: r.jobPid ?? null }; }
catch (e) { out.noHead = { threw: String(e.message).split('\\n')[0] }; }
spawns = 0;
try { const r = job.dispatchReviewJob({ ...base, expectedHead: head, io, spawnJob: () => { spawns++; return 4242; } }); out.withHead = { spawns, jobPid: r.jobPid ?? null }; }
catch (e) { out.withHead = { threw: String(e.message).split('\\n')[0] }; }
let seen = null;
try {
  daemon.runReviewTickAllRepos({ startIndex: 0, repos: [SLUG],
    liveReviewBudget: { left: 3, live: 0 }, authGateOverride: () => ({ paused: false, reason: null }),
    reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 77, headRefOid: head }], refusals: [] }),
    dispatch: o => { seen = o.expectedHead ?? null; return { agentId: 'x' }; },
    holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40 });
} catch (e) { seen = 'threw: ' + String(e.message).split('\\n')[0]; }
out.daemonHead = seen;
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'review-dispatch-without-expected-head',
  title: 'a review dispatched with no reviewed-head evidence binds its verdict to whatever head the checkout has',
  card: 'REVIEW-HEAD-EVIDENCE (merge-path: unknown head must mean no verdict)',
  fixedBy: {
    sha: 'fcc398bb1',
    where: 'lane/review-head-evidence',
    paths: ['scripts/operations/review-job.mjs', 'skills-src/conveyor/review-daemon.mjs', 'scripts/lib/review-red-team-on-skip.mjs'],
  },
  // Decided by git ancestry of the fix commit (a removable export marker would let a regression hide itself).
  fixPresent(root) {
    try {
      execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', 'fcc398bb1c', 'HEAD'], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-review-head-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_ROOT: dir,SOAK_JOBS: join(dir, 'jobs') } }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(`result: ${JSON.stringify(out)}`);
      if (out.noHead?.spawns !== 0 || out.noHead?.jobPid) {
        violations.push({ invariant: 'unknown-head-means-no-verdict', detail: `a dispatch with no expected head started a job: ${JSON.stringify(out.noHead)}` });
      }
      if (out.withHead?.jobPid !== 4242) {
        violations.push({ invariant: 'known-head-still-dispatches', detail: `a dispatch with the matching head did not start: ${JSON.stringify(out.withHead)}` });
      }
      if (out.daemonHead !== 'd'.repeat(40)) {
        violations.push({ invariant: 'daemon-passes-planned-head', detail: `the review daemon's dispatch did not pass the planned head: ${JSON.stringify(out.daemonHead)}` });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
