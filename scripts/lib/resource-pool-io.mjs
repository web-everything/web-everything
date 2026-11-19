/** R1094 S1 shadow ledger. Collector reads holders; the CLI sink writes pool-shadow.jsonl.
 * Observations can overlap (e.g. a build and its heavy verification). Count conservatively;
 * use each source's liveness/expiry rules without acquiring or reaping anything.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { fixDispatchClaimRoot, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES } from '../conveyor/fix-claim-store.mjs';
import { buildDispatchClaimRoot, listBuildDispatchClaims } from '../conveyor/build-dispatch-claim.mjs';
import { jobsDir, listJobs, describeJob } from '../operations/start-build-jobs.mjs';
import { reviewJobsDir, readJobRecord } from '../operations/review-job-store.mjs';
import { sharedRunsDir } from '../operations/run-store.mjs';
import { readSlotStatuses, buildSlotReport, probeSlotAlive, MAX_AGE_MS } from '../operations/red-team-slots.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { admissionLockRoot, heldSlots, listWaiting, loadAdmissionPolicy, readLaneLease } from '../readiness/heavy-admission.mjs';
import { defaultPoolRoot, workspaceFor } from './lane-pool-paths.mjs';
import { laneIndicesIn } from './lane-pool-scan.mjs';
import { LEASE_FILENAME } from './lane-lease.mjs';
import { readSnapshot } from './resource-sampler.mjs';
import { appendResourceLog, loadResourcePolicy } from './resource-admission.mjs';
import { parseLockEntry, isLeaseExpired } from '../readiness/file-locks.mjs';
import { cascadePolicy, platformPreference, readOperatorPolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettingsChecked, readSettings } from './settings-files.mjs';
import { daemonCloneForLabel } from './daemon-clone-registry.mjs';
import { liveReviewRoundBudget } from '../../skills-src/conveyor/review-daemon.mjs';
import { pidStartTime, pidNamespace } from './pid-alive.mjs';
import { POOL_DEFAULTS, HOLDER_WEIGHTS, grantDecision, budgetFromSnapshot, summarize, digestLine } from './resource-pool.mjs';

// Some test harnesses load this module under a non-file URL; fall back to cwd rather than failing the import.
const ROOT = (() => { try { return fileURLToPath(new URL('../../', import.meta.url)); } catch { return process.cwd(); } })();
export const SOURCES = Object.freeze({
  fix: 'fix dispatch claims (fixDispatchClaimRoot)',
  reviews: 'review job claims (reviewJobsDir; read-only)',
  rounds: 'live review rounds (liveReviewRoundBudget process probe)',
  redTeam: 'red-team slots (readSlotStatuses)',
  builds: 'build dispatch claims (buildDispatchClaimRoot)',
  buildJobs: 'durable build jobs (jobsDir)',
  heavy: 'heavy-admission local slots (heldSlots)',
  forge: 'heavy-admission remote Forge slots (heldSlots)',
  lanes: 'lane pool leases (laneIndicesIn/readLaneLease)',
  snapshot: 'resource snapshot (readSnapshot)',
});
const integer = n => Number.isInteger(n) && n >= 0 && n <= 64;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const clean = v => String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
const list = dir => {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length > 20000) throw Error('source exceeds 20000 entries; inspect/archive source');
  return entries;
};
const json = path => {
  if (statSync(path).size > 16 * 1024 * 1024) throw Error('source file exceeds 16 MiB; inspect source');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(data)) throw Error('expected source object');
  return data;
};
const jsonFiles = dir => list(dir).filter(e => e.name.endsWith('.json')).map(e => {
  if (!e.isFile()) throw Error('expected JSON file');
  return { name: e.name, data: json(join(dir, e.name)) };
});
/** Validate before tolerant legacy readers can swallow corrupt/missing lock entries. */
function locks(dir) {
  return list(dir).filter(e => /^[a-f0-9]{16}$/.test(e.name)).map(e => {
    if (!e.isDirectory()) throw Error('lock directory unreadable or symbolic');
    const path = join(dir, e.name, 'lock.json');
    json(path);
    const entry = parseLockEntry(readFileSync(path, 'utf8'));
    if (!entry || !Number.isFinite(Date.parse(entry.heartbeatAt))) throw Error('invalid lock evidence');
    return entry;
  });
}
const classify = text => /blocker|merge-path|main-fix|ci-heal|repair/.test(text ?? '') ? 1
  : /review|red-?team/.test(text ?? '') ? 2 : /fix/.test(text ?? '') ? 3 : 4;
