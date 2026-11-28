import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { newRunRecord } from '../../operations/run-record.mjs';
import { readRun, runPath } from '../../operations/run-store.mjs';
import * as abandoned from '../run-abandoned.mjs';
import { reapDeadReviewRuns } from '../reap-dead-review-runs.mjs';
import { readDrainRedTeamEvidence } from '../drain-red-team-evidence.mjs';
import { headNeverReviewedFromRuns, planRedTeamOnSkip, runRedTeamOnSkip, createReviewHoldEscalator } from '../review-red-team-on-skip.mjs';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { createJobStore, enqueueJob, reattachTick, launchJob, JOB_ID_ENV, JOB_ATTEMPT_ENV } from '../daemon-jobs-runtime.mjs';
import { markLaunching, markSucceeded, kindRegistry } from '../daemon-jobs.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';

const HOUR = 3600000, now = Date.parse('2026-11-27T23:00:00Z');
const repo = 'fixture/repo', pr = 7603, head = '5f9446e' + 'a'.repeat(33);
let root, dir, env, probeContext, probes;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'dead-pending-judge-'));
  dir = join(root, 'runs'); fs.mkdirSync(dir);
  env = { HOME: root, WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
    OPERATION_REVIEW_JOBS_DIR: join(root, 'review-jobs'), WE_SHARED_RUNS_DIR: dir,
    WE_COORDINATION_ROOT: join(root, 'coordination') };
  fs.mkdirSync(env.OPERATION_REVIEW_JOBS_DIR);
  probeContext = { checkout: root, pool: 'fixture-pool', poolRoot: join(root, 'pools') };
  probes = { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
function record(extra = {}, id = 'review-pr-pr7603-dead', age = HOUR) {
  const r = { ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
    pending: { kind: 'judge', step: 'judgeAdvisory', stepIndex: 0 },
    findings: { read: { netBasis: { rev: head } } }, ...extra };
  fs.writeFileSync(runPath(id, dir), JSON.stringify(r));
  fs.utimesSync(runPath(id, dir), new Date(now - age), new Date(now - age));
  return r;
}
function tombstone(id, extra = {}) {
  const body = { at: new Date(now).toISOString(), by: 'reap-dead-review-runs', reason: 'dead',
    probes: { recordVersion: abandoned.runRecordVersion(fs.statSync(runPath(id, dir))) }, ...extra };
  fs.writeFileSync(abandoned.abandonedPath(id, dir), JSON.stringify(body));
  return body;
}
const sweep = (extra = {}) => reapDeadReviewRuns({ dir, repo, probeContext, env, probes, now, apply: true, log: () => {}, ...extra });
const neverReviewed = (extra = {}) => headNeverReviewedFromRuns({ repo, pr, head, runsDir: dir, env,
  scanSettings: { env, tool: { scan: { maxParses: 100 } } }, ...extra });
const evidence = (extra = {}) => readDrainRedTeamEvidence({ repo, pr, head, runsDir: dir, env, now,
  readScorecards: () => [], host: 'fixture-host', namespace: 'fixture-namespace', isAlive: () => false, readPidStart: () => 'start', scanSettings: { env }, ...extra });

it('integrated-7603-fresh-dispatch', async () => {
  const r = record(); expect(evidence().reason).toBe('review-unfinished'); expect(neverReviewed()).toBe(false);
  expect((await sweep()).reaped).toEqual([r.id]);
  expect(evidence().reason).not.toBe('review-unfinished'); expect(neverReviewed()).toBe(true);
  const rows = planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], comments: [], reviews: [] }],
    readEvidence: evidence, readStatus: () => null, headNeverReviewed: neverReviewed,
    readReviewRuns: () => [], setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now });
  expect(rows[0].action).toBe('review');
});
it('reap-at-1h-boundary', async () => { const r = record(); expect((await sweep()).reaped).toEqual([r.id]); });
it('kept-young-at-59min', async () => { const r = record({}, undefined, 59 * 60000); expect((await sweep()).kept.young).toEqual([r.id]); });
it.each(['resumeOf', 'resumedAt'])('writer-rejects-%s', async field => {
  const r = record({ [field]: 'previous' }); expect((await sweep()).kept['resumed-run']).toEqual([r.id]);
});
it.each([false, 0, '', {}, [], { verdict: 'changes' }])('writer-rejects-malformed-present-verdict %j', async verdict => {
  const r = record({ verdict }); expect((await sweep()).kept['verdict-present']).toEqual([r.id]);
});
it.each(['unbound-legacy-rejected', 'wrong-producer-rejected', 'mismatched-version-rejected', 'valid-accepted'])('tombstone-%s', name => {
  const kind = name.replace(/-(rejected|accepted)$/, '');
  const r = record(); tombstone(r.id, kind === 'unbound-legacy' ? { probes: {} }
    : kind === 'wrong-producer' ? { by: 'manual' } : kind === 'mismatched-version' ? { probes: { recordVersion: 'old' } } : {});
  expect(abandoned.isReaperTombstone?.(r.id, dir)).toBe(kind === 'valid');
  expect(neverReviewed()).toBe(kind === 'valid');
});
it('legacy-sidecar-recovery', async () => {
  const r = record(); tombstone(r.id, { probes: {} }); expect(neverReviewed()).toBe(false);
  expect((await sweep()).reaped).toEqual([r.id]); expect(neverReviewed()).toBe(true);
  const bytes = fs.readFileSync(abandoned.abandonedPath(r.id, dir));
  await sweep(); expect(fs.readFileSync(abandoned.abandonedPath(r.id, dir))).toEqual(bytes);
});
const effect = (status, more = {}) => ({ key: 'one', type: 'review', stepIndex: 0, index: 0, status, ...more });
it.each([['empty', []], ['applied', [effect('applied')]]])('record-shape-allowed-%s', (_, effects) => {
  const r = record({ effects }); tombstone(r.id); expect(neverReviewed()).toBe(true); expect(evidence().reason).not.toBe('review-unfinished');
});
it.each([['absent', undefined], ['non-array', {}], ...['declared','pending','in-flight','failed','refused','skipped','superseded'].map(s => [s, [effect(s)]]),
  ['mixed', [effect('applied'), effect('pending', { key: 'two', index: 1 })]]])('record-shape-rejected-%s', (_, effects) => {
  const r = record({ effects }); tombstone(r.id); expect(neverReviewed()).toBe(false); expect(evidence().ok).toBe(false);
});
it.each([
  ['rejection', { verdict: { verdict: 'changes' } }], ['pending-effect', { effects: [effect('pending')] }],
  ['in-flight-effect', { effects: [effect('in-flight')] }], ['malformed-effect', { effects: [{}] }],
  ['mandatory-referral', { effects: [effect('applied', { step: 'mandatoryReferrals' })] }],
  ['suspended-answer', { pending: { kind: 'judge', step: 'judge', stepIndex: 0, asks: 'human' } }],
  ['outcome-refused', { outcome: 'refused' }], ['confirm-pending', { pending: { kind: 'confirm', step: 'confirm', stepIndex: 0 } }],
])('reader-holds-%s', (_, extra) => { const r = record(extra); tombstone(r.id); expect(neverReviewed()).toBe(false); });
it('applied-effect-duplicate-key-holds', () => {
  const r = record({ effects: [effect('applied'), effect('applied')] }); tombstone(r.id); expect(neverReviewed()).toBe(false);
});
it('snapshot-race', () => {
  const r = record(); tombstone(r.id); let reads = 0;
  expect(neverReviewed({ read: (id, d) => { const old = readRun(id, d); if (++reads === 1) record({ verdict: { verdict: 'changes' } }); return old; } })).toBe(false);
});
it.each(['created','removed','replaced'])('warm-cache-tombstone-%s', transition => {
  const r = record(); if (transition !== 'created') tombstone(r.id);
  expect(neverReviewed()).toBe(transition !== 'created'); evidence();
  if (transition === 'created') tombstone(r.id);
  else if (transition === 'removed') fs.rmSync(abandoned.abandonedPath(r.id, dir));
  else tombstone(r.id, { by: 'other' });
  expect(neverReviewed()).toBe(transition === 'created');
  expect(evidence().reason === 'review-unfinished').toBe(transition !== 'created');
});
it.each(['dir','repo','probeContext','OPERATION_REVIEW_JOBS_DIR'])('missing-context-refused %s', async field => {
  const r = record(); const extra = field === 'OPERATION_REVIEW_JOBS_DIR' ? { env: { ...env, OPERATION_REVIEW_JOBS_DIR: '' } } : { [field]: undefined };
  if (field === 'dir') extra.env = { ...env, OPERATION_RUNS_DIR: dir };
  const result = await sweep(extra); expect(result.reaped).toEqual([]); expect(result.kept['missing-context']).toEqual([r.id]);
});
it('other-repo-candidate-not-tombstoned', async () => {
  const own = record(), other = record({ input: { repo: 'other/repo', pr } }, 'review-pr-other');
  const result = await sweep(); expect(result.reaped).toEqual([own.id]); expect(result.kept['other-repo']).toEqual([other.id]);
});
it('late-probe-error-writes-no-tombstones', async () => {
  const a = record(), b = record({}, 'review-pr-second'); probes.sessions = () => { throw Error('late session failure'); };
  const result = await sweep(); expect(result.reaped).toEqual([]); expect(result.kept['probe-unreadable']).toEqual([a.id,b.id]);
});
it('authoritative-store', async () => {
  const r = record(); delete probes.reviewJobs;
  fs.writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-7603.json'), JSON.stringify({ repo, pr, pid: 123 }));
  probes.pidIdentity = () => ({ alive: true }); expect((await sweep()).kept['live-review-job']).toEqual([r.id]);
});
it('missing-store-holds', async () => {
  const r = record(); delete probes.reviewJobs; fs.rmSync(env.OPERATION_REVIEW_JOBS_DIR, { recursive: true });
  expect((await sweep()).kept['probe-unreadable']).toEqual([r.id]);
});
it('writer-appears-after-initial-index', async () => {
  const r = record(); probes.sessions = () => { fs.writeFileSync(join(dir, `${r.id}.lock`), '123'); return '[]'; };
  probes.pidIdentity = () => ({ alive: true }); expect((await sweep()).kept['live-writer']).toEqual([r.id]);
});

