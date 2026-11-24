/** Small real-IO adapter; all dispatch still goes through cliReviewTickOpts. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFastPass } from './review-fast-pass.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { assertCapability } from './repo-profile.mjs';
import { readLiveRedTeamPr } from './red-team-dispatch-queue.mjs';
import { listReviewJobAgents } from '../operations/review-job-store.mjs';
import { runReconcilePass, defaultResolveMainSha } from '../conveyor/reconcile-pass.mjs';
import { planClaudeAuthDispatchGate } from '../conveyor/claude-auth-health.mjs';
import { withGithubAppAuth, FLEET_APP_AUTH_OPTS } from './github-app-auth-env.mjs';
import { RUNNER_LOCK_ROOT, makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned } from '../../skills-src/conveyor/runner-lock.mjs';

export const REVIEW_FAST_PASS_LEASE_KEY = '<conveyor:review-fast-pass-lease>';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fastPlanPath = repo => join(root, '.conveyor', `review-fast-plan-${encodeURIComponent(repo)}.json`);
export function saveFastPlan({ repo, plan, rawPrs, mainSha }, { path = fastPlanPath(repo), now = Date.now } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, JSON.stringify({ plan, rawPrs, mainSha, savedAt: now() }), { mode: 0o600 });
  renameSync(temp, path);
}

export function fastPassOptions({ repo, options, liveReviewRoundBudget, log = console.error }) {
  return {
    repo, log, readLastPlan: () => JSON.parse(readFileSync(fastPlanPath(repo), 'utf8')),
    mainSha: () => defaultResolveMainSha('main'),
    readPr: args => args.pending ? JSON.parse(runGhSync(['pr', 'list', '--repo', repo, '--state', 'open',
      '--label', 'review:pending', '--limit', '101', '--json', 'number,headRefOid,labels,updatedAt'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, throttle: { maxAttempts: 1 } })) : readLiveRedTeamPr(args),
    readAgents: () => options.readAgents({ readOnly: true }), readJobs: () => listReviewJobAgents({ readOnly: true }),
    liveCap: ({ jobs }) => {
      const budget = liveReviewRoundBudget();
      log(`review-fast-pass: ${budget.reason}`);
      return Math.min(budget.max ?? 0, jobs.length + budget.left);
    },
    planOne: ({ pr, agents }) => {
      const auth = planClaudeAuthDispatchGate();
      const capability = assertCapability(repo, 'review');
      if (auth?.paused !== false || capability) throw Error(capability?.why ?? auth?.reason ?? 'auth unknown');
      // Fresh main-red facts, rather than transferring per-head enrichment from the saved plan.
      return runReconcilePass({ repo, readOnly: true, readPrs: () => [pr], readAgents: () => agents });
    },
    hostAdmission: options.hostAdmission, dispatch: options.dispatch,
  };
}

export async function runFastPassCli({ repos, cliReviewTickOpts, liveReviewRoundBudget, runDaemonLoop,
  env = process.env, once = process.argv.includes('--once'), log = console.error } = {}) {
  const setting = cascadePolicy('reviewFastPass', undefined, {
    env, standard: { intervalMs: 105000 }, envValues: { intervalMs: env.WE_REVIEW_FAST_PASS_INTERVAL_MS === undefined
      ? undefined : Number(env.WE_REVIEW_FAST_PASS_INTERVAL_MS) },
    valid: { intervalMs: n => Number.isInteger(n) && n >= 90000 && n <= 120000 },
  });
  log(`review-fast-pass: intervalMs=${setting.value.intervalMs} (source: ${setting.sources.intervalMs})`);
  const owner = makeOwner('review-fast-pass');
  const key = REVIEW_FAST_PASS_LEASE_KEY;
  if (!acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key }).ok) { log('review-fast-pass: lease held; exiting'); return; }
  const release = () => releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key });
  const stop = () => { release(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const effects = withGithubAppAuth({
      tickOnce: async () => {
        for (const repo of repos) await runFastPass(fastPassOptions({ repo,
          options: cliReviewTickOpts(), liveReviewRoundBudget, log }));
      },
      intervalMs: setting.value.intervalMs, maxTicks: once ? 1 : Infinity,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      heartbeat: () => heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key }),
      onTickError: error => log(`review-fast-pass: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`),
    }, FLEET_APP_AUTH_OPTS);
    await runDaemonLoop(effects);
  } finally { release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
