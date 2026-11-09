/** Mark provably dead review-pr cursors with R755 sidecars; never rewrite records. Dry-run by default. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listRunIds, tryReadRun, runPath, isRunRecordTerminal, sharedRunsDir } from '../operations/run-store.mjs';
import { isRunAbandoned, markRunAbandoned, runRecordVersion as version } from './run-abandoned.mjs';
import { reviewJobsDir, readJobRecord } from '../operations/review-job-store.mjs';
import { parseJobHandle } from '../operations/job-record.mjs';
import { pidIdentity } from './pid-alive.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 3600000;
const active = e => e.status === 'pending' || e.status === 'in-flight';

function settings({ env, log, tool, thresholdMs }) {
  const p = readPlatformPreferences({ env, readFile: path => boundedText(path) });
  if (p.errors.length) throw Error(p.errors.join('; '));
  if (tool === undefined) {
    try { tool = JSON.parse(boundedText(join(ROOT, 'scripts/settings/review-run-reaper.json'))).reviewRunReaper; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const r = resolveCascade({ standard: { abandonAfterHours: 6 }, platform: p.prefs.reviewRunReaper, tool,
    envValues: { abandonAfterHours: env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS === undefined ? undefined : Number(env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS) },
    valid: { abandonAfterHours: v => typeof v === 'number' && Number.isFinite(v) && v > 0 } });
  log(formatCascadeSourcesLine('reviewRunReaper', r));
  if (thresholdMs !== undefined && (!Number.isFinite(thresholdMs) || thresholdMs <= 0)) throw Error('thresholdMs must be positive and finite');
  const ms = thresholdMs ?? r.value.abandonAfterHours * HOUR;
  const source = thresholdMs === undefined ? r.sources.abandonAfterHours : 'argument';
  log(`reviewRunReaper: threshold=${ms / HOUR}h (${source})`);
  return { thresholdMs: ms, thresholdSource: source };
}

// Do not use listReviewJobAgents: it suppresses read errors AND deletes dead jobs.
function readReviewJobs(env) {
  const dir = reviewJobsDir(env);
  return readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => {
    const r = readJobRecord(n.slice(0, -5), dir);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('unreadable review-job record');
    // Only a RECOGNIZED sidecar (review-<pr>.<kind>.json, e.g. *.spec-red-team.read.json) may lack a pid; any other
    // pid-less record could be a damaged job record and must hold everything (identity check below). Corrupt files threw above.
    if (!Object.hasOwn(r, 'pid') && /^review-\d+\.[A-Za-z0-9._-]+\.json$/.test(n)) return [];
    // A job whose pr/repo cannot be read might be the one bound to a candidate: unreadable identity = hold all.
    if (!identityOf({ pr: r.pr, repo: r.repo })) throw Error('review-job record with unreadable pr/repo identity');
    return [r];
  });
}

const nonEmpty = value => Array.isArray(value) || typeof value === 'string' ? value.length > 0
  : value && typeof value === 'object' ? Object.keys(value).length > 0 : value != null && value !== false;
const hasReadError = v => Array.isArray(v) ? v.some(hasReadError)
  : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => (k === 'readError' && x != null && x !== false)
    || ((k === 'error' || k === 'errors') && nonEmpty(x)) || hasReadError(x)) : false;
const identityOf = ({ pr, repo }) => (Number.isInteger(Number(pr)) && Number(pr) > 0 && /^\d+$/.test(String(pr)) && typeof repo === 'string' && repo.trim() ? `${repo}#${Number(pr)}` : null);
const TMP = /^(.+?)\.(\d+)\.[^/]+\.tmp$/;
/** A live writer (lock sidecar or temp sibling) keeps a record. Malformed lock, unreadable listing, unknown pid = ALIVE. */
function writerHeld(id, dir, identity) {
  const name = `${id}.json`;
  const alive = pid => !Number.isInteger(pid) || pid <= 0 || identity(pid)?.alive !== false;
  for (const f of readdirSync(dir)) {
    if (f === `${name}.lock` || f === `${id}.lock`) {
      const text = String(readFileSync(join(dir, f), 'utf8')).trim(); // read error propagates -> probe-unreadable
      if (!/^[1-9]\d*$/.test(text) || alive(Number(text))) return true; // malformed text (1e3, 0x3e8, +5) = alive
    }
    const m = TMP.exec(f);
    if (m && m[1] === name && alive(Number(m[2]))) return true;
  }
  return false;
}

/**
 * Injectable synchronous probes: reviewJobs() -> records, pidIdentity(pid, opts) -> {alive},
 * leases()/sessions() -> listing text. Exceptions, including bounded-exec failures, retain ALL candidates.
 * store overrides the named run-store helpers and stat(path); production never writes run records.
 * Unavailable evidence is retried on a later sweep after the operator restores the failing probe/store.
 */
