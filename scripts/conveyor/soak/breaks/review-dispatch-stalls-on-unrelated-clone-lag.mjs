/**
 * @file breaks/review-dispatch-stalls-on-unrelated-clone-lag.mjs — live incident 2026-10-03 21:16-21:39 ET, the
 * review daemon (`wev-review-daemon`) refused EVERY review dispatch: "the dispatching checkout is 21 commit(s)
 * behind origin/main — refusing to dispatch a review that would run STALE code".
 *
 * ROOT CAUSE (two defects, both reproduced here):
 *  1. The review daemon dispatches through `review-job.mjs#dispatchReviewJob` (the default mode), which called
 *     `assertMainNotStale` WITHOUT a dispatch path. #4387 narrowed the refusal to the review code path, but only
 *     wired it into the `--mode=session` `dispatchReview`. So on the default path any code file behind (here: only
 *     lane-pool and backlog code, none of it run by a review) made the managed clone "stale".
 *  2. The clone could not catch up: its rebuild smoke took ~1000 s (`lane-pool list` 206 s, `acquire` 181 s on a
 *     loaded host with a busy pool), while main moved every ~2 min from the drain's own merges.
 *
 * FIX: `dispatchReviewJob` passes `isReviewCodePath`; the smoke's two pool probes run under a short cap and are
 * recorded as `skipped: busy pool` (never failed) when the pool and host are provably busy.
 *
 * SCENARIO (real git, real modules from `sourceRoot`):
 *   A. a managed clone is 21 commits behind its origin, every commit touching only code a review never runs —
 *      `dispatchReviewJob` must start the job;
 *   B. a smoke whose `lane-pool list` hits its cap on a busy host must pass with that row skipped, not fail.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const job = await import(pathToFileURL(join(src, 'scripts/operations/review-job.mjs')).href);
const smoke = await import(pathToFileURL(join(src, 'scripts/lib/daemon-live-smoke.mjs')).href);
const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(src, 'scripts/lib/constellation-repos.mjs')).href);
const out = { spawned: null, threw: null, smoke: null };
try {
  const r = job.dispatchReviewJob({
    ciGate: () => ({ allowed: true, headSha: 'a'.repeat(40) }), pr: 3771, repo: CONSTELLATION_REPOS.we.slug,
    root: process.env.SOAK_CLONE, dir: process.env.SOAK_JOBS, readCompletion: () => null,
    resolveSettingsEnv: () => null, spawnJob: () => 4242,
  });
  out.spawned = r.jobPid ?? null;
} catch (e) { out.threw = String(e.message).split('\\n')[0]; }
let t = 1_000_000;
const runChild = async (cmd, args) => {
  if (cmd === 'node' && args[0] === '--input-type=module') return String(args[2] || '').includes('daemon-boot-smoke:entry-boot') ? '{"ok":true}' : '[{"kind":"stub","pr":null,"ok":true}]';
  if (cmd === 'git' && args[0] === 'status') return '';
  if (cmd === 'node' && args[1] === 'list') { t += 206_000; throw new Error('timed out after 60000ms (process group killed)'); }
  if (cmd === 'node' && args[1] === 'acquire') return JSON.stringify({ lane: 1 });
  return '';
};
const r = await smoke.runLiveSmoke({ root: '/x', env: { WE_SMOKE_BUSY_LOAD_RATIO: '0.0001' }, runChild, clock: () => t, hostBusy: () => true });
out.smoke = { pass: r.pass, list: (r.results.find((x) => x.name === 'lane-pool-list') || {}).detail };
process.stdout.write(JSON.stringify(out));
`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export default {
  id: 'review-dispatch-stalls-on-unrelated-clone-lag',
  title: 'the review daemon refuses every review while its managed clone lags main in code a review never runs, and the rebuild smoke that would catch it up takes ~1000 s',
  card: 'live incident 2026-10-03 21:16-21:39 ET: 21 commits behind, every review dispatch refused (conveyor fix-review-stale)',
  fixedBy: {
    sha: '31fee720f',
    where: 'lane/fix-review-stale',
    paths: ['scripts/operations/review-job.mjs', 'scripts/lib/daemon-live-smoke.mjs'],
  },
  fixPresent(root) {
    const p = join(root, 'scripts/operations/review-job.mjs');
    return existsSync(p) && /dispatchPath: isReviewCodePath/.test(readFileSync(p, 'utf8'));
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-review-stale-'));
    const violations = [];
    try {
      const origin = join(dir, 'origin.git');
      const seed = join(dir, 'seed');
      const clone = join(dir, 'clone');
      mkdirSync(origin);
      git(origin, 'init', '--bare', '-q', '-b', 'main');
      git(dir, 'clone', '-q', origin, seed);
      git(seed, 'config', 'user.email', 'soak@example.invalid');
      git(seed, 'config', 'user.name', 'soak');
      writeFileSync(join(seed, 'seed.txt'), 'seed\n');
      git(seed, 'add', '.');
      git(seed, 'commit', '-q', '-m', 'seed');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      git(dir, 'clone', '-q', origin, clone);
      mkdirSync(join(seed, 'scripts/backlog'), { recursive: true });
      for (let i = 0; i < 21; i += 1) {
        writeFileSync(join(seed, i % 2 ? 'scripts/lane-pool.mjs' : 'scripts/backlog/frontmatter.mjs'), `// v${i}\n`);
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', `drain landing ${i}`);
      }
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      log?.('managed clone is 21 commits behind origin/main, only in lane-pool / backlog code');

      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_CLONE: clone, SOAK_JOBS: join(dir, 'jobs'),
            WE_DAEMON_MANAGED_CLONE: '1', WE_DAEMON_STATE_DIR: join(dir, 'state'),
          },
        }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(`job pid: ${out.spawned}; threw: ${out.threw}; smoke: ${JSON.stringify(out.smoke)}`);
      if (out.spawned !== 4242) {
        violations.push({
          invariant: 'review-dispatches-despite-off-path-lag',
          detail: `the review job was NOT started on a clone 21 commits behind only in code a review never runs; ${out.threw ? `it threw: ${out.threw}` : 'it did nothing'}`,
        });
      }
      if (!out.smoke?.pass || !/^skipped: busy pool/.test(String(out.smoke?.list ?? ''))) {
        violations.push({
          invariant: 'busy-pool-probe-is-skipped-not-failed',
          detail: `a lane-pool list that hit its cap on a busy host failed the smoke instead of being skipped: ${JSON.stringify(out.smoke)}`,
        });
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