const jobModule = () => import('../review-run-reap-job.mjs');
function input() { return { reviewRunsDir: dir, repo, probeContext, OPERATION_REVIEW_JOBS_DIR: env.OPERATION_REVIEW_JOBS_DIR }; }
function jobStore() { const d = join(root, 'daemon-jobs'); fs.mkdirSync(d, { recursive: true }); return createJobStore(d); }
async function launched(store) {
  const { REVIEW_RUN_REAP_KIND } = await jobModule();
  const r = enqueueJob({ store, codeSha: 'a'.repeat(40), kindDef: REVIEW_RUN_REAP_KIND, input: input(), now });
  store.update(r.id, old => markLaunching(old, { at: new Date(now).toISOString() }));
  return { ...env, OPERATION_RUNS_DIR: store.dir, [JOB_ID_ENV]: r.id, [JOB_ATTEMPT_ENV]: '1' };
}
it.each(['queued','launching','running','retrying'])('%s-job-blocks-enqueue', async status => {
  const { ensureReviewRunReapJob, REVIEW_RUN_REAP_KIND } = await jobModule(); const store = jobStore();
  const r = enqueueJob({ store, codeSha: 'a'.repeat(40), kindDef: REVIEW_RUN_REAP_KIND, input: input(), now });
  const stub = { list: () => ({ records: [{ ...r, job: { ...r.job, status } }], corrupt: [] }), create: vi.fn() };
  expect(ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), store: stub, now, input: input() }).enqueued).toBe(false); expect(stub.create).not.toHaveBeenCalled();
});
it('no-record-enqueues', async () => {
  const { ensureReviewRunReapJob } = await jobModule();
  expect(ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), store: jobStore(), now, input: input() }).enqueued).toBe(true);
});
it('job-enqueued-every-15min', async () => {
  const { ensureReviewRunReapJob } = await jobModule(); const store = jobStore();
  const first = ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), store, now, input: input() }).record;
  store.update(first.id, r => markSucceeded(r, { at: new Date(now).toISOString() }));
  expect(ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), store, now: now + 15 * 60000 - 1, input: input() }).enqueued).toBe(false);
  expect(ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), store, now: now + 15 * 60000, input: input() }).enqueued).toBe(true);
});
it('retry-does-not-restart-spacing', async () => {
  const { ensureReviewRunReapJob, REVIEW_RUN_REAP_KIND } = await jobModule();
  const r = enqueueJob({ store: jobStore(), codeSha: 'a'.repeat(40), kindDef: REVIEW_RUN_REAP_KIND, input: input(), now });
  expect(() => ensureReviewRunReapJob({ codeSha: 'a'.repeat(40), now, input: input(), store: { list: () => ({ records: [
    { ...r, job: { ...r.job, status: 'failed', finishedAt: 'unreadable' } }], corrupt: [] }) } })).toThrow(/cadence/);
});
it('job-scans-shared-runs-not-job-records', async () => {
  const { runReviewRunReapJob } = await jobModule(); const r = record(); const store = jobStore(); const childEnv = await launched(store);
  expect(await runReviewRunReapJob({ env: childEnv, host: 'fixture-host', pid: 123, readStart: () => 'start', now: () => now,
    reaperOptions: { probes, now, log: () => {} } })).toEqual({ outcome: 'succeeded' });
  expect(abandoned.isReaperTombstone(r.id, dir)).toBe(true);
  expect(fs.readdirSync(store.dir).filter(n => n.endsWith('.abandoned.json'))).toEqual([]);
  expect(store.read(childEnv[JOB_ID_ENV]).job.status).toBe('succeeded');
});
it.each(['reviewRunsDir','repo','probeContext','OPERATION_REVIEW_JOBS_DIR'])('job-refuses-missing-authority-%s', async field => {
  const { runReviewRunReapJob } = await jobModule(); record(); const store = jobStore(), childEnv = await launched(store);
  store.update(childEnv[JOB_ID_ENV], r => ({ ...r, input: { ...r.input, [field]: '' } }));
  const reap = vi.fn(); const result = await runReviewRunReapJob({ env: childEnv, host: 'fixture-host', pid: 123, readStart: () => 'start', now: () => now, reap });
  expect(result.outcome).toBe('error'); expect(reap).not.toHaveBeenCalled();
});
it.each(['matching','wrong-repo','wrong-root','missing-pool'])('snapshot-launched-lease-probe-%s', async mode => {
  const r = record(); delete probes.leases;
  probes.execFileSync = vi.fn((_cmd, args, opts) => {
    expect(opts.cwd).toBeDefined(); expect(args).toContain(`--repo=${probeContext.checkout}`); expect(args).toContain(`--name=${probeContext.pool}`);
    expect(opts.env.LANE_POOL_ROOT).toBe(probeContext.poolRoot); expect(opts.timeout).toBe(45000);
    if (mode === 'missing-pool') throw Error('pool unavailable');
    return JSON.stringify({ repo: mode === 'wrong-repo' ? 'other' : probeContext.pool,
      root: mode === 'wrong-root' ? root : join(probeContext.poolRoot, probeContext.pool), lanes: [{ lane: 1, lease: { runId: r.id } }] });
  });
  expect((await sweep()).kept[mode === 'matching' ? 'live-lease' : 'probe-unreadable']).toEqual([r.id]);
});
it('snapshot-lease-probe-pool-root', async () => {
  const r = record(); delete probes.leases;
  probes.execFileSync = (_cmd, _args, opts) => {
    const marker = join(opts.env.LANE_POOL_ROOT, probeContext.pool, 'lease.json');
    return fs.readFileSync(marker, 'utf8');
  };
  fs.mkdirSync(join(probeContext.poolRoot, probeContext.pool), { recursive: true });
  fs.writeFileSync(join(probeContext.poolRoot, probeContext.pool, 'lease.json'), JSON.stringify({ repo: probeContext.pool,
    root: join(probeContext.poolRoot, probeContext.pool), lanes: [{ lane: 1, lease: { runId: r.id } }] }));
  expect((await sweep()).kept['live-lease']).toEqual([r.id]);
});
it('reap-config-error-propagates', async () => {
  await expect(sweep({ thresholdMs: 0 })).rejects.toThrow(/thresholdMs/);
});
it('reap-probe-failure-held-all', async () => {
  const r = record(); probes.leases = () => { throw Error('lease timed out'); };
  expect((await sweep()).kept['probe-unreadable']).toEqual([r.id]);
});
it('cli-other-pool-live-lease-held', () => {
  const r = record({}, undefined, 8 * HOUR);
  const script = join(dirname(fileURLToPath(import.meta.url)), '../reap-dead-review-runs.mjs');
  const result = spawnSync(process.execPath, [script, '--apply', '--json'], { cwd: root, env: { ...env, OPERATION_RUNS_DIR: dir },
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).kept['missing-context']).toEqual([r.id]);
});
it('reap-cli-apply-json-dry-run-awaited', () => {
  record({}, undefined, 30 * 60000);
  for (const args of [['--json'], ['--json','--apply'], ['--json','--dry-run']]) {
    const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../reap-dead-review-runs.mjs'), ...args],
      { cwd: root, env: { ...env, OPERATION_RUNS_DIR: dir }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).scanned).toBe(1);
  }
});
it('session-reaper-other-pool-live-lease-held', async () => {
  const { runSessionReaperCli } = await import('../../conveyor/session-reaper.mjs'); const r = record({}, undefined, 8 * HOUR);
  let stdout = '';
  const code = await runSessionReaperCli(['--reap-dead-review-runs', '--apply', '--json', '--no-run-rating', '--no-ground-truth',
    '--no-completion-record','--no-hung-detection','--no-auth-expired-detection','--no-idle-finished-detection','--no-pid-dead-detection'],
    { exec: () => '[]', stdout: s => { stdout += s; }, stderr: () => {},
      reapDeadReviewRuns: opts => reapDeadReviewRuns({ ...opts, env: { ...env, OPERATION_RUNS_DIR: dir }, probes, now }) });
  expect(code).toBe(0); expect(JSON.parse(stdout).deadReviewRuns.kept['missing-context']).toEqual([r.id]);
});