const holder = (kind, row, priority, resource = 'studio.units', id = row.path ?? row.slug ?? row.id ?? row.owner) => ({
  id: String(id), kind, resource, class: priority, size: HOLDER_WEIGHTS[kind],
  host: row.host ?? row.meta?.host ?? hostname(),
});

/** Dotted filename keys in unrelated settings are data, not resourcePool policy paths.
 * Keep all read/parse/duplicate errors closed; waive only dotted-key taint from a
 * readable layer proven unable to own this namespace (including dotted aliases). */
export function readPoolSettingsChecked({ dir = join(ROOT, 'scripts/settings'),
  legacyPath = join(ROOT, 'scripts/dispatch-settings.json') } = {}) {
  const checked = readSettingsChecked({ namespace: 'resourcePool', dir, legacyPath });
  checked.taint = checked.taint.filter(t => {
    if (t.reason !== 'dotted key') return true;
    try {
      const path = t.source === 'dispatch-settings.json' ? legacyPath
        : /^settings\/[a-z0-9-]+\.json$/.test(t.source) ? join(dir, t.source.slice(9)) : null;
      const data = json(path);
      return Object.keys(data).some(k => k === 'resourcePool' || k.startsWith('resourcePool.'));
    } catch { return true; }
  });
  return checked;
}

/** Same standard/platform/tool/env/operator-db cascade as delivery-capacity. The singular
 * instant `class.N` namespace is projected to the settings file's plural `classes.N`. */
export function loadPoolSettings({ env = process.env, read = readPoolSettingsChecked,
  platform, operatorOverride, log = console.error } = {}) {
  let checked, error;
  try { checked = read(); if (!object(checked?.value) || checked.taint?.length) throw Error('resourcePool settings unreadable or tainted'); }
  catch (e) { error = clean(e.message); }
  const standard = { mode: POOL_DEFAULTS.mode, builderFloor: POOL_DEFAULTS.builderFloor, class: POOL_DEFAULTS.classes };
  const project = p => { if (!p) return p; const { classes, ...rest } = p; return { ...rest, ...(classes ? { class: classes } : {}) }; };
  if (platform === undefined) platform = platformPreference('resourcePool', { env });
  if (operatorOverride === undefined) operatorOverride = readOperatorPolicy('resourcePool');
  const valid = { mode: v => ['off', 'shadow', 'enforce'].includes(v), builderFloor: integer };
  for (let c = 1; c <= 4; c++) for (const k of ['reserve', 'max', ...(c === 1 ? ['class1Overdraw'] : [])]) valid[`class.${c}.${k}`] = integer;
  const resolved = cascadePolicy('resourcePool', project(checked?.value), { standard,
    platform: project(platform), operatorOverride, env,
    envValues: { mode: env.WE_RESOURCE_POOL_MODE }, valid });
  const { class: classes, ...rest } = resolved.value;
  const invalid = resolved.invalid?.length || Object.values(classes).some(c => c.reserve > c.max);
  const unknown = !!error || !!invalid || operatorOverride === null;
  const configuredMode = unknown ? 'shadow' : rest.mode;
  const value = { mode: configuredMode === 'off' ? 'off' : 'shadow', builderFloor: rest.builderFloor, classes };
  if (unknown) error ??= 'invalid resourcePool bounds; shadow unknown';
  const provenance = `${formatCascadeSourcesLine('resourcePool', resolved)}; S1 effective mode=${value.mode}${unknown ? ' (unknown fallback)' : ` (configured ${configuredMode})`}`;
  try { log(provenance); } catch { /* diagnostic only */ }
  return { value, configuredMode, unknown, error, sources: resolved.sources, provenance };
}

export function poolSourcePaths({ env = process.env, repoRoot = ROOT, coord = resolveCoordinationRoot({ env }) } = {}) {
  const heavy = admissionLockRoot(repoRoot, env);
  // Review jobs remain clone-local: use the registered dispatcher's clone, never this observer's lane.
  return { fix: fixDispatchClaimRoot(coord), reviews: reviewJobsDir(env, join(workspaceFor(repoRoot), daemonCloneForLabel('com.we.review-daemon'))),
    rounds: env.OPERATION_RUNS_DIR || sharedRunsDir(env), redTeam: env.WE_RED_TEAM_STATUS_DIR || redTeamStatusDir(env),
    builds: buildDispatchClaimRoot(coord), buildJobs: jobsDir(env), heavy,
    forge: join(dirname(heavy), 'remote'), lanes: defaultPoolRoot(repoRoot, env),
    snapshot: join(coord, 'resource', 'snapshot.json') };
}

