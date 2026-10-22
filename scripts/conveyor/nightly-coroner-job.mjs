#!/usr/bin/env node
/** Durable, deterministic nightly extraction. No agent session or judgment is launched. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HEALTH_NIGHTLY_CORONER_KIND, HEALTH_WATCH_JOB_KINDS } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { createJobStore, createTickClock, enqueueJob, reattachTick, runJob } from '../lib/daemon-jobs-runtime.mjs';
import { createWarmGate, evictToTrash } from './health-watch-job.mjs';
import { daemonJobsDir } from '../operations/run-store.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { feedPath, appendLines, sanitizeForFeed } from '../operations/needs-you-feed.mjs';
import { scrubText } from './health-watch-core.mjs';
import { prSweepTickAllowed } from './pr-sweep-job.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../..');
const clocks = new Map();
export const NIGHTLY_DEFAULTS = Object.freeze({ enabled: true, at: '22:17', laneWaitMs: 600000, attempts: 1, retryBackoffMin: 10, deadlineEt: '03:30', alertAfterProbeFailures: 3, runTimeoutMin: 30 });
const positiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const validTime = (v) => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
export function resolveNightlyCoronerSettings({ config = {}, env = process.env, read = readFileSync, log = console.error } = {}) {
  let tool = {}; const errors = [];
  try { tool = JSON.parse(read(join(ROOT, 'scripts/settings/coroner.json'), 'utf8')).coroner?.nightly ?? {}; }
  catch (e) { if (e.code !== 'ENOENT') errors.push(e.message); }
  const platform = readPlatformPreferences({ env, readFile: read });
  const envValues = {};
  if (env.WE_CORONER_NIGHTLY_AT !== undefined) envValues.at = env.WE_CORONER_NIGHTLY_AT;
  const enabled = env.WE_CORONER_NIGHTLY_ENABLED;
  if (enabled !== undefined) envValues.enabled = ['1', 'true'].includes(enabled) ? true : ['0', 'false'].includes(enabled) ? false : enabled;
  const out = cascadePolicy('coroner.nightly', { ...tool, ...config.coroner?.nightly }, {
    standard: NIGHTLY_DEFAULTS, platform: platform.prefs.coroner?.nightly ?? {}, envValues,
    valid: { enabled: (v) => typeof v === 'boolean', at: validTime, laneWaitMs: positiveInt, attempts: v => positiveInt(v) && v <= NIGHTLY_DEFAULTS.attempts, retryBackoffMin: positiveInt, deadlineEt: validTime, alertAfterProbeFailures: positiveInt, runTimeoutMin: positiveInt }, env,
  });
  log(formatCascadeSourcesLine('coroner.nightly', out));
  return { ...out, errors: [...errors, ...platform.errors, ...out.invalid] };
}
export const nightlyCoronerTickAllowed = prSweepTickAllowed;

/** Most recent due ET night, including yesterday when a daemon resumes before tonight's deadline.
 * Calendar arithmetic uses UTC only to subtract a DATE; schedule comparison uses New York wall time (DST safe).
 */
