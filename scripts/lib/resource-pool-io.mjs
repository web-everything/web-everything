/** S1a: read-only studio observation; no leases, reaping or admission wiring. */
import * as fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { POOL_DEFAULTS, validClasses, budgetFromSnapshot, grantDecision, summarize, digestLine } from './resource-pool.mjs';
import { appendResourceLog, admit } from './resource-admission.mjs';
import { readPoolLaneStatus, poolLaneLeased } from './resource-pool-lanes.mjs';
import { admissionLockRoot, loadAdmissionPolicy, resolveSlotSpan, slotPath } from '../readiness/heavy-admission.mjs';
import { EXEMPT_DISPATCH_KINDS, PREPARE_DISPATCH_KINDS } from '../readiness/heavy-queue-projection.mjs';
import { hostname } from 'node:os';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { fixDispatchClaimRoot, fixDispatchSessionName, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES } from '../conveyor/fix-claim-store.mjs';
import { parseLockEntry, isLeaseExpired, lockDirFor } from '../readiness/file-locks.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { probeSlotAlive } from '../operations/red-team-slots.mjs';
import { pidStartTime, pidNamespace } from './pid-alive.mjs';
import { liveReviewRoundBudget } from '../../skills-src/conveyor/review-daemon.mjs';
import { operatorOverridesPath, CAPACITY_LEAVES } from './operator-override-reader.mjs';
import { cascadePolicy, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { parseSessionSlug } from '../conveyor/session-slug.mjs';
import { readEnumOverride } from './operator-enum-store.mjs';
import { readSettingsChecked, SETTINGS_DIR, LEGACY_SETTINGS_PATH } from './settings-files.mjs';
// Diagnostic age threshold only: active rows still require proven death before omission.
export const RED_TEAM_HARD_LEASE_CEILING_MS = 24 * 60 * 60 * 1000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isInteger(v) && v >= 0 && v <= 64;
const clean = v => String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
/** Validate and read one opened object; bounded reads also refuse growth after fstat. */
export function readPoolJson(path, { io = fs } = {}) {
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const info = io.fstatSync(fd), limit = 16 * 1024 * 1024;
    if (!info.isFile() || info.size > limit) throw Error('expected regular source <=16 MiB; inspect source manually');
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let size = 0, n;
    while (size < buffer.length && (n = io.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size > info.size || size > limit) throw Error('source grew during read; inspect source manually');
    const text = buffer.toString('utf8', 0, size);
    // Consume string tokens atomically and track keys per object, including escaped aliases.
    const containers = [];
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '{') containers.push(new Set());
      else if (char === '[') containers.push(null);
      else if (char === '}' || char === ']') containers.pop();
      else if (char === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') i++;
          i++;
        }
        let next = i + 1;
        while (next < text.length && /\s/.test(text[next])) next++;
        if (text[next] !== ':') continue;
        const key = JSON.parse(text.slice(start, i + 1)), keys = containers.at(-1);
        if (!(keys instanceof Set)) throw Error('invalid source object; inspect source manually');
        if (keys.has(key)) throw Error('duplicate source key; repair source and rerun');
        keys.add(key);
      }
    }
    const data = JSON.parse(text);
    if (!object(data)) throw Error('expected source object; inspect source manually');
    return { data, text, mtimeMs: info.mtimeMs };
  } finally { io.closeSync(fd); }
}
const json = path => readPoolJson(path).data;
/** Numeric override stores are flat: decode key tokens to catch escaped duplicates too. */
export function readPoolOverrides({ file = operatorOverridesPath() } = {}) {
  let checked;
  try { checked = readPoolJson(file); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const seen = new Set();
  for (const match of checked.text.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)) {
    const key = JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim());
    if (seen.has(key)) throw Error('duplicate capacity override key; repair operator store and rerun');
    seen.add(key);
  }
  const result = {};
  for (const [key, value] of Object.entries(checked.data)) {
    if (!key.startsWith('resourcePool.')) continue;
    if (!CAPACITY_LEAVES[key]?.validate(value)) throw Error('invalid resourcePool override; repair operator store and rerun');
    result[key.slice('resourcePool.'.length)] = value;
  }
  return result;
}
const list = path => {
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length > 20000) throw Error('source exceeds 20000 entries; inspect/archive source manually');
  return entries;
};
/** Dotted filename keys in unrelated settings are data, not resourcePool policy paths.
 * Keep all read/parse/duplicate errors closed; waive only dotted-key taint from a
 * readable layer proven unable to own this namespace (including dotted aliases). */