function alertFixture(publishNeedsYou, capture = []) {
  const escalate = createReviewHoldEscalator({ env, publishNeedsYou, settle: args => {
    capture.push(args.redTeam.reason); return settleRedTeamSkip(args);
  } });
  const raw = { number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], comments: [], reviews: [] };
  return () => runRedTeamOnSkip({ repo, env, cwd: root, now: () => now, lastDispatch: new Map(),
    plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] }, rawPrs: [raw],
    setting: { enabled: true, retryCooldownMin: 30 }, capacity: { lanes: 1, budget: { left: 1 } },
    readEvidence: () => ({ ok: false, reason: 'review-unfinished' }), readStatus: () => null,
    readReviewRuns: () => [], readWitness: null, readCarry: () => null, headNeverReviewed: () => false,
    readCarriedCheck: () => false, readSeal: () => null, escalate, syncLabels: () => {},
    exec: () => { throw Error('external calls forbidden'); }, dispatch: () => { throw Error('must hold'); },
    readComments: () => [], readCompleteReviews: () => [], provider: { readPrState: () => raw }, log: () => {} });
}
it('alert-published-reason-fixed', () => {
  const captured = [], published = vi.fn(), run = alertFixture(published, captured);
  for (const kind of ['judge','confirm','effect','unknown']) {
    record({ pending: { kind, step: 'hold', stepIndex: 0 } }); run();
  }
  expect(captured).toEqual(['review-unfinished','review-unfinished','review-unfinished','review-unfinished']);
  expect(published).toHaveBeenCalledTimes(1);
});
it('alert-pending-kind-transitions-one-publication', () => {
  const published = vi.fn(), run = alertFixture(published);
  for (const kind of ['judge','confirm','effect','unknown']) { record({ pending: { kind, step: 'hold', stepIndex: 0 } }); run(); }
  expect(published).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(join(root, 'red-team-status', 'skip-published'))).toHaveLength(1);
});
it('alert-publication-failure-retries', () => {
  let failed = true;
  const published = vi.fn(() => { if (failed) throw Error('publication unavailable'); });
  const run = alertFixture(published); expect(run().rows[0].settleError).toContain('publication unavailable');
  expect(fs.existsSync(join(root, 'red-team-status', 'skip-published'))).toBe(false);
  failed = false; run(); run(); expect(published).toHaveBeenCalledTimes(2);
  expect(fs.readdirSync(join(root, 'red-team-status', 'skip-published'))).toHaveLength(1);
});
it('warm-cache-same-size-preserved-mtime-rejection', () => {
  // Stay beyond the quiet horizon even when the filesystem rounds restored mtimes.
  const started = age => ({ stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - age).toISOString() }] });
  const r = record(started(3 * HOUR), undefined, HOUR + 1000);
  record(started(2 * HOUR), 'review-pr-pr7603-holder', HOUR + 1000);
  const query = () => evidence().settleBounds.completeHeadRead({ pr, head, at: now + HOUR });
  expect(query()).toEqual({ complete: true, blocked: false });
  const old = fs.statSync(runPath(r.id, dir));
  const bytes = fs.readFileSync(runPath(r.id, dir), 'utf8');
  const rejected = JSON.stringify({ ...r, verdict: { verdict: 'changes' }, pending: null });
  const size = Math.max(bytes.length, rejected.length);
  fs.writeFileSync(runPath(r.id, dir), bytes.padEnd(size)); fs.utimesSync(runPath(r.id, dir), old.atime, old.mtime); query();
  const tmp = join(root, 'replacement'); fs.writeFileSync(tmp, rejected.padEnd(size));
  fs.utimesSync(tmp, old.atime, old.mtime); fs.renameSync(tmp, runPath(r.id, dir));
  expect(query()).toEqual({ complete: true, blocked: true });
});