export function coronerNightDue(now, { at = '22:17', enabled = true } = {}, lastNight = null) {
  if (!enabled) return null;
  if (!validTime(at)) throw new Error('invalid coroner.nightly.at');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  let night = `${p.year}-${p.month}-${p.day}`;
  // utc-day-slice-ok: subtracting one calendar date anchored at UTC noon, after deriving the ET date above.
  if (`${p.hour}:${p.minute}` < at) night = new Date(Date.parse(`${night}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return lastNight && lastNight >= night ? null : night;
}

/** Next calendar morning in ET, resolved using the offset at the target wall time (DST safe). */
export function coronerDeadline(night, deadlineEt = NIGHTLY_DEFAULTS.deadlineEt) {
  if (!validTime(deadlineEt)) throw new Error('invalid coroner.nightly.deadlineEt');
  const next = new Date(Date.parse(`${night}T12:00:00Z`) + 86400000);
  const target = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), ...deadlineEt.split(':').map(Number));
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const wallAt = (instant) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  };
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const wall = wallAt(instant);
    if (wall === target) return instant;
    instant += target - wall;
  }
  // A nonexistent spring-forward wall time expires at the first valid time after the gap.
  // Offset iteration straddles the one-hour New York gap; find its transition boundary in minutes.
  let low = instant, high = instant + 3600000;
  while (high - low > 60000) {
    const mid = low + Math.floor((high - low) / 120000) * 60000;
    if (wallAt(mid) >= target) high = mid;
    else low = mid;
  }
  return high;
}

export function publishCoronerFailure({ id, error, attempts, maxAttempts, reason }, statusFeed = feedPath()) {
  const text = (value, max) => sanitizeForFeed(scrubText(value), max);
  id = text(id, 128);
  const marker = `NEEDS-YOU nightly-coroner ${id} failed`;
  let feed = '';
  try { feed = readFileSync(statusFeed, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!feed.split('\n').some((line) => line.startsWith(`${marker} `))) {
    appendLines(statusFeed, [`${marker} — ${JSON.stringify({ at: new Date().toISOString(), kind: 'coroner-failed', job: id,
      error: text(error, 512), attempts: typeof attempts === 'number' ? attempts : text(attempts, 40),
      maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : text(maxAttempts, 40), reason: text(reason, 100) })}`]);
  }
}

export async function runNightlyCoronerJob({ now, config, settings, dir, env = process.env, sourceRoot = ROOT,
  store = createJobStore(daemonJobsDir('nightly-coroner', env)), enqueue = enqueueJob, reattach = reattachTick,
  evict = evictToTrash, codeSha, snapshot, log = console.error, warmGate = {}, statusFeed = feedPath(),
  sweepLanes = (session) => sweepCoronerLeases(ROOT, sourceRoot, session) } = {}) {
  config = { ...NIGHTLY_DEFAULTS, ...config };
  if (!positiveInt(config.attempts) || config.attempts > NIGHTLY_DEFAULTS.attempts) config.attempts = NIGHTLY_DEFAULTS.attempts;
  mkdirSync(store.dir, { recursive: true });
  const { records, corrupt = [] } = store.list();
  if (corrupt.length) throw new Error(`nightly-coroner: corrupt job records: ${corrupt.join(', ')}`);
  const mine = records.filter((r) => r.job.kind === HEALTH_NIGHTLY_CORONER_KIND.kind);
  // Persisted jobs from an earlier configuration must not retain a larger retry allowance.
  for (const record of mine) {
    if (record.job.maxAttempts !== NIGHTLY_DEFAULTS.attempts) store.update(record.id, current => ({
      ...current, job: { ...current.job, maxAttempts: NIGHTLY_DEFAULTS.attempts },
    }));
  }
  const night = coronerNightDue(now, config);
  const id = night && `nightly-coroner-${night}`;
  let enqueued = null;
  if (id && !mine.some((r) => r.id === id) && !mine.some((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status))) {
    // Stable ID + store.create's exclusive lock closes the enqueue/state-save restart window.
    const record = enqueue({ store, id, kindDef: { ...HEALTH_NIGHTLY_CORONER_KIND, maxAttempts: config.attempts }, now,
      codeSha: codeSha ?? readGit(['-C', sourceRoot, 'rev-parse', 'HEAD']).trim(),
      input: { night, nightly: config, until: new Date(now).toISOString(), dir, settings, sourceRoot, laneSession: coronerLaneSession(store.dir) } });
    enqueued = record.id;
  }
  if (!clocks.has(store.dir)) clocks.set(store.dir, createTickClock());
  const gate = createWarmGate({ jobsDir: store.dir, sourceRoot, ...warmGate });
  await reattach({ store, kinds: HEALTH_WATCH_JOB_KINDS, maxConcurrent: 1, clock: clocks.get(store.dir),
    deadlineAt: (r) => coronerDeadline(r.input.night, r.input.nightly?.deadlineEt ?? config.deadlineEt),
    backoffBaseMs: config.retryBackoffMin * 60000,
    snapshot: snapshot ?? { repoDir: sourceRoot }, log, launch: gate.launch });
  // A failed job (a live child is stopped first; a dead one's leftover group is killed) may still hold its lease —
  // its child SIGKILLed or crashed before its own release. With no coroner attempt queued or running, that lease
  // is an orphan. The sweep stays owed until one succeeds and is stamped on the record, so a sweep that fails or
  // a tick killed before it retries on the next tick. A requeued attempt sweeps for itself before it acquires.
  // Each record is swept by the session its own attempt leased under; a record with none (enqueued before
  // sessions existed) cannot be swept and is never stamped as if it had been.
  const coroners = store.list().records.filter((r) => r.job.kind === HEALTH_NIGHTLY_CORONER_KIND.kind);
  const owed = coroners.filter((r) => r.job.status === 'failed' && typeof r.input?.laneSession === 'string' && r.input.laneSession && !r.laneSweptAt);
  if (owed.length && !coroners.some((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status))) {
    for (const session of new Set(owed.map((r) => r.input.laneSession))) {
      try {
        await sweepLanes(session);
        const at = new Date().toISOString();
        for (const r of owed.filter((x) => x.input.laneSession === session)) {
          store.update(r.id, (f) => (f.job.status === 'failed' && !f.laneSweptAt ? { ...f, laneSweptAt: at } : null));
        }
      } catch (e) { log(`nightly-coroner lane sweep (${session}): ${e.message}`); }
    }
  }
  const current = store.list().records;
  try { evict({ jobsDir: store.dir, referenced: current.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys ?? []) }); }
  catch (e) { log(`nightly-coroner eviction: ${e.message}`); }
  // Every failed record stays visible until it succeeds, including earlier nights and other kinds.
  // Only nightly records use the ET deadline. Feed publication is stamped once per record.
  const failed = current.filter((r) => r.job.status === 'failed' ||
    (r.job.kind === HEALTH_NIGHTLY_CORONER_KIND.kind && r.job.status !== 'succeeded' &&
      now >= coronerDeadline(r.input.night, r.input.nightly?.deadlineEt ?? config.deadlineEt)))
    .map((r) => ({ record: r, failure: { id: r.id, error: r.job.error ?? 'not completed', attempts: r.job.attempts, maxAttempts: r.job.maxAttempts,
      reason: r.job.status === 'failed' ? 'attempts exhausted or launch failed' : 'ET deadline missed' } }));
  for (const { record, failure } of failed.filter(({ record: r }) => !r.failurePublishedAt)) {
    publishCoronerFailure(failure, statusFeed);
    // Published first, stamped second: a crash between the two is deduped by the feed marker. A deadline-missed record
    // is stamped too (its later failure would dedup to the same marker), so no record re-reads the feed every tick.
    try { store.update(record.id, (f) => (f.failurePublishedAt ? null : { ...f, failurePublishedAt: new Date().toISOString() })); }
    catch (e) { log(`nightly-coroner failure stamp (${record.id}): ${e.message}`); }
  }
  const failures = failed.map(({ failure }) => failure);
  // Retain the small daily records as the durable once-per-night ledger, independent of health state.json.
  return { enqueued, alerts: failures, failures: failures.map((r) => `${r.id}: ${r.error}; ${r.attempts}/${r.maxAttempts} attempts; ${r.reason}`) };
}
function readOptionalJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path);
}
// A stop's budget, inside the kind's stopGraceMs (45s): the aborted child gets CHILD_STOP_GRACE_MS to exit, then
// the lane release (or orphan sweep) gets RELEASE_TIMEOUT_MS, so neither is cut off by the daemon's SIGKILL.
export const CHILD_STOP_GRACE_MS = 10_000;
export const RELEASE_TIMEOUT_MS = 30_000;
// Every coroner lease carries its jobs store's session, so a lease whose holder slug was never learned (an
// acquire killed mid-way, a child SIGKILLed) can still be released. One coroner job per store runs at a time,
// so such a lease seen when no attempt is live is an orphan; another store (a soak, a second checkout) never
// shares the session, so its sweep never touches this one's lane.
export const CORONER_LANE_SESSION = 'nightly-coroner';
export const coronerLaneSession = (storeDir) => `${CORONER_LANE_SESSION}-${createHash('sha256').update(resolve(storeDir)).digest('hex').slice(0, 12)}`;
const command = (args, cwd, { signal, timeout = 30 * 60000 } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  let exited = false;
  const child = execFile(process.execPath, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 }, (e, stdout) => {
    signal?.removeEventListener('abort', onAbort);
    if (e && child.pid === undefined) { reject(e); return; } // never spawned: no exit will come
    if (!signal?.aborted) { if (e) reject(e); else resolve(stdout); }
  });
  child.once('exit', () => { exited = true; });
  // On a stop, reject only once the child has EXITED, so a lane release never races a live extractor.
  function onAbort() {
    if (exited || child.pid === undefined) { reject(signal.reason); return; }
    const hard = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_GRACE_MS);
    child.once('exit', () => { clearTimeout(hard); reject(signal.reason); });
    child.kill('SIGTERM');
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});
const sweepCoronerLeases = (root, sourceRoot, session, run = command) => run([join(root, 'scripts/lane-pool.mjs'), 'release', '--all-pools',
  `--session=${session}`, `--repo=${sourceRoot}`], sourceRoot, { timeout: RELEASE_TIMEOUT_MS });

/** The exact argv both extractor CLIs receive; each declares --since, --until and --json (contract-tested). */
export const coronerExtractorArgs = (since, until) => ['--since', since, '--until', until, '--json'];
/** `signal` aborts the acquire and extractor subprocesses (a stop); the lane release is never given it. */
export async function extractNightlyCoroner({ night, until, dir, settings, nightly = NIGHTLY_DEFAULTS, sourceRoot = ROOT, laneSession = CORONER_LANE_SESSION }, {
  root = ROOT, home = handoffHome(), statusFeed = feedPath(), run = command, signal,
  acquire = async () => JSON.parse(await run([join(root, 'scripts/lane-pool.mjs'), 'acquire', '--purpose=nightly-coroner', `--session=${laneSession}`, `--wait-ms=${positiveInt(nightly.laneWaitMs) ? nightly.laneWaitMs : NIGHTLY_DEFAULTS.laneWaitMs}`, `--repo=${sourceRoot}`, '--json'], sourceRoot, { signal })),
  release = async (lane) => run([join(root, 'scripts/lane-pool.mjs'), 'release', `--lane=${lane.lane}`, `--session=${lane.holder}`, `--repo=${sourceRoot}`], sourceRoot,
    signal?.aborted ? { timeout: RELEASE_TIMEOUT_MS } : {}),
  sweep = async () => sweepCoronerLeases(root, sourceRoot, laneSession, run),
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) throw new Error('invalid coroner night');
  const cursorPath = join(dir, 'nightly-coroner-cursor.json');
  const reportName = `coroner-${night}.md`, reportPath = join(home, reportName);
  const cursor = readOptionalJson(cursorPath);
  const since = cursor?.lastEnd ?? new Date(Date.parse(until) - 86400000).toISOString();
  if (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.parse(until)) throw new Error('invalid nightly coroner cursor');
  // Completed report is also the recovery receipt: never repeat extraction after publication.
  let window;
  if (existsSync(reportPath)) {
    const receipt = readFileSync(reportPath, 'utf8').match(/^<!-- nightly-coroner (.+) -->$/m);
    if (!receipt) throw new Error('nightly coroner report lacks recovery receipt');
    window = JSON.parse(receipt[1]);
  } else {
    signal?.throwIfAborted();
    await sweep().catch(() => {}); // a lease left by an earlier attempt that was killed outright; acquire reports a broken pool
    signal?.throwIfAborted(); // stopped during that sweep: nothing is held, so skip the post-acquire sweep too
    let lane;
    try {
      lane = await acquire();
      if (!lane?.path || !lane?.holder || !Number.isInteger(lane.lane)) throw new Error('nightly-coroner: no lane acquired');
    } catch (e) {
      // A killed or failed acquire may already have claimed a lane it never reported: release it by session.
      await sweep().catch(() => {});
      throw e;
    }
    try {
      signal?.throwIfAborted();
      // The extractor imports coroner-rounds.mjs itself; --no-save leaves cursor publication to this job.
      const args = coronerExtractorArgs(since, until);
      // Each extractor run is capped by coroner.nightly.runTimeoutMin (cascade; sources logged at resolve) so a
      // runaway read cannot hold the lane or load the host until the ET deadline stop.
      const timeout = (positiveInt(nightly.runTimeoutMin) ? nightly.runTimeoutMin : NIGHTLY_DEFAULTS.runTimeoutMin) * 60000;
      // Node resolves main-module symlinks; pass the same physical path to the CLI entry guard.
      const metrics = JSON.parse(await run([realpathSync(join(lane.path, 'scripts/operations/coroner-extract.mjs')), ...args, '--no-save'], lane.path, { signal, timeout }));
      let falseFindings = null;
      const optional = join(lane.path, 'scripts/operations/coroner-false-findings.mjs');
      signal?.throwIfAborted();
      if (existsSync(optional)) falseFindings = JSON.parse(await run([realpathSync(optional), ...args], lane.path, { signal, timeout }));
      signal?.throwIfAborted();
      window = { since, until };
      const rate = (value) => value ? `${value.count}/${value.total} (${value.pct}%)` : 'unavailable';
      const fence = '```';
      const report = [`# Nightly coroner — ${night}`, '', `Window: ${since} → ${until}`, '',
        'Deterministic extraction is ready. Operator judgment is pending; no agent session was launched.', '',
        `Settings: ${JSON.stringify(settings?.value ?? {})}; sources: ${JSON.stringify(settings?.sources ?? {})}`, '',
        '## Summary', '',
        `- Sessions observed: ${metrics.sessions?.count ?? 'unavailable'}`,
        `- Gate failures: ${rate(metrics.errorRates?.gateRuns)}`,
        `- CI failures: ${rate(metrics.errorRates?.ci)}`,
        `- Code change-request rounds: ${metrics.changeRequests?.byKind?.code?.rounds ?? 'unavailable'}`,
        `- Source warnings: ${metrics.sources?.warnings?.length ?? 0}`, '',
        '## Extraction (includes change-request rounds when available)', '', '```json', JSON.stringify(metrics, null, 2), '```', '',
        '## False findings', '', falseFindings === null ? 'Extractor not present.' : `${fence}json\n${JSON.stringify(falseFindings, null, 2)}\n${fence}`, '',
        `<!-- nightly-coroner ${JSON.stringify(window)} -->`, ''].join('\n');
      atomicWrite(reportPath, report);
    } finally { await release(lane); }
  }
  // Never roll the cursor backwards when replaying a completed report.
  if (!cursor?.lastEnd || Date.parse(cursor.lastEnd) < Date.parse(window.until)) atomicWrite(cursorPath, `${JSON.stringify({ lastNight: night, lastEnd: window.until })}\n`);
  const marker = `NEEDS-YOU nightly-coroner ${reportName} ready`;
  let feed = '';
  try { feed = readFileSync(statusFeed, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!feed.split('\n').some((line) => line.startsWith(`${marker} `))) {
    appendLines(statusFeed, [`${marker} — operator judgment pending ${JSON.stringify({ at: window.until, kind: 'coroner-ready', report: reportName, reason: 'Coroner report ready for judgment' })}`]);
  }
  return { night, window, report: reportName };
}
function isEntry(path) {
  if (!path) return false;
  try { return realpathSync(path) === realpathSync(SELF); } catch { return false; }
}
/**
 * The job child. A stop (deadline or stale heartbeat) sends SIGTERM: abort the running subprocess, let the
 * extraction's `finally` release the lane, then exit — inside the kind's `stopGraceMs`, before any SIGKILL.
 */
export async function runNightlyCoronerEntry({ io = {}, signals = process, env = process.env } = {}) {
  const controller = new AbortController();
  const onStop = (sig) => controller.abort(new Error(`nightly-coroner stopped by ${sig}`));
  for (const sig of ['SIGTERM', 'SIGINT']) signals.on(sig, onStop);
  try {
    return await runJob({ env, steps: [{ name: 'nightly-coroner', run: ({ input }) => extractNightlyCoroner(input, { ...io, signal: controller.signal }) }] });
  } finally {
    for (const sig of ['SIGTERM', 'SIGINT']) signals.off(sig, onStop);
  }
}
if (isEntry(process.argv[1])) {
  runNightlyCoronerEntry()
    .then((r) => { process.exitCode = r.outcome === 'succeeded' ? 0 : 1; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