export function readPoolSettingsChecked({ dir = SETTINGS_DIR,
  legacyPath = LEGACY_SETTINGS_PATH } = {}) {
  const checked = readSettingsChecked({ namespace: 'resourcePool', dir, legacyPath });
  checked.taint = checked.taint.filter(t => {
    if (t.reason !== 'dotted key') return true;
    try {
      const path = t.source === basename(LEGACY_SETTINGS_PATH) ? legacyPath
        : /^settings\/[a-z0-9-]+\.json$/.test(t.source) ? join(dir, t.source.slice(9)) : null;
      const data = json(path);
      return Object.keys(data).some(k => k === 'resourcePool' || k.startsWith('resourcePool.'));
    } catch { return true; }
  });
  return checked;
}

/** The tolerant admission status reader can hide malformed lock.json: validate each slot directly. */
export function readPoolHeavyHeld({ env = process.env, root = admissionLockRoot(process.cwd(), env),
  cap = resolveSlotSpan(loadAdmissionPolicy({ env }).settings) } = {}) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 20000) throw Error('invalid heavy capacity; inspect settings manually');
  if (!fs.lstatSync(root).isDirectory()) throw Error('invalid heavy root; inspect admission manually');
  const held = [];
  for (let i = 0; i < cap; i++) {
    const dir = lockDirFor(root, slotPath(i));
    try { if (!fs.lstatSync(dir).isDirectory()) throw Error('invalid heavy slot directory'); }
    catch (e) { if (e.code !== 'ENOENT') throw e;
      if (!fs.lstatSync(root).isDirectory()) throw Error('heavy root disappeared; inspect admission manually');
      continue; }
    const raw = json(join(dir, 'lock.json'));
    if (!parseLockEntry(JSON.stringify(raw))) throw Error('malformed heavy slot; inspect admission manually');
    held.push(raw);
  }
  return { held };
}