/** Only ESRCH proves death; invalid PIDs and unexpected probe failures are unknown. */
export function poolPidAlive(pid, kill = (p, signal) => process.kill(p, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : error?.code === 'EPERM' ? true : null; }
}

/** Every source is independently guarded. Missing roots are unknown even when a legacy reader returns []. */
export function readPoolSource(source, { paths, nowMs = Date.now(), caps = {}, isAlive = poolPidAlive,
  snapshotReader = readSnapshot, coord, jobDescribe = describeJob,
  roundBudget = liveReviewRoundBudget, slotAlive = data => {
    if (!Number.isInteger(data.pid) || data.pid <= 0) return null;
    return probeSlotAlive(data, {
      killAlive: pid => {
        const alive = isAlive(pid);
        if (typeof alive !== 'boolean') throw Error('red-team liveness unknown; inspect process access');
        return alive;
      }, readStart: pidStartTime, host: hostname(), namespace: pidNamespace() });
  } } = {}) {
  try {
    const dir = paths[source];
    let holders = [], extra = {};
    if (source === 'snapshot') {
      json(dir);
      const snapshot = snapshotReader({ root: coord });
      const budget = budgetFromSnapshot(snapshot, { nowMs, policy: loadResourcePolicy().policy });
      if (budget.unknown) throw Error('missing, stale or incomplete resource snapshot');
      extra = { snapshot, budget };
    } else if (source === 'fix' || source === 'builds') {
      const entries = locks(dir);
      if (source === 'builds' && entries.some(e => !e.meta?.repo || !e.meta?.num || e.meta.kind !== 'build')) throw Error('incomplete claim metadata');
      const rows = source === 'fix' ? entries.filter(e => !isLeaseExpired(e, nowMs, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES)) : listBuildDispatchClaims({ lockRoot: dir, ignoreExpiry: true });
      if (source !== 'fix' && rows.length !== entries.length) throw Error('claim inventory changed or incomplete');
      holders = rows.map(r => holder(source === 'fix' ? (classify(r.meta?.kind) === 1 ? 'blocker' : 'fix') : 'build', r,
        source === 'fix' ? (classify(r.meta?.kind) === 1 ? 1 : 3) : 4));
    } else if (source === 'reviews') {
      for (const { name, data } of jsonFiles(dir)) {
        if (!Object.hasOwn(data, 'pid') && /^review-\d+\.[A-Za-z0-9._-]+\.json$/.test(name)) continue;
        const r = readJobRecord(name.slice(0, -5), dir);
        if (!r || r.slug !== name.slice(0, -5) || !Number.isInteger(r.pid) || r.pid <= 0) throw Error('invalid review claim');
        const alive = isAlive(r.pid);
        if (typeof alive !== 'boolean') throw Error('review liveness unknown');
        if (alive) holders.push(holder('review', r, 2));
      }
    } else if (source === 'rounds') {
      // The dispatch gate observes live processes, never the unbounded run archive.
      // Its ps probe is time/output bounded and de-duplicates a job's child loop.
      const budget = roundBudget();
      if (!Number.isSafeInteger(budget.live) || budget.live < 0) throw Error(budget.reason ?? 'live rounds unreadable');
      holders = Array.from({ length: budget.live }, (_, i) => holder('review', {}, 2, 'studio.units', `live-round-${i}`));
    } else if (source === 'redTeam') {
      // Match the canonical reader's mtime eligibility before parsing: aged-out
      // history (including attempt metadata) is not occupied-slot evidence.
      // Recent JSON must still validate before the tolerant reader can skip it.
      const files = list(dir).filter(e => e.name.endsWith('.json')).filter(e => {
        const info = statSync(join(dir, e.name));
        return info.isFile() && nowMs - info.mtimeMs <= MAX_AGE_MS;
      });
      for (const file of files) json(join(dir, file.name));
      const rows = readSlotStatuses(dir, { now: nowMs })
        .filter(r => nowMs - r.mtimeMs <= MAX_AGE_MS);
      if (rows.length !== files.length) throw Error('red-team inventory incomplete; inspect recent status files');
      const report = buildSlotReport({ statuses: rows, now: nowMs, aliveFn: slotAlive });
      const occupied = rows.filter(r => ['queued', 'running'].includes(r.data.status));
      holders = report.slots.flatMap((slot, index) => slot.pidAlive === false ? [] :
        [holder('redTeam', occupied[index].data, 2, 'studio.units', `${slot.repo}:${slot.pr}:${slot.head}`)]);
    } else if (source === 'buildJobs') {
      const files = jsonFiles(dir), rows = listJobs(dir);
      if (files.length !== rows.length || rows.some(r => !r.id || !r.handle)) throw Error('incomplete build job');
      holders = rows.flatMap(r => {
        const described = jobDescribe(r);
        if (!['running', 'finished', 'failed', 'ended'].includes(described?.status)) throw Error('build job status unknown');
        return described.status === 'running' ? [holder('build', r, 4)] : [];
      });
    } else if (source === 'heavy' || source === 'forge') {
      const entries = locks(dir);
      const cap = caps[source];
      if (!Number.isInteger(cap) || cap < 0) throw Error('legacy slot cap unknown');
      const slots = entries.map(r => /^slot-(\d+)$/.exec(r.path));
      if (slots.some(s => !s)) throw Error('slot identity unknown');
      const span = Math.max(cap, ...slots.map(s => Number(s[1]) + 1));
      if (span > 1024) throw Error('slot span exceeds 1024; inspect pool');
      const rows = heldSlots({ lockRoot: dir, cap: span });
      if (rows.length !== entries.length) throw Error('slot inventory changed or incomplete');
      if (source === 'heavy') {
        let files = [];
        try { files = jsonFiles(join(dir, 'waiting')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; } // optional until the first waiter
        const waiting = listWaiting(dir);
        if (waiting.length !== files.length || files.some(f => !f.data.owner)) throw Error('waiting inventory incomplete');
        const queuedDemand = {};
        for (const row of waiting) {
          const priority = classify(row.kind);
          queuedDemand[priority] = (queuedDemand[priority] ?? 0) + HOLDER_WEIGHTS.heavy;
        }
        extra = { queuedDemand };
      }
      holders = rows.map(r => holder(source === 'forge' ? 'forge' : 'heavy', r, classify(r.meta?.kind),
        source === 'forge' ? 'forge.slots' : 'studio.units', `slot-${r.slot}:${r.owner}`));
    } else if (source === 'lanes') {
      const budgets = {};
      for (const pool of list(dir).filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
        const path = join(dir, pool.name);
        list(path); // laneIndicesIn tolerates failures; this read must succeed first.
        const indices = laneIndicesIn(path);
        budgets[`lanes.${pool.name}`] = indices.length;
        for (const index of indices) {
          const lane = join(path, `lane-${index}`), marker = join(lane, '.git', LEASE_FILENAME);
          let data;
          try { data = json(marker); } catch (e) {
            // An absent lease is a documented free lane. An absent lane/.git is NOT.
            if (e.code === 'ENOENT') { statSync(join(lane, '.git')); continue; }
            throw e;
          }
          const lease = readLaneLease(lane);
          if (!lease || !data.session || !data.acquiredAt) throw Error('lane lease incomplete');
          // Explicit work identity: blocker/merge repair C1, review/redteam C2, fix C3, build or unknown C4.
          // Never classify a lane number, owner path, or incidental item title as priority.
          const identities = [lease.purpose, lease.session, lease.item?.kind, lease.item?.type];
          const identity = identities.find(v => typeof v === 'string' && /(?:^|[\s:_-])(blocker|merge-path|main-fix|ci-heal|repair|review|red-?team|fix|build)(?:$|[\s:_-])/i.test(v)) ?? '';
          holders.push(holder('lane', lease, classify(identity.toLowerCase()), `lanes.${pool.name}`, `${pool.name}/lane-${index}`));
        }
      }
      extra = { budgets };
    } else throw Error('unknown source');
    return { source, ok: true, unknown: false, holders: holders.map(h => ({ ...h, source })), ...extra };
  } catch (e) { return { source, ok: false, unknown: true, holders: [], error: clean(e.message) }; }
}

/** Best effort, bounded/serialized by the existing resource logger; errors never reach admission callers. */
export function appendShadowRows(rows, { env = process.env, coord, mode = 'shadow', append = appendResourceLog } = {}) {
  if (mode === 'off') return false;
  try {
    const path = join(coord ?? resolveCoordinationRoot({ env }), 'resource', 'pool-shadow.jsonl');
    for (const row of rows) append(path, row);
    return true;
  } catch { return false; }
}

export function collectResourcePool({ env = process.env, repoRoot = ROOT, nowMs = Date.now(),
  coord = resolveCoordinationRoot({ env }), settings = loadPoolSettings({ env }), paths = poolSourcePaths({ env, repoRoot, coord }),
  readSource = readPoolSource, caps } = {}) {
  let capError;
  if (!caps) {
    try {
      const p = loadAdmissionPolicy({ env, repoRoot }).settings;
      const tool = readSettings();
      caps = { heavy: p.cap, forge: p.remote.maxConcurrent, fix: tool.fixDispatchMaxConcurrent ?? 6,
        blocker: tool.mainFixCapacity?.pastFixCap, review: tool.maxLiveReviewRounds ?? 8,
        redTeam: tool.redTeamQueue?.minConcurrent, build: tool.maxConcurrentBuilds };
    } catch (e) { caps = {}; capError = clean(e.message); }
  }
  const sources = Object.keys(SOURCES).map(source => {
    try {
      const result = readSource(source, { paths, coord, caps, nowMs });
      if (!result || result.source !== source || !Array.isArray(result.holders) || typeof result.ok !== 'boolean') throw Error('invalid source result');
      return result;
    } catch (e) { return { source, ok: false, unknown: true, holders: [], error: clean(e.message) }; }
  });
  for (const source of sources) source.description = SOURCES[source.source];
  const holders = sources.flatMap(s => s.holders);
  const unknown = !!settings.unknown || !!capError || sources.some(s => !s.ok || s.unknown);
  const budget = sources.find(s => s.source === 'snapshot')?.budget;
  const budgets = { 'studio.units': budget?.studio?.units, 'forge.slots': caps.forge,
    ...sources.find(s => s.source === 'lanes')?.budgets };
  const summary = summarize(holders);
  if (unknown) for (const resource of Object.values(summary)) resource.unknown = true;
  for (const resource of Object.keys(budgets)) summary[resource] ??= { held: 0, classes: { 1: 0, 2: 0, 3: 0, 4: 0 }, unknown };
  // One hypothetical NEXT start per observed kind/resource/class, plus empty populations.
  const candidates = [...holders, ...[ ['fix', 3], ['blocker', 1], ['review', 2], ['redTeam', 2], ['build', 4], ['heavy', 4], ['forge', 4] ]
    .map(([kind, priority]) => holder(kind, {}, priority, kind === 'forge' ? 'forge.slots' : 'studio.units', 'next'))];
  const queuedDemand = sources.find(s => s.source === 'heavy')?.queuedDemand ?? {};
  const unique = [...new Map(candidates.map(h => [`${h.resource}:${h.kind}:${h.class}`, h])).values()];
  const rows = unique.map(h => {
    const legacyCap = h.kind === 'lane' ? budgets[h.resource] : caps[h.kind === 'heavy' ? 'heavy' : h.kind];
    const count = holders.filter(other => other.kind === h.kind && other.resource === h.resource).length;
    const legacyUnknown = !Number.isFinite(legacyCap);
    const pool = grantDecision({ budget: budgets[h.resource], held: holders.filter(other => other.resource === h.resource),
      class: h.class, size: h.size, queuedDemand: h.resource === 'studio.units' ? queuedDemand : {}, classes: settings.value.classes, builderFloor: settings.value.builderFloor, unknown });
    return { ts: new Date(nowMs).toISOString(), host: hostname(), mode: settings.value.mode,
      resource: h.resource, class: h.class, kind: h.kind, poolDecision: pool.decision,
      legacyDecision: legacyUnknown ? 'unknown' : count < legacyCap ? 'grant' : 'hold',
      reason: `${pool.reason}; next ${h.kind} start: observed ${count}, legacy cap ${legacyUnknown ? '?' : legacyCap}`,
      unknown: unknown || pool.unknown || legacyUnknown };
  });
  const report = { mode: settings.value.mode, configuredMode: settings.configuredMode, unknown, holders, sources,
    settings, budgets, summary, queuedDemand, rows, capError, builderFloor: settings.value.builderFloor };
  report.digest = digestLine(report);
  return report;
}