/** Exercise the real runtime's heartbeat and reattachment with an injected logical clock and synchronous work. */
async function runtimeSweep({ leaseMs = 0, sessionMs = 0, pidMs = 0, count = 1, localMs = 0, unrelated = 0, young = 0 } = {}) {
  const { runReviewRunReapJob, REVIEW_RUN_REAP_KIND } = await jobModule();
  const store = jobStore(), childEnv = await launched(store), jobId = childEnv[JOB_ID_ENV];
  let time = now, last = now; const beats = [], stops = [];
  const snapshots = new Map();
  for (let i = 0; i < count; i++) {
    const r = record({}, `review-pr-case-${String(i).padStart(5,'0')}`);
    snapshots.set(r.id, r);
  }
  if (pidMs) {
    for (let i=0; i<4; i++) {
      const held = record({}, `review-pr-000-held-${i}`); snapshots.set(held.id, held);
      fs.writeFileSync(join(dir, `${held.id}.lock`), '111');
    }
    probes.pidIdentity = () => { time += pidMs; return { alive: true }; };
  }
  for (let i=0; i<young; i++) { const r = record({}, `review-pr-young-${i}`, 30 * 60000); snapshots.set(r.id, r); }
  // Unrelated entries are listing evidence only: inject them rather than benchmark the host disk.
  const unrelatedFiles = Array.from({ length: unrelated }, (_, i) => `unrelated-${i}.json`);
  let listings = 0;
  // The cumulative-probe case isolates scheduler progress from filesystem throughput. Its writer inventory
  // is fixed; sidecars added by the sweep are not writers. The large-store case still refreshes real writers.
  const fixedInventory = count === 20000 ? fs.readdirSync(dir) : null;
  const readdir = path => { listings++; return fixedInventory ?? fs.readdirSync(path).concat(unrelatedFiles); };
  const started = Date.now();
  const logicalClock = () => time + Date.now() - started;
  probes.leases = () => { time += leaseMs; return '[]'; };
  probes.sessions = () => { time += sessionMs; return '[]'; };
  const yieldTurn = async () => {
    await new Promise(r => setTimeout(r, 2));
    const heartbeat = Date.parse(store.read(jobId).job.heartbeatAt);
    if (heartbeat !== last) { beats.push(heartbeat); last = heartbeat; }
    await reattachTick({ store, kinds: kindRegistry([REVIEW_RUN_REAP_KIND]), maxConcurrent: 1,
      observation: { now: logicalClock(), slept: false, gapMs: 0 }, probe: () => 'alive',
      stop: async () => { stops.push(time); return { gone: true }; }, reapGroup: () => ({ gone: true }), launch: () => { throw Error('unexpected relaunch'); } });
  };
  const result = await runReviewRunReapJob({ env: childEnv, host: 'fixture-host', pid: 123, readStart: () => 'start',
    now: logicalClock, heartbeatIntervalMs: 1, reaperOptions: { now, probes, clock: logicalClock, yieldTurn, log: () => {},
      store: { readdir, tryReadRun: id => { time += localMs; return snapshots.get(id); }, markRunAbandoned: args => {
        time += localMs; return abandoned.markRunAbandoned(args);
      } } } });
  expect(result.outcome).toBe('succeeded'); expect(stops).toEqual([]);
  const sweepResult = store.read(jobId).job.checkpoint.data.result;
  expect(sweepResult.reaped).toHaveLength(count);
  for (const id of sweepResult.reaped) expect(abandoned.isReaperTombstone(id, dir)).toBe(true);
  expect(listings).toBe(1 + count);
  return { beats, time, sweepResult, durationMs: Date.now() - started };
}
it('shared-probes-near-timeout-heartbeat', async () => {
  const { beats, time } = await runtimeSweep({ leaseMs: 44000, sessionMs: 9000 });
  expect(time - now).toBe(53000); expect(beats.some(t => Math.abs(t - now - 44000) < 500)).toBe(true);
  expect(Math.max(...beats.map((t,i) => t - (beats[i-1] ?? now)))).toBeLessThan(60000);
}, 120000);
it('cumulative-probes-preserve-progress', async () => {
  const { beats, time } = await runtimeSweep({ leaseMs: 44000, sessionMs: 9000, pidMs: 5000, count: 20000 });
  expect(time - now).toBeGreaterThan(60000); expect(beats.length).toBeGreaterThan(1);
}, 180000);
it('scan-and-write-yield', async () => {
  const { beats, time } = await runtimeSweep({ count: 40, localMs: 3000 });
  expect(time - now).toBeGreaterThan(60000);
  expect(Math.max(...beats.map((t,i) => t - (beats[i-1] ?? now)))).toBeLessThan(30000);
}, 120000);
it('held-prefix-does-not-starve', async () => {
  const { beats, sweepResult } = await runtimeSweep({ count: 2, pidMs: 5000 });
  expect(beats.some(t => Math.abs(t - now - 5000) < 500)).toBe(true); expect(sweepResult.kept['live-writer']).toEqual(Array.from({ length: 4 }, (_, i) => `review-pr-000-held-${i}`));
}, 180000);