/** Resolve each read afresh; unreadable layers never become permission to grant. */
export function loadPoolSettings({ env = process.env, read = readPoolSettingsChecked,
  platform, operatorOverride, overrideFile, enumOverride, log = () => {} } = {}) {
  let error;
  const project = p => {
    if (p === undefined) return p;
    if (!object(p)) { error = 'invalid resourcePool layer'; return {}; }
    // Validate before the cascade flattens objects and can drop an empty value.
    if (Object.keys(p).some(k => !['mode', 'builderFloor', 'classes', 'class'].includes(k))) error = 'unrecognized resourcePool key';
    if (Object.hasOwn(p, 'mode') && !['off', 'shadow', 'enforce'].includes(p.mode)) error = 'invalid resourcePool mode';
    if (Object.hasOwn(p, 'builderFloor') && !integer(p.builderFloor)) error = 'invalid resourcePool builderFloor';
    if (Object.hasOwn(p, 'class') && Object.hasOwn(p, 'classes')) error = 'ambiguous resourcePool class aliases';
    for (const key of ['class', 'classes'].filter(k => Object.hasOwn(p, k))) {
      if (!object(p[key]) || Object.entries(p[key]).some(([c, v]) =>
        !['1', '2', '3', '4'].includes(c) || !object(v) || Object.entries(v).some(([k, n]) =>
          !['reserve', 'max', ...(c === '1' ? ['class1Overdraw'] : [])].includes(k) || !integer(n))
        || (Object.hasOwn(v, 'reserve') && Object.hasOwn(v, 'max') && v.reserve > v.max))) error = 'invalid resourcePool class bounds';
    }
    const { classes, ...rest } = p;
    const value = { ...rest, ...(classes === undefined ? {} : { class: classes }) };
    return value;
  };
  let tool;
  try {
    const checked = read();
    if (!object(checked?.value) || !Array.isArray(checked.taint) || checked.taint.length) throw Error('unreadable/tainted resourcePool settings');
    tool = project(checked.value);
    if (platform === undefined) {
      const result = readPlatformPreferences({ env, readFile: (path, encoding) => {
        const text = fs.readFileSync(path, encoding), data = JSON.parse(String(text));
        if (object(data) && Object.hasOwn(data, 'resourcePool')) project(data.resourcePool);
        return text;
      } });
      if (result.errors.length) error = 'unreadable platform settings';
      platform = Object.hasOwn(result.prefs, 'resourcePool') ? result.prefs.resourcePool : {};
    }
    if (operatorOverride === undefined) operatorOverride = readPoolOverrides({ file: overrideFile });
    if (enumOverride === undefined) enumOverride = readEnumOverride('resourcePool.mode');
  } catch (e) { error = clean(e.message); }
  const valid = { mode: v => ['off', 'shadow', 'enforce'].includes(v), builderFloor: integer, class: object };
  for (let c = 1; c <= 4; c++) for (const k of ['reserve', 'max', ...(c === 1 ? ['class1Overdraw'] : [])]) valid[`class.${c}.${k}`] = integer;
  const resolved = cascadePolicy('resourcePool', tool, { env, platform: project(platform) ?? {}, operatorOverride: operatorOverride ?? null,
    standard: { mode: 'shadow', builderFloor: 4, class: POOL_DEFAULTS.classes },
    envValues: { mode: env.WE_RESOURCE_POOL_MODE }, valid });
  if (enumOverride?.ok) { resolved.value.mode = enumOverride.value; resolved.sources.mode = 'operator-enum-db'; resolved.leafValues.mode = enumOverride.value; }
  const { class: classes, ...rest } = resolved.value;
  if (rest.mode === 'enforce') error = 'enforce is not yet supported; hold, select shadow/off or implement an enforcement gate';
  const unknown = !!error || !!resolved.invalid.length || operatorOverride === null || !validClasses(classes)
    || !integer(rest.builderFloor) || !valid.mode(rest.mode)
    || !enumOverride || (!enumOverride.ok && !['absent', 'not-set'].includes(enumOverride.reason));
  const configuredMode = rest.mode;
  const value = { mode: configuredMode === 'off' ? 'off' : 'shadow', builderFloor: rest.builderFloor, classes };
  const provenance = `${formatCascadeSourcesLine('resourcePool', resolved)}; S1a effective mode=${value.mode} (configured ${configuredMode})`;
  log(provenance);
  return { value, configuredMode, unknown, error: error ?? (unknown ? 'invalid settings; inspect layers and rerun' : undefined), provenance };
}
export const SOURCES = Object.freeze({ snapshot: 'resource-sampler snapshot (memory, swap, CPU)',
  rounds: 'liveReviewRoundBudget (bounded ps process inventory)', redTeam: 'redTeamStatusDir (canonical status files)',
  fix: 'fixDispatchClaimRoot (class-3 fix claims)', workers: 'read-only lane leases + heavy-admission held fix/ci-heal slots' });