export function reapDeadReviewRuns({ env = process.env, dir = (env.OPERATION_RUNS_DIR?.trim() ? resolve(env.OPERATION_RUNS_DIR.trim()) : sharedRunsDir(env)), now = Date.now(), apply = false,
  log = console.error, thresholdMs, probes = {}, store = {}, tool } = {}) {
  const result = { ...settings({ env, log, tool, thresholdMs }), scanned: 0, reaped: [], wouldReap: [], kept: {} };
  const io = { listRunIds, tryReadRun, runPath, isRunRecordTerminal, markRunAbandoned, stat: statSync, ...store };
  const keep = (reason, id) => { (result.kept[reason] ??= []).push(id); };
  const candidates = [];
  for (const id of io.listRunIds(dir)) {
    // The current shared ID grammar admits dots; ignore our metadata even before it is tightened.
    if (id.endsWith('.abandoned')) continue;
    let record, stat;
    try { record = io.tryReadRun(id, dir); if (!record) throw Error('missing run'); }
    catch { result.scanned++; keep('unreadable', id); continue; }
    if (record.op !== 'review-pr') continue;
    result.scanned++;
    if (io.isRunRecordTerminal(record)) { keep('terminal', id); continue; }
    if (isRunAbandoned(id, dir)) { keep('abandoned', id); continue; }
    if (record.resumeOf != null || record.resumedAt != null) { keep('resumed-run', id); continue; }
    if (!identityOf(record.input ?? {})) { keep('identity-unreadable', id); continue; }
    const pending = record.pending;
    if (pending && (Array.isArray(pending.options) || Object.hasOwn(pending, 'asks') || Object.hasOwn(pending, 'of'))) {
      keep('suspended-awaiting-answer', id); continue;
    }
    if (pending?.step === 'mandatoryReferrals' || record.effects.some(e => active(e) && e.step === 'mandatoryReferrals')) {
      keep('suspended-mandatory-referrals', id); continue;
    }
    try { stat = io.stat(io.runPath(id, dir)); if (!Number.isFinite(stat.mtimeMs)) throw Error('invalid mtime'); }
    catch { keep('unreadable', id); continue; }
    const ageMs = now - stat.mtimeMs;
    if (ageMs < result.thresholdMs) { keep('young', id); continue; }
    candidates.push({ id, record, snapshot: JSON.stringify(record), stat, ageMs });
  }
  if (!candidates.length) return result;

  // Stage every decision before any writes: a late shared-probe failure must never partly reap a sweep.
  const decisions = new Map();
  const identity = probes.pidIdentity ?? pidIdentity;
  const exec = probes.execFileSync ?? execFileSync;
  const listing = (cmd, args, arrayField, timeout = 10000) => {
    const text = exec(cmd, args, { cwd: ROOT, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(String(text));
    if (!parsed || typeof parsed !== 'object') throw Error('invalid liveness listing');
    // lane-pool wraps object rows in `lanes`; sessions use an array or the known `sessions`/`agents` wrappers.
    // An unknown object (including {}) is not evidence that no live holders exist.
    const fields = (arrayField ? [arrayField] : ['sessions', 'agents']).filter(key => Object.hasOwn(parsed, key));
    if (!Array.isArray(parsed) && (!fields.length || fields.some(key => !Array.isArray(parsed[key])))) {
      throw Error('invalid liveness listing shape');
    }
    if (!Array.isArray(parsed) && ['error', 'errors', 'readError'].some(key => Object.hasOwn(parsed, key) && nonEmpty(parsed[key]))) {
      throw Error('liveness listing reports an error');
    }
    const rows = Array.isArray(parsed) ? parsed : fields.flatMap(key => parsed[key]);
    // JSON.parse produces plain objects: reject null, nested arrays and primitives as unreadable rows.
    if (rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
      throw Error('invalid liveness listing row');
    }
    // laneStatus always identifies even missing/unleased lanes by number. Claude's background and
    // interactive rows carry id/sessionId/name; accept a handle as an identifying session token too.
    if (rows.some(row => arrayField === 'lanes'
      ? !Number.isInteger(row.lane) || row.lane <= 0
      : !['id', 'sessionId', 'name', 'handle'].some(key => typeof row[key] === 'string' && row[key].trim()))) {
      throw Error('liveness listing row lacks identity');
    }
    // lane-pool reports an unreadable or malformed lease marker as SUCCESS with `readError` and `lease: null`:
    // that lane's holder is unknown, so it may be this run's. Error fields anywhere = evidence unreadable = hold all.
    if (hasReadError(parsed)) throw Error('liveness listing contains an unreadable entry (readError/error/errors)');
    return JSON.stringify(parsed);
  };
  const textOf = value => {
    if (typeof value !== 'string') throw Error('unreadable liveness listing');
    return value;
  };
  try {
    const jobs = (probes.reviewJobs ?? (() => readReviewJobs(env)))();
    if (!Array.isArray(jobs) || jobs.some(j => !j || typeof j !== 'object' || !identityOf(j))) throw Error('unreadable review-job list or review-job pr/repo identity');
    for (const { id, record } of candidates) {
      if (writerHeld(id, dir, identity)) { decisions.set(id, 'live-writer'); continue; }
      const matching = jobs.filter(j => identityOf(j) === identityOf(record.input));
      if (matching.some(j => !Number.isInteger(j.pid) || j.pid <= 0 || identity(j.pid)?.alive !== false)) {
        decisions.set(id, 'live-review-job'); continue;
      }
      const handles = record.effects.filter(e => e.status === 'in-flight').map(e => e.handle).filter(h => h != null);
      if (record.job?.handle != null) handles.push(record.job.handle);
      if (handles.some(handle => {
        const h = parseJobHandle(handle);
        return !h || h.host !== hostname() || identity(h.pid, { expectStart: h.procStart })?.alive !== false;
      })) decisions.set(id, 'live-handle');
    }
    const remaining = candidates.filter(c => !decisions.has(c.id));
    if (remaining.length) {
      const leases = textOf((probes.leases ?? (() => listing(process.execPath, ['scripts/lane-pool.mjs', 'status', '--json', '--leased-only', '--max-age-ms=0'], 'lanes', 120000)))());
      for (const { id } of remaining) if (leases.includes(id)) decisions.set(id, 'live-lease');
      const sessionCandidates = remaining.filter(c => !decisions.has(c.id));
      if (sessionCandidates.length) {
        const sessions = textOf((probes.sessions ?? (() => listing('claude', ['agents', '--json'])))());
        for (const { id, record } of sessionCandidates) {
          const handles = record.effects.filter(e => e.status === 'in-flight').map(e => e.handle).filter(h => typeof h === 'string' && h);
          if (record.job?.handle) handles.push(record.job.handle);
          if ([id, ...handles].some(token => sessions.includes(token))) decisions.set(id, 'live-session');
        }
      }
    }
  } catch (e) {
    log(`reap-dead-review-runs: probe-unreadable; retaining ${candidates.length} candidate(s); restore probe access and retry (${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ')})`);
    for (const { id } of candidates) keep('probe-unreadable', id);
    return result;
  }

  for (const c of candidates) {
    if (decisions.has(c.id)) { keep(decisions.get(c.id), c.id); continue; }
    let changed;
    try {
      if (writerHeld(c.id, dir, identity)) { keep('live-writer', c.id); continue; }
      const currentStat = io.stat(io.runPath(c.id, dir));
      const current = io.tryReadRun(c.id, dir);
      // A second stat also catches an atomic writer landing during the final read.
      changed = !current || JSON.stringify(current) !== c.snapshot || version(currentStat) !== version(c.stat)
        || version(io.stat(io.runPath(c.id, dir))) !== version(c.stat)
        || writerHeld(c.id, dir, identity);
    } catch { changed = true; }
    if (changed) { keep('changed-during-sweep', c.id); continue; }
    if (apply !== true) { result.wouldReap.push(c.id); continue; }
    const marked = io.markRunAbandoned({ id: c.id, dir, now, by: 'reap-dead-review-runs',
      reason: `dead: no live pid/handle/lease/session; unchanged for >= ${result.thresholdMs / HOUR}h`,
      // Creation excludes other tombstones, not run writers. Bind to the original version so a writer
      // landing after the final check still wins, even if its mtime precedes sidecar creation.
      probes: { recordVersion: version(c.stat), ageMs: c.ageMs, thresholdMs: result.thresholdMs, thresholdSource: result.thresholdSource,
        reviewJobs: 'dead', handles: 'dead', writers: 'dead', leases: 'absent', sessions: 'absent' } });
    if (marked.written) result.reaped.push(c.id);
    else if (marked.staleUnreplaceable) { // stale sidecar could not be replaced: retry next sweep, keep sweeping others
      log(`reap-dead-review-runs: stale tombstone for ${c.id} could not be replaced (${String(marked.staleUnreplaceable).replace(/[\x00-\x1f\x7f]/g, ' ')}); remove or fix it and retry`);
      keep('stale-tombstone-unreplaceable', c.id);
    } else keep('already-abandoned', c.id);
  }

  return result;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const flags = new Set(process.argv.slice(2));
  const result = reapDeadReviewRuns({ apply: flags.has('--apply') && !flags.has('--dry-run') });
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`reap-dead-review-runs: ${result.scanned} scanned · ${result.reaped.length} reaped · ${result.wouldReap.length} wouldReap` +
    Object.entries(result.kept).map(([reason, ids]) => ` · ${reason}=${ids.length}`).join(''));
}