it('large-store', async () => {
  const { durationMs } = await runtimeSweep({ count: 2000, young: 500, unrelated: 75200 });
  expect(durationMs).toBeLessThan(60000);
}, 120000);

it('stalled-job-stopped-by-reattach', async () => {
  // Launch, child claim, staleness and retry admission must share a clock. Advancing only
  // observation.now would put the freshly scheduled retry in the observation's past.
  const wallNow = vi.spyOn(Date, 'now').mockReturnValue(now);
  const { REVIEW_RUN_REAP_KIND } = await jobModule();
  const store = jobStore(); record();
  const r = enqueueJob({ store, codeSha: 'a'.repeat(40), kindDef: REVIEW_RUN_REAP_KIND, input: input(), now });
  let child, exited, ready;
  const entry = `import { runReviewRunReapJob } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-run-reap-job.mjs')).href)};
    await runReviewRunReapJob({host:'fixture-host',readStart:()=> 'fixture-start',now:()=>${now},heartbeatIntervalMs:10,
      reaperOptions:{now:${now},log:()=>{},probes:{reviewJobs:()=>[],pidIdentity:()=>({alive:false}),
        leases:()=>{process.send('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return '[]'},sessions:()=> '[]'}}});`;
  launchJob({ store, id: r.id, kindDef: REVIEW_RUN_REAP_KIND, env, evict: () => {},
    snapshot: { repoDir: root, materialize: into => {
      fs.mkdirSync(join(into, 'scripts/lib'), { recursive: true });
      fs.writeFileSync(join(into, REVIEW_RUN_REAP_KIND.entry), entry);
      fs.writeFileSync(join(into, 'package.json'), '{}');
      fs.writeFileSync(join(into, 'package-lock.json'), '{}');
    }, install: into => fs.mkdirSync(join(into, 'node_modules')) },
    spawnFn: ({ entryPath, cwd, env: childEnv }) => {
      child = fork(entryPath, [], { cwd, env: childEnv, stdio: ['ignore','ignore','ignore','ipc'] });
      exited = once(child, 'exit'); ready = once(child, 'message'); return child.pid;
    } });
  try {
    expect((await ready)[0]).toBe('ready');
    wallNow.mockReturnValue(now + 61000);
    let alive = true; const stop = vi.fn(async () => {
      expect(child.kill('SIGKILL')).toBe(true); await exited; alive = false; return { gone: true };
    });
    await reattachTick({ store, kinds: kindRegistry([REVIEW_RUN_REAP_KIND]), maxConcurrent: 1,
      observation: { now: Date.now(), slept: false, gapMs: 0 }, probe: () => alive ? 'alive' : 'dead', stop,
      reapGroup: () => ({ gone: true }), launch: () => { throw Error('retry should back off'); } });
    expect(stop).toHaveBeenCalledTimes(1);
    // Runtime retries are queued records with a future admission time, not a separate status.
    const retry = store.read(r.id).job;
    expect(retry.status).toBe('queued');
    expect(retry.attempts).toBe(1);
    expect(retry.handle).toBeNull();
    expect(Date.parse(retry.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(retry.timeline.at(-1)).toMatchObject({ event: 'requeued' });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { expect(child.kill('SIGKILL')).toBe(true); await exited; }
  }
}, 10000);