export function poolSourcePaths({ env = process.env, coord = resolveCoordinationRoot({ env }) } = {}) {
  return { snapshot: join(coord, 'resource', 'snapshot.json'), redTeam: redTeamStatusDir(env), fix: fixDispatchClaimRoot(coord) };
}
export function poolPidAlive(pid, kill = (p, signal) => process.kill(p, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : e.code === 'EPERM' ? true : null; }
}
export function readPoolSource(source, { paths, coord, env = process.env, nowMs = Date.now(), cwd = process.cwd(), readRegistry,
  roundBudget = liveReviewRoundBudget, run = execFileSync,
  listCommands = () => run('ps', ['-Aww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }),
  heavyStatus = () => readPoolHeavyHeld({ env }),
  laneStatus = () => readPoolLaneStatus({ env, nowMs, cwd, run, readJson: json, readRegistry }),
  processAlive = poolPidAlive, readStart = pidStartTime, host = hostname(), namespace = pidNamespace(),
  slotAlive } = {}) {
  const processSlotAlive = data => {
    const killAlive = pid => {
      const alive = processAlive(pid);
      if (typeof alive !== 'boolean') throw Error('unknown process liveness');
      return alive;
    };
    if (data.host && data.host !== host) return null;
    return probeSlotAlive(data, { killAlive, readStart, host, namespace });
  };
  slotAlive ??= processSlotAlive;
  let expiredRedTeamRows = 0;
  try {
    const holders = [];
    const add = (kind, id, priority, size, jobId) => holders.push({ kind, id, class: priority, size, source, resource: 'studio.units',
      ...(jobId ? { jobId } : {}) });
    let budget, snapshot;
    if (source === 'snapshot') {
      snapshot = json(paths.snapshot);
      budget = budgetFromSnapshot(snapshot, { nowMs });
      if (budget.unknown) throw Error('missing, stale or malformed memory/swap/CPU evidence');
    } else if (source === 'rounds') {
      const inventory = listCommands();
      const rows = String(inventory).split('\n').filter(l => l.trim());
      if (!rows.length || rows.some(l => !/^\s*\d+\s+\d+\s+\S/.test(l))
        || !rows.some(l => Number(/^\s*(\d+)/.exec(l)[1]) === process.pid))
        throw Error('incomplete ps inventory; inspect processes manually and rerun');
      const rounds = roundBudget({ env, listCommands: () => inventory });
      if (!Number.isSafeInteger(rounds?.live) || rounds.live < 0 || rounds.live > 20000) throw Error('live review rounds unknown or >20000; inspect processes manually');
      for (let i = 0; i < rounds.live; i++) add('review', `live-round-${i}`, 2, 1);
    } else if (source === 'workers') {
      const status = laneStatus();
      if (!Array.isArray(status?.lanes) || status.lanes.length > 20000) throw Error('invalid/oversized lane inventory; inspect lane-pool manually');
      const lanes = new Set();
      for (const row of status.lanes) {
        if (!object(row) || Object.hasOwn(row, 'readError') || typeof row.path !== 'string' || typeof row.leased !== 'boolean'
          || (row.lease !== null && (!object(row.lease) || typeof row.lease.session !== 'string'
            || (row.lease.purpose != null && typeof row.lease.purpose !== 'string')))
          || (row.leased && !row.lease)) throw Error('malformed lane status; inspect lane-pool manually');
        if (row.leased !== poolLaneLeased(row.lease, nowMs)) throw Error('inconsistent lane lease status; inspect lane-pool manually');
        // Both conveyor-fix and conveyor-ci-heal consume a class-3 fixer slot.
        if (!row.leased) continue;
        if (![row.lease.purpose, row.lease.session].some(v => /^(?:conveyor-)?(?:fix|ci-heal)(?:-|$)/.test(v ?? ''))) {
          // Purposes are free-form. With none, require a known non-fix session identity.
          if (!row.lease.purpose?.trim() && !/^build(?:er)?(?:-|$)/.test(row.lease.session) && !parseSessionSlug(row.lease.session))
            throw Error('unknown lane holder identity; inspect lane-pool manually');
          continue;
        }
        if (lanes.has(row.path)) throw Error('duplicate lane status');
        lanes.add(row.path);
        add('fix', `${row.lease.session} (${row.path})`, 3, 2, row.lease.session);
      }
      const heavy = heavyStatus();
      if (!Array.isArray(heavy?.held) || heavy.held.length > 20000) throw Error('invalid heavy held inventory; inspect heavy-admission manually');
      for (const row of heavy.held) {
        if (!object(row) || !object(row.meta)) throw Error('unknown heavy holder identity; inspect heavy-admission manually');
        if (!['fix', 'ci-heal'].includes(row.meta.dispatchKind)) {
          if (['build', ...EXEMPT_DISPATCH_KINDS, ...PREPARE_DISPATCH_KINDS].includes(row.meta.dispatchKind)) continue;
          throw Error('unknown heavy holder identity; inspect heavy-admission manually');
        }
        const lane = typeof row.owner === 'string' ? row.owner.replace(/#\d+$/, '') : null;
        if (!lane) throw Error('unknown heavy holder lane; inspect heavy-admission manually');
        if (lanes.has(lane)) continue;
        lanes.add(lane);
        add('fix', row.meta.session ?? lane, 3, 2, typeof row.meta.session === 'string' ? row.meta.session : undefined);
      }
    } else if (source === 'fix') {
      for (const entry of list(paths.fix).filter(e => /^[a-f0-9]{16}$/.test(e.name))) {
        if (!entry.isDirectory()) throw Error('invalid fix lock directory');
        const raw = json(join(paths.fix, entry.name, 'lock.json'));
        // Only a readable, valid heartbeat proves expiry; mtime cannot stand in for it.
        if (typeof raw.heartbeatAt !== 'string' || !Number.isFinite(Date.parse(raw.heartbeatAt))
          || Date.parse(raw.heartbeatAt) > nowMs) throw Error(`invalid fix heartbeat: ${entry.name}`);
        if (isLeaseExpired(raw, nowMs, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES)) continue;
        const row = parseLockEntry(JSON.stringify(raw));
        if (!row
          || typeof row.meta?.repo !== 'string' || !Number.isSafeInteger(row.meta.pr) || row.meta.pr <= 0
          || !['fix', 'ci-heal'].includes(row.meta.kind)) throw Error(`invalid fix claim: ${entry.name}`);
        add('fix', row.path ?? entry.name, 3, 2, fixDispatchSessionName(row.meta));
      }
    } else if (source === 'redTeam') {
      // The writer owns <encoded-repo>-<pr>-<40-hex-head>.json. Companion files are not holders.
      for (const entry of list(paths.redTeam).filter(e => /^.+-\d+-[a-f0-9]{40}\.json$/.test(e.name))) {
        const file = join(paths.redTeam, entry.name), checked = readPoolJson(file), row = checked.data;
        if (typeof row.repo !== 'string' || !Number.isSafeInteger(row.pr) || row.pr <= 0
          || typeof row.head !== 'string' || entry.name !== `${encodeURIComponent(row.repo)}-${row.pr}-${row.head}.json`
          || !['queued', 'running', 'finished', 'ok', 'failed', 'cancelled', 'canceled', 'timeout', 'timed-out', 'error'].includes(row.status)) throw Error('invalid red-team status');
        const statusAt = checked.mtimeMs;
        if (!Number.isFinite(statusAt)) throw Error('invalid red-team mtime; inspect status manually');
        if (!['running', 'queued'].includes(row.status)) continue;
        if (row.pid == null) throw Error(`unknown red-team liveness: ${entry.name}; missing pid; inspect status manually`);
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw Error(`invalid red-team pid: ${entry.name}`);
        if (typeof row.pidStart !== 'string' || !row.pidStart.trim()) throw Error(`invalid red-team pidStart: ${entry.name}`);
        // Old rows bypass the slot callback only after direct process-identity evidence.
        // Age alone never releases a live holder or excuses unreadable liveness.
        const alive = nowMs - statusAt > RED_TEAM_HARD_LEASE_CEILING_MS
          ? processSlotAlive(row) : slotAlive(row, { statusAt });
        if (typeof alive !== 'boolean') throw Error(`unknown red-team liveness: ${entry.name}; inspect host/process access`);
        if (alive) add('redTeam', `${row.repo}:${row.pr}:${row.head}`, 2, 1);
        else if (nowMs - statusAt > RED_TEAM_HARD_LEASE_CEILING_MS) expiredRedTeamRows++;
      }
    } else throw Error('unknown source');
    return { source, ok: true, holders, budget, snapshot, expiredRedTeamRows };
  } catch (e) { return { source, ok: false, holders: [], expiredRedTeamRows, error: `${clean(e.message)}; inspect source and rerun` }; }
}
export function collectResourcePool({ env = process.env, nowMs = Date.now(), coord = resolveCoordinationRoot({ env }),
  settings = loadPoolSettings({ env }), paths = poolSourcePaths({ env, coord }), readSource = readPoolSource,
  legacy = admit } = {}) {
  const sources = Object.entries(SOURCES).map(([source, description]) => {
    let result;
    try { result = readSource(source, { paths, coord, env, nowMs }); } catch (e) { result = { ok: false, error: clean(e.message) }; }
    if (result?.source !== source || !Array.isArray(result?.holders) || typeof result?.ok !== 'boolean'
      || result.holders.some(h => !h || h.source !== source || ![2, 3].includes(h.class) || ![1, 2].includes(h.size))
      || (source === 'snapshot' && result.ok && (result.budget?.unknown !== false
        || !Number.isInteger(result.budget.units) || result.budget.units < 0 || result.budget.units > 30))) result = { ok: false, holders: [], error: 'invalid source result' };
    return { ...result, source, description, path: paths[source] ?? (source === 'workers' ? 'lane lease files / heavy-admission' : 'ps process inventory') };
  });
  // Claims bridge dispatch to worker startup: both observations describe one job.
  // Missing job identity stays separately counted; never guess from a lane or display ID.
  // An explicit repo scopes a jobId; identical IDs from different repos are distinct jobs.
  const jobs = new Set();
  const holders = sources.flatMap(s => s.ok ? s.holders : []).filter(holder => {
    if (holder.kind !== 'fix' || typeof holder.jobId !== 'string' || !holder.jobId) return true;
    const jobKey = JSON.stringify([holder.repo ?? null, holder.jobId]);
    if (jobs.has(jobKey)) return false;
    jobs.add(jobKey);
    return true;
  });
  const unknown = !!settings.unknown || sources.some(s => !s.ok)
    || sources.find(s => s.source === 'snapshot')?.budget?.unknown !== false;
  const budgets = { 'studio.units': sources.find(s => s.source === 'snapshot')?.budget?.units };
  const rows = [['review', 2, 1], ['redTeam', 2, 1], ['fix', 3, 2]].map(([kind, priority, size]) => {
    const pool = grantDecision({ budget: budgets['studio.units'], held: holders, class: priority, size,
      classes: settings.value.classes, builderFloor: settings.value.builderFloor, unknown });
    let old;
    try { old = legacy({ kind: kind === 'redTeam' ? 'review' : kind, env, nowMs, root: coord }); } catch { /* comparison unknown */ }
    return { ts: new Date(nowMs).toISOString(), host: hostname(), resource: 'studio.units', kind, class: priority,
      poolDecision: pool.decision, legacyDecision: old?.unknown || !old ? 'unknown' : old.verdict === 'admit' ? 'grant' : 'hold',
      legacySource: 'resource-admission.admit (resource check only; dispatch caps excluded)',
      unknown: unknown || pool.unknown, reason: pool.reason };
  });
  const report = { mode: settings.value.mode, configuredMode: settings.configuredMode, unknown, holders, sources, settings,
    budgets, summary: summarize(holders), rows, builderFloor: settings.value.builderFloor,
    scope: 'S1a partial inventory: C2 review rounds/red-team, C3 fix/ci-heal claims and live workers', shrink: null };
  report.digest = digestLine(report);
  return report;
}
export function appendShadowRows(rows, { env = process.env, coord = resolveCoordinationRoot({ env }), mode = 'shadow', append = appendResourceLog } = {}) {
  if (mode === 'off') return false;
  try { for (const row of rows) if (append(join(coord, 'resource', 'pool-shadow.jsonl'), row) === false) return false; return true; }
  catch { return false; }
}
