/** S1a: read-only studio observation; no leases, reaping or admission wiring. */
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { fixDispatchClaimRoot, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES } from '../conveyor/fix-claim-store.mjs';
import { parseLockEntry, isLeaseExpired } from '../readiness/file-locks.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { probeSlotAlive } from '../operations/red-team-slots.mjs';
import { foreignStaleOwnerDead, foreignHostStaleMs } from './red-team-foreign-host-stale.mjs';
import { pidStartTime, pidNamespace } from './pid-alive.mjs';
import { liveReviewRoundBudget } from '../../skills-src/conveyor/review-daemon.mjs';
import { readSnapshot, appendResourceLog, admit } from './resource-admission.mjs';
import { cascadePolicy, readPlatformPreferences, readOperatorPolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readEnumOverride } from './operator-enum-store.mjs';
import { readSettingsChecked, SETTINGS_DIR, LEGACY_SETTINGS_PATH } from './settings-files.mjs';
import { POOL_DEFAULTS, validClasses, grantDecision, budgetFromSnapshot, summarize, digestLine } from './resource-pool.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isInteger(v) && v >= 0 && v <= 64;
const clean = v => String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
const json = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw Error('expected regular source <=16 MiB; inspect source manually');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(data)) throw Error('expected source object; inspect source manually');
  return data;
};
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

/** Resolve each read afresh; unreadable layers never become permission to grant. */
export function loadPoolSettings({ env = process.env, read = readPoolSettingsChecked,
  platform, operatorOverride, enumOverride, log = () => {} } = {}) {
  let error;
  const project = p => {
    if (p === undefined) return p;
    if (!object(p)) { error = 'invalid resourcePool layer'; return {}; }
    // Validate before the cascade flattens objects and can drop an empty value.
    if (Object.hasOwn(p, 'builderFloor') && !integer(p.builderFloor)) error = 'invalid resourcePool builderFloor';
    const { classes, ...rest } = p;
    const value = { ...rest, ...(classes === undefined ? {} : { class: classes }) };
    if (value.class !== undefined && (!object(value.class) || Object.entries(value.class).some(([c, v]) =>
      !['1', '2', '3', '4'].includes(c) || !object(v) || Object.entries(v).some(([k, n]) =>
        !['reserve', 'max', ...(c === '1' ? ['class1Overdraw'] : [])].includes(k) || !integer(n))))) error = 'invalid resourcePool class bounds';
    return value;
  };
  let tool;
  try {
    const checked = read();
    if (!object(checked?.value) || !Array.isArray(checked.taint) || checked.taint.length) throw Error('unreadable/tainted resourcePool settings');
    tool = project(checked.value);
    if (platform === undefined) {
      const result = readPlatformPreferences({ env });
      if (result.errors.length) error = 'unreadable platform settings';
      platform = result.prefs.resourcePool ?? {};
    }
    if (operatorOverride === undefined) operatorOverride = readOperatorPolicy('resourcePool');
    if (enumOverride === undefined) enumOverride = readEnumOverride('resourcePool.mode');
  } catch (e) { error = clean(e.message); }
  const valid = { mode: v => ['off', 'shadow', 'enforce'].includes(v), builderFloor: integer, class: object };
  for (let c = 1; c <= 4; c++) for (const k of ['reserve', 'max', ...(c === 1 ? ['class1Overdraw'] : [])]) valid[`class.${c}.${k}`] = integer;
  const resolved = cascadePolicy('resourcePool', tool, { env, platform: project(platform) ?? {}, operatorOverride: operatorOverride ?? null,
    standard: { mode: 'shadow', builderFloor: 4, class: POOL_DEFAULTS.classes },
    envValues: { mode: env.WE_RESOURCE_POOL_MODE }, valid });
  if (enumOverride?.ok) { resolved.value.mode = enumOverride.value; resolved.sources.mode = 'operator-enum-db'; resolved.leafValues.mode = enumOverride.value; }
  const { class: classes, ...rest } = resolved.value;
  const unknown = !!error || !!resolved.invalid.length || operatorOverride === null || !validClasses(classes)
    || !integer(rest.builderFloor) || !valid.mode(rest.mode)
    || !enumOverride || (!enumOverride.ok && !['absent', 'not-set'].includes(enumOverride.reason));
  const configuredMode = unknown ? 'shadow' : rest.mode;
  const value = { mode: configuredMode === 'off' ? 'off' : 'shadow', builderFloor: rest.builderFloor, classes };
  const provenance = `${formatCascadeSourcesLine('resourcePool', resolved)}; S1a effective mode=${value.mode} (configured ${configuredMode})`;
  log(provenance);
  return { value, configuredMode, unknown, error: error ?? (unknown ? 'invalid settings; inspect layers and rerun' : undefined), provenance };
}
export const SOURCES = Object.freeze({ snapshot: 'resource-sampler snapshot (memory, swap, CPU)',
  rounds: 'liveReviewRoundBudget (bounded ps process inventory)', redTeam: 'redTeamStatusDir (canonical status files)',
  fix: 'fixDispatchClaimRoot (class-3 fix claims)' });
