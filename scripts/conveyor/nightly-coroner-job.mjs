#!/usr/bin/env node
/** Durable, deterministic nightly extraction. No agent session or judgment is launched. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HEALTH_NIGHTLY_CORONER_KIND, HEALTH_WATCH_JOB_KINDS } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { createJobStore, createTickClock, enqueueJob, reattachTick, runJob } from '../lib/daemon-jobs-runtime.mjs';
import { createWarmGate, evictToTrash } from './health-watch-job.mjs';
import { daemonJobsDir } from '../operations/run-store.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { feedPath, appendLines } from '../operations/needs-you-feed.mjs';
import { prSweepTickAllowed } from './pr-sweep-job.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../..');
const clocks = new Map();
const exec = promisify(execFile);
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
    standard: { enabled: true, at: '22:17' }, platform: platform.prefs.coroner?.nightly ?? {}, envValues,
    valid: { enabled: (v) => typeof v === 'boolean', at: validTime }, env,
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

export async function runNightlyCoronerJob({ now, config, settings, dir, env = process.env, sourceRoot = ROOT,
  store = createJobStore(daemonJobsDir('nightly-coroner', env)), enqueue = enqueueJob, reattach = reattachTick,
  evict = evictToTrash, codeSha, snapshot, log = console.error, warmGate = {} } = {}) {
  mkdirSync(store.dir, { recursive: true });
  const { records, corrupt = [] } = store.list();
  if (corrupt.length) throw new Error(`nightly-coroner: corrupt job records: ${corrupt.join(', ')}`);
  const mine = records.filter((r) => r.job.kind === HEALTH_NIGHTLY_CORONER_KIND.kind);
  const night = coronerNightDue(now, config);
  const id = night && `nightly-coroner-${night}`;
  let enqueued = null;
  if (id && !mine.some((r) => r.id === id) && !mine.some((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status))) {
    // Stable ID + store.create's exclusive lock closes the enqueue/state-save restart window.
    const record = enqueue({ store, id, kindDef: HEALTH_NIGHTLY_CORONER_KIND, now,
      codeSha: codeSha ?? readGit(['-C', sourceRoot, 'rev-parse', 'HEAD']).trim(),
      input: { night, until: new Date(now).toISOString(), dir, settings, sourceRoot } });
    enqueued = record.id;
  }
  if (!clocks.has(store.dir)) clocks.set(store.dir, createTickClock());
  const gate = createWarmGate({ jobsDir: store.dir, sourceRoot, ...warmGate });
  await reattach({ store, kinds: HEALTH_WATCH_JOB_KINDS, maxConcurrent: 1, clock: clocks.get(store.dir),
    snapshot: snapshot ?? { repoDir: sourceRoot }, log, launch: gate.launch });
  const current = store.list().records;
  try { evict({ jobsDir: store.dir, referenced: current.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys ?? []) }); }
  catch (e) { log(`nightly-coroner eviction: ${e.message}`); }
  // Retain the small daily records as the durable once-per-night ledger, independent of health state.json.
  return { enqueued, failures: current.filter((r) => r.job.status === 'failed').map((r) => `${r.id}: ${r.job.error ?? 'failed'}`) };
}
function readOptionalJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path);
}
const command = async (args, cwd) => (await exec(process.execPath, args, {
  cwd, encoding: 'utf8', timeout: 30 * 60000, maxBuffer: 32 * 1024 * 1024,
})).stdout;

export async function extractNightlyCoroner({ night, until, dir, settings, sourceRoot = ROOT }, {
  root = ROOT, home = handoffHome(), statusFeed = feedPath(), run = command,
  acquire = async () => JSON.parse(await run([join(root, 'scripts/lane-pool.mjs'), 'acquire', '--purpose=nightly-coroner', `--repo=${sourceRoot}`, '--json'], sourceRoot)),
  release = async (lane) => run([join(root, 'scripts/lane-pool.mjs'), 'release', `--lane=${lane.lane}`, `--session=${lane.holder}`, `--repo=${sourceRoot}`], sourceRoot),
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
    const lane = await acquire();
    if (!lane?.path || !lane?.holder || !Number.isInteger(lane.lane)) throw new Error('nightly-coroner: no lane acquired');
    try {
      // The extractor imports coroner-rounds.mjs itself; --no-save leaves cursor publication to this job.
      const args = ['--since', since, '--until', until, '--json'];
      // Node resolves main-module symlinks; pass the same physical path to the CLI entry guard.
      const metrics = JSON.parse(await run([realpathSync(join(lane.path, 'scripts/operations/coroner-extract.mjs')), ...args, '--no-save'], lane.path));
      let falseFindings = null;
      const optional = join(lane.path, 'scripts/operations/coroner-false-findings.mjs');
      if (existsSync(optional)) falseFindings = JSON.parse(await run([realpathSync(optional), '--since', since, '--json'], lane.path));
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
if (isEntry(process.argv[1])) {
  runJob({ steps: [{ name: 'nightly-coroner', run: ({ input }) => extractNightlyCoroner(input) }] })
    .then((r) => { process.exitCode = r.outcome === 'succeeded' ? 0 : 1; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
