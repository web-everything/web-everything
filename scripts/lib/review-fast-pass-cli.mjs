/** Small real-IO adapter; all dispatch still goes through cliReviewTickOpts. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSelfSync } from './daemon-self-sync.mjs';
import { checkMainStaleness, gitRun } from './main-staleness.mjs';
import { runFastPass } from './review-fast-pass.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { assertCapability } from './repo-profile.mjs';
import { readLiveRedTeamPr } from './red-team-dispatch-queue.mjs';
import { listReviewJobAgents } from '../operations/review-job-store.mjs';
import { runReconcilePass } from '../conveyor/reconcile-pass.mjs';
import { planClaudeAuthDispatchGate } from '../conveyor/claude-auth-health.mjs';
import { withGithubAppAuth, FLEET_APP_AUTH_OPTS } from './github-app-auth-env.mjs';
import { RUNNER_LOCK_ROOT, makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned } from '../../skills-src/conveyor/runner-lock.mjs';

const DISPATCH_LEASE_KEY = '<conveyor:review-daemon-lease>';
export const REVIEW_FAST_PASS_LEASE_KEY = '<conveyor:review-fast-pass-lease>';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fastPlanPath = repo => join(root, '.conveyor', `review-fast-plan-${encodeURIComponent(repo)}.json`);
export function saveFastPlan({ repo, plan, rawPrs, mainSha }, { path = fastPlanPath(repo), now = Date.now } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, JSON.stringify({ plan, rawPrs, mainSha, savedAt: now() }), { mode: 0o600 });
  renameSync(temp, path);
}

/** Repository-specific remote tip, shared by snapshot production and fast-pass validation. */
export function readRemoteMainSha(repo, gh = runGhSync) {
  const sha = String(gh(['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, throttle: { maxAttempts: 1 } })).trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw Error('remote main unknown');
  return sha;
}

export function fastPassOptions({ repo, options, budget = options.liveReviewBudget, starts = { count: 0 }, log = console.error, io = {} }) {
  const { gh = runGhSync, readLivePr = readLiveRedTeamPr, readJobs = listReviewJobAgents,
    readPlan = () => JSON.parse(readFileSync(fastPlanPath(repo), 'utf8')),
    reconcile = runReconcilePass, auth = planClaudeAuthDispatchGate, capability = assertCapability,
    staleness = checkMainStaleness } = io;
  return {
    repo, log, readLastPlan: readPlan,
    mainSha: () => readRemoteMainSha(repo, gh),
    // No server-side label filter (search-backed, #no-label-search): list open PRs and filter here.
    readPr: args => {
      if (!args.pending) return readLivePr(args);
      const rows = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open',
        '--limit', '300', '--json', 'number,headRefOid,labels,updatedAt'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, throttle: { maxAttempts: 1 } }));
      if (!Array.isArray(rows) || rows.length >= 300) throw Error('PR inventory truncated; use normal tick');
      return rows.filter(pr => (pr.labels ?? []).some(l => (l?.name ?? l) === 'review:pending'));
    },
    readAgents: () => options.readAgents({ readOnly: true }), readJobs: () => readJobs({ readOnly: true }),
    starts, budget, acquirableLanes: options.acquirableLanes,
    liveCap: ({ jobs }) => {
      log(`review-fast-pass: ${budget.reason}`);
      return Math.min(budget.max ?? 0, jobs.length + starts.count + Math.max(0, budget.left - (budget.reserve ?? 0)));
    },
    planOne: ({ pr, agents }) => {
      const authGate = auth();
      const refusal = capability(repo, 'review');
      if (authGate?.paused !== false || refusal) throw Error(refusal?.why ?? authGate?.reason ?? 'auth unknown');
      // Fresh main-red facts, rather than transferring per-head enrichment from the saved plan.
      return reconcile({ repo, readOnly: true, readPrs: () => [pr], readAgents: () => agents });
    },
    hostAdmission: options.hostAdmission,
    dispatch: args => {
      // This read is immediately adjacent to dispatch, including the session mode that lacks a head pin.
      const live = readLivePr({ repo, pr: args.pr });
      if (live?.headRefOid !== args.expectedHead) throw Error('head moved or unreadable before spawn');
      return options.dispatch({ ...args, strictStackEvidence: true, checkStaleness: checkout => {
        const evidence = staleness({ autoFf: false, cleanOnly: true, strict: true,
          run: argv => gitRun(argv, { cwd: checkout }) });
        if (!evidence || evidence.offline || (!evidence.fresh && evidence.action !== 'warn')) throw Error('main freshness unknown');
        return evidence;
      } });
    },
  };
}

export async function runFastPassCli({ repos, cliReviewTickOpts, sharedHostBudget, runDaemonLoop, selfSyncOptions = {}, optionsIo, lockRoot = RUNNER_LOCK_ROOT, appAuth = withGithubAppAuth,
  env = process.env, once = process.argv.includes('--once'), log = console.error } = {}) {
  const setting = cascadePolicy('reviewFastPass', undefined, {
    env, standard: { intervalMs: 105000 }, envValues: { intervalMs: env.WE_REVIEW_FAST_PASS_INTERVAL_MS === undefined
      ? undefined : Number(env.WE_REVIEW_FAST_PASS_INTERVAL_MS) },
    valid: { intervalMs: n => Number.isInteger(n) && n >= 90000 && n <= 120000 },
  });
  log(`review-fast-pass: intervalMs=${setting.value.intervalMs} (source: ${setting.sources.intervalMs})`);
  const owner = makeOwner('review-fast-pass');
  const key = REVIEW_FAST_PASS_LEASE_KEY;
  if (!acquireRunnerLease(lockRoot, owner, { key }).ok) { log('review-fast-pass: lease held; exiting'); return; }
  const release = () => releaseRunnerLeaseIfOwned(lockRoot, owner, { key });
  const stop = () => { release(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const effects = appAuth({
      tickOnce: async () => {
        if (!acquireRunnerLease(lockRoot, owner, { key: DISPATCH_LEASE_KEY }).ok) {
          log('review-fast-pass: ordinary dispatch lease held; deferred to normal tick');
          return;
        }
        try {
          const options = cliReviewTickOpts();
          options.hostAdmission = sharedHostBudget(options.hostAdmission, log);
          const starts = { count: 0 };
          const results = [];
          for (const repo of repos) results.push(await runFastPass(fastPassOptions({ repo, options, starts, log, io: optionsIo })));
          return { failed: results.flatMap(r => r.failed.map(f => ({ error: f.reason }))) };
        } finally { releaseRunnerLeaseIfOwned(lockRoot, owner, { key: DISPATCH_LEASE_KEY }); }
      },
      intervalMs: setting.value.intervalMs, maxTicks: once ? 1 : Infinity,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      heartbeat: () => heartbeatRunnerLease(lockRoot, owner, { key }),
      onTickError: error => log(`review-fast-pass: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`),
    }, FLEET_APP_AUTH_OPTS);
    await runDaemonLoop(withSelfSync(effects, { root, ...selfSyncOptions }));
  } finally { release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