export function poolSourcePaths({ env = process.env, coord = resolveCoordinationRoot({ env }) } = {}) {
  return { snapshot: join(coord, 'resource', 'snapshot.json'), redTeam: redTeamStatusDir(env), fix: fixDispatchClaimRoot(coord) };
}
export function poolPidAlive(pid, kill = (p, signal) => process.kill(p, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : e.code === 'EPERM' ? true : null; }
}
export function readPoolSource(source, { paths, coord, env = process.env, nowMs = Date.now(),
  snapshotReader = readSnapshot, roundBudget = liveReviewRoundBudget,
  processAlive = poolPidAlive, readStart = pidStartTime, host = hostname(), namespace = pidNamespace(),
  slotAlive = (data, { statusAt }) => {
    const killAlive = pid => {
      const alive = processAlive(pid);
      if (typeof alive !== 'boolean') throw Error('unknown process liveness');
      return alive;
    };
    if (foreignStaleOwnerDead(data, { host, namespace, statusAt, now: nowMs, env,
      isAlive: killAlive, readPidStart: readStart })) return false;
    return probeSlotAlive(data, { killAlive, readStart, host, namespace });
  } } = {}) {
  try {
    const holders = [];
    const add = (kind, id, priority, size) => holders.push({ kind, id, class: priority, size, source, resource: 'studio.units' });
    let budget, snapshot;
    if (source === 'snapshot') {
      json(paths.snapshot); // Validate before the tolerant shared reader.
      snapshot = snapshotReader({ root: coord });
      budget = budgetFromSnapshot(snapshot, { nowMs });
      if (budget.unknown) throw Error('missing, stale or malformed memory/swap/CPU evidence');
    } else if (source === 'rounds') {
      const rounds = roundBudget({ env });
      if (!Number.isSafeInteger(rounds?.live) || rounds.live < 0 || rounds.live > 20000) throw Error('live review rounds unknown or >20000; inspect processes manually');
      for (let i = 0; i < rounds.live; i++) add('review', `live-round-${i}`, 2, 1);
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
        if (row.meta.kind === 'fix') add('fix', row.path ?? entry.name, 3, 2);
      }
    } else if (source === 'redTeam') {
      // The writer owns <encoded-repo>-<pr>-<40-hex-head>.json. Companion files are not holders.
      for (const entry of list(paths.redTeam).filter(e => /^.+-\d+-[a-f0-9]{40}\.json$/.test(e.name))) {
        const file = join(paths.redTeam, entry.name), row = json(file);
        if (typeof row.repo !== 'string' || !Number.isSafeInteger(row.pr) || row.pr <= 0
          || typeof row.head !== 'string' || entry.name !== `${encodeURIComponent(row.repo)}-${row.pr}-${row.head}.json`
          || !['queued', 'running', 'finished'].includes(row.status)) throw Error('invalid red-team status');
        if (row.status !== 'running') continue; // Queued work has not acquired a slot.
        const statusAt = lstatSync(file).mtimeMs;
        if (row.pid == null) {
          // A writer may die between marking running and installing its pid. Only
          // an unchanged record past the shared stale window proves that orphan dead.
          if (Number.isFinite(statusAt) && statusAt > 0 && nowMs - statusAt > foreignHostStaleMs(env)) continue;
          throw Error(`unknown red-team liveness: ${entry.name}; missing pid`);
        }
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw Error(`invalid red-team pid: ${entry.name}`);
        const alive = slotAlive(row, { statusAt });
        if (typeof alive !== 'boolean') throw Error(`unknown red-team liveness: ${entry.name}; inspect host/process access`);
        if (alive) add('redTeam', `${row.repo}:${row.pr}:${row.head}`, 2, 1);
      }
    } else throw Error('unknown source');
    return { source, ok: true, holders, budget, snapshot };
  } catch (e) { return { source, ok: false, holders: [], error: `${clean(e.message)}; inspect source and rerun` }; }
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
    return { ...result, source, description, path: paths[source] ?? 'ps process inventory' };
  });
  const holders = sources.flatMap(s => s.ok ? s.holders : []);
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
    scope: 'S1a partial inventory: C2 review rounds/red-team, C3 fix claims only', shrink: null };
  report.digest = digestLine(report);
  return report;
}
export function appendShadowRows(rows, { env = process.env, coord = resolveCoordinationRoot({ env }), mode = 'shadow', append = appendResourceLog } = {}) {
  if (mode === 'off') return false;
  try { for (const row of rows) append(join(coord, 'resource', 'pool-shadow.jsonl'), row); return true; }
  catch { return false; }
}
