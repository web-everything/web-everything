/** Terminalize provably dead review-pr cursors; never adjudicate their verdicts. Dry-run by default. */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listRunIds, tryReadRun, writeRun, runPath, isRunRecordTerminal, sharedRunsDir } from '../operations/run-store.mjs';
import { reviewJobsDir, readJobRecord } from '../operations/review-job-store.mjs';
import { parseJobHandle } from '../operations/job-record.mjs';
import { pidIdentity } from './pid-alive.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 3600000;
const active = e => e.status === 'pending' || e.status === 'in-flight';
const version = s => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);

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

const hasReadError = v => Array.isArray(v) ? v.some(hasReadError)
  : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => (k === 'readError' && x != null && x !== false) || hasReadError(x)) : false;
const identityOf = ({ pr, repo }) => (Number.isInteger(Number(pr)) && Number(pr) > 0 && /^\d+$/.test(String(pr)) && typeof repo === 'string' && repo.trim() ? `${repo}#${Number(pr)}` : null);
const TMP = /^(.+?)\.(\d+)\.[^/]+\.tmp$/;
/** A live writer (lock sidecar or temp sibling) keeps a record. Malformed lock, unreadable listing, unknown pid = ALIVE. */
function writerHeld(id, dir, identity, skipLock = false) {
  const name = `${id}.json`;
  const alive = pid => !Number.isInteger(pid) || pid <= 0 || identity(pid)?.alive !== false;
  for (const f of readdirSync(dir)) {
    if (f === `${name}.lock` || f === `${id}.lock`) {
      if (skipLock && f === `${name}.lock`) continue; // our own sidecar; the alternate `<id>.lock` is still checked
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
 * store overrides the named run-store helpers and stat(path); production reads/writes always use run-store.
 * Unavailable evidence is retried on a later sweep after the operator restores the failing probe/store.
 */
export function reapDeadReviewRuns({ env = process.env, dir = (env.OPERATION_RUNS_DIR?.trim() ? resolve(env.OPERATION_RUNS_DIR.trim()) : sharedRunsDir(env)), now = Date.now(), apply = false,
  log = console.error, thresholdMs, probes = {}, store = {}, tool } = {}) {
  const result = { ...settings({ env, log, tool, thresholdMs }), scanned: 0, reaped: [], wouldReap: [], kept: {} };
  const io = { listRunIds, tryReadRun, writeRun, runPath, isRunRecordTerminal, stat: statSync, ...store };
  const keep = (reason, id) => { (result.kept[reason] ??= []).push(id); };
  const candidates = [];
  for (const id of io.listRunIds(dir)) {
    let record, stat;
    try { record = io.tryReadRun(id, dir); if (!record) throw Error('missing run'); }
    catch { result.scanned++; keep('unreadable', id); continue; }
    if (record.op !== 'review-pr') continue;
    result.scanned++;
    if (io.isRunRecordTerminal(record)) { keep('terminal', id); continue; }
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
  const listing = (cmd, args, timeout = 10000) => {
    const text = exec(cmd, args, { cwd: ROOT, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(String(text));
    if (!parsed || typeof parsed !== 'object') throw Error('invalid liveness listing');
    // lane-pool reports an unreadable or malformed lease marker as SUCCESS with `readError` and `lease: null`:
    // that lane's holder is unknown, so it may be this run's. Any readError anywhere = evidence unreadable = hold all.
    if (hasReadError(parsed)) throw Error('liveness listing contains an unreadable lease (readError)');
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
      const leases = textOf((probes.leases ?? (() => listing(process.execPath, ['scripts/lane-pool.mjs', 'status', '--json', '--leased-only', '--max-age-ms=0'], 120000)))());
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
    const next = { ...c.record, pending: null,
      effects: c.record.effects.map(e => active(e) ? { ...e, status: 'failed', abandonedBy: 'reap-dead-review-runs' } : e),
      abandoned: { status: 'abandoned', reason: `dead: no live pid/handle/lease/session; unchanged for >= ${result.thresholdMs / HOUR}h`,
        at: new Date(now).toISOString(), ageMs: c.ageMs, thresholdMs: result.thresholdMs, thresholdSource: result.thresholdSource } };
    if (!io.isRunRecordTerminal(next)) throw Error(`refusing non-terminal abandonment: ${c.id}`);
    if (!apply) { result.wouldReap.push(c.id); continue; }
    // Lock sidecar (the repo's writer-exclusion convention) held from the final re-check through the write, so a
    // cooperating writer or a second reaper sees us; other writers' atomic renames can still race, but only inside
    // this few-statement window after the record sat idle for the whole threshold.
    const lockPath = join(dir, `${c.id}.json.lock`);
    let fd;
    const take = () => { fd = openSync(lockPath, 'wx'); writeSync(fd, String(process.pid)); };
    try {
      try { take(); } catch (e) {
        // A lock whose well-formed pid is PROVEN dead is a crashed writer's leftover: clear it once and retry.
        const text = e.code === 'EEXIST' ? String(readFileSync(lockPath, 'utf8')).trim() : '';
        if (!/^[1-9]\d*$/.test(text) || identity(Number(text))?.alive !== false) throw e;
        rmSync(lockPath, { force: true }); take();
      }
    }
    catch { if (fd !== undefined) { try { closeSync(fd); rmSync(lockPath, { force: true }); } catch { /* keep */ } } keep('live-writer', c.id); continue; }
    try {
      let changed = false;
      try {
        const currentStat = io.stat(io.runPath(c.id, dir)); // stat BEFORE the final read so a late update is seen by it
        const current = io.tryReadRun(c.id, dir);
        changed = !current || JSON.stringify(current) !== c.snapshot || version(currentStat) !== version(c.stat)
          || writerHeld(c.id, dir, identity, true);
      } catch { changed = true; }
      if (changed) { keep('changed-during-sweep', c.id); continue; }
      // Quarantine-rename, then verify: a read-modify-write writer (which honors no lock) either already wrote
      // (content differs: restore) or will find the file gone and fail loudly / recreate it (then we discard our
      // older abandonment). No path silently overwrites newer progress or a verdict.
      const path = io.runPath(c.id, dir);
      const quarantine = join(dir, `.reaping-${c.id}.${randomUUID()}.json`);
      try { renameSync(path, quarantine); } catch { keep('changed-during-sweep', c.id); continue; }
      let outcome = 'changed-during-sweep';
      try {
        const same = JSON.stringify(JSON.parse(readFileSync(quarantine, 'utf8'))) === c.snapshot && !writerHeld(c.id, dir, identity, true);
        if (same && !existsSync(path)) { io.writeRun(next, dir); outcome = 'reaped'; }
      } finally {
        if (outcome !== 'reaped' && !existsSync(path)) { try { renameSync(quarantine, path); } catch { /* quarantine kept for the operator */ } }
        else rmSync(quarantine, { force: true });
      }
      if (outcome === 'reaped') result.reaped.push(c.id); else keep(outcome, c.id);
    } finally { try { closeSync(fd); } catch { /* ignore */ } rmSync(lockPath, { force: true }); }
  }
  return result;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const flags = new Set(process.argv.slice(2));
  const result = reapDeadReviewRuns({ apply: flags.has('--apply') });
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`reap-dead-review-runs: ${result.scanned} scanned · ${result.reaped.length} reaped · ${result.wouldReap.length} wouldReap` +
    Object.entries(result.kept).map(([reason, ids]) => ` · ${reason}=${ids.length}`).join(''));
}
