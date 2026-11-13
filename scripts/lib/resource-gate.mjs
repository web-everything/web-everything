import { decideMemoryFloor } from './memory-available.mjs';
import { loadHostOverloadSettings, DEFAULT_SNAPSHOT_MAX_FRESH_MS, DEFAULT_SNAPSHOT_CLOCK_SKEW_MS } from './host-overload-settings.mjs';
import { capacityBand } from '../readiness/host-capacity.mjs';
import { resolveHandoffSettings } from './handoff-settings.mjs';
/**
 * @file we:scripts/lib/resource-gate.mjs
 * @description Card x6nuodj (epic x6woyws, slice 3) — the launch gates' cut-over onto the shared resource decision
 *   `admit({kind})` (we:scripts/lib/resource-admission.mjs). Three pieces:
 *
 *   1. {@link cutoverDecision} — the ONE cut-over step every gate shares: the legacy verdict is logged next to the
 *      shared one (`resource-shadow … old verdict: … | new verdict: …`, plus a shadow.jsonl row), then the shared
 *      verdict DECIDES when the setting `cutover` is `enforce` (the default). `shadow` keeps the legacy verdict
 *      deciding and only logs the pair. A stale or missing snapshot is `admit()`'s own rule: hold a heavy kind,
 *      admit a light one, always logged — this module never loosens that.
 *   2. {@link gateLaunch} — `dispatch-throttle.mjs#gateHost` (the legacy CPU-idle / memory / load-average gate) cut
 *      over: build, fix, ci-heal, review and prepare launches decide through `admit({kind})`.
 *   3. {@link decideCapacityCap} + {@link createResourceFixThrottle} — CPU idle and memory free select the
 *      host-capacity tier. Two consecutive upward readings raise the tier; drops apply immediately. Unknown
 *      evidence falls back to medium. Configured tier caps stay inside the floor/ceiling; the independent
 *      memory floor still refuses unsafe launches. Every admission attempt re-evaluates and logs the cap.
 *
 *   SETTINGS — one block `resourceGate`, resolved per leaf through the policy cascade (same layers and files as the
 *   `resourceAdmission` policy): standard (below) → Platform Forever preference (`~/.claude/platform-preferences.json`
 *   or `WE_PLATFORM_PREFERENCES`) → tool override (`we:scripts/settings/*.json`) → env. Env keys:
 *   `WE_RESOURCE_CUTOVER` (cutover), `WE_FIX_DISPATCH_MAX_CONCURRENT` (fixCap.floor — the old static cap keeps its
 *   meaning as the floor), `WE_FIX_DISPATCH_MAX_CEILING` (fixCap.ceiling), and `WE_FIX_CAP_<LEAF>` for each signal
 *   threshold (e.g. `WE_FIX_CAP_RAISE_MAX_SWAP_USED_PCT`). Every leaf's source is logged once per
 *   process per distinct set ({@link logGateSettingsOnce}).
 */
import { readFileSync } from 'node:fs';
import os, { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit, decideAdmission, readSnapshot, shadowAdmission } from './resource-admission.mjs';
import { countLiveFixSessions, gateHost, isPidAlive, resolveFixDispatchMaxConcurrent } from './dispatch-throttle.mjs';
import { LEGACY_SETTINGS_PATH, readDeclaredSettings } from './settings-files.mjs';
// A cycle (heavy-admission imports this module's cut-over step); safe because neither side calls the other at load time.
import { resolveLiveQueueBaseline } from '../readiness/heavy-admission.mjs';

export const RESOURCE_GATE_STANDARD = Object.freeze({
  cutover: 'enforce',
  fixCap: Object.freeze({
    floor: null, // null = the legacy static cap (dispatch-settings `fixDispatchMaxConcurrent`)
    ceiling: null, // null = floor + ceilingAboveFloor
    ceilingAboveFloor: 4,
    capacityCaps: Object.freeze({ low: 1, medium: 2, high: 4 }),
    raiseQueueOver: 5, // operator 2026-10-10: raise when the queue is longer than ~5
    raiseStepPerPass: 2,
    // Operator 2026-10-10: a fixer mostly waits on the model and its tests already queue on heavy admission, so CPU
    // idle is the wrong main signal (23% idle held the cap at the floor while swap 26.5/27.6 GB was what hurt).
    // The cap moves on free memory + swap and on the projected heavy-queue wait; CPU is only a backstop.
    // R558 (2026-11-04): the memory signals read AVAILABLE memory (free+inactive+purgeable+speculative), which sits far
    // above the old never-used-pages reading, so lower below 15% and raise only above 40% (was 3 / 10). Both stay
    // policy-cascade leaves (fixCap.*, source logged on every fix-cap line); the hard floor + pressure check still apply.
    raiseMinMemFreePct: 40, raiseMaxSwapUsedPct: 60, raiseMaxHeavyWaitMinutes: 15,
    lowerBelowMemFreePct: 15, lowerAboveSwapUsedPct: 90, lowerAboveHeavyWaitMinutes: 45, lowerBy: 4, lowerMinimum: 2,
    holdCpuIdleBelowPct: 10,
  }),
});
const FIX_CAP_SIGNAL_LEAVES = ['raiseMinMemFreePct', 'raiseMaxSwapUsedPct', 'raiseMaxHeavyWaitMinutes', 'lowerBelowMemFreePct',
  'lowerAboveSwapUsedPct', 'lowerAboveHeavyWaitMinutes', 'lowerBy', 'lowerMinimum', 'holdCpuIdleBelowPct'];
const CAPACITY_TIERS = ['low', 'medium', 'high'];
const CAPACITY_CAP_LEAVES = CAPACITY_TIERS.map((tier) => `capacityCaps.${tier}`);
const envNameOf = (leaf) => `WE_FIX_CAP_${leaf.replaceAll('.', '_').replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
export const RESOURCE_GATE_ENV = Object.freeze({
  cutover: 'WE_RESOURCE_CUTOVER', 'fixCap.floor': 'WE_FIX_DISPATCH_MAX_CONCURRENT', 'fixCap.ceiling': 'WE_FIX_DISPATCH_MAX_CEILING',
  ...Object.fromEntries([...FIX_CAP_SIGNAL_LEAVES, ...CAPACITY_CAP_LEAVES].map((leaf) => [`fixCap.${leaf}`, envNameOf(leaf)])),
});
const int = (min) => (v) => Number.isInteger(v) && v >= min;
const pct = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
const minutes = (v) => Number.isFinite(v) && v >= 0;
const VALID = {
  cutover: (v) => v === 'shadow' || v === 'enforce',
  ...Object.fromEntries(CAPACITY_CAP_LEAVES.map((leaf) => [`fixCap.${leaf}`, int(1)])),
  'fixCap.floor': (v) => v === null || int(1)(v),
  'fixCap.ceiling': (v) => v === null || int(1)(v),
  'fixCap.ceilingAboveFloor': int(0),
  'fixCap.raiseQueueOver': int(0),
  'fixCap.raiseStepPerPass': int(1),
  'fixCap.raiseMinMemFreePct': pct, 'fixCap.raiseMaxSwapUsedPct': pct, 'fixCap.raiseMaxHeavyWaitMinutes': minutes,
  'fixCap.lowerBelowMemFreePct': pct, 'fixCap.lowerAboveSwapUsedPct': pct, 'fixCap.lowerAboveHeavyWaitMinutes': minutes,
  'fixCap.lowerBy': int(0), 'fixCap.lowerMinimum': int(1), 'fixCap.holdCpuIdleBelowPct': pct,
};
const LEAVES = Object.keys(VALID);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const leafOf = (block, leaf) => {
  let value = block;
  for (const part of leaf.split('.')) {
    if (!isObj(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
};
const parseEnv = (leaf, raw) => {
  if (raw === undefined || String(raw).trim() === '') return undefined;
  const s = String(raw).trim();
  return leaf === 'cutover' ? s.toLowerCase() : Number(s);
};

/**
 * PURE: resolve the `resourceGate` block. Each leaf: a valid env value, else the tool's, else the platform's, else
 * the standard. An invalid value never overrides a lower layer; it is named in `invalid`. Null floor / ceiling then
 * resolve to the legacy static cap / floor + ceilingAboveFloor; the ceiling is never below the floor.
 * @returns {{settings:{cutover:string, fixCap:object}, sources:Record<string,string>, invalid:string[]}}
 */
export function resolveResourceGateSettings({ platform, tool, env = {}, legacyFloor = 2 } = {}) {
  const values = {}; const sources = {}; const invalid = [];
  for (const leaf of LEAVES) {
    values[leaf] = leafOf(RESOURCE_GATE_STANDARD, leaf); sources[leaf] = 'standard';
    for (const [layer, block] of [['platform', platform], ['tool', tool]]) {
      const v = leafOf(block, leaf);
      if (v === undefined) continue;
      if (VALID[leaf](v)) { values[leaf] = v; sources[leaf] = layer; } else invalid.push(`${layer}.${leaf}=${JSON.stringify(v)}`);
    }
    const envKey = RESOURCE_GATE_ENV[leaf];
    // `cutover` also honours THIS process's env when the caller's hand-built env lacks it (as WE_RESOURCE_SHADOW
    // does): a gate called with `env: {}` must still follow the daemon's or a test suite's switch.
    const rawEnv = leaf === 'cutover' ? (env?.[envKey] ?? process.env[envKey]) : env?.[envKey];
    const e = envKey ? parseEnv(leaf, rawEnv) : undefined;
    if (e !== undefined) {
      if (VALID[leaf](e)) { values[leaf] = e; sources[leaf] = `env ${envKey}`; } else invalid.push(`env ${envKey}=${JSON.stringify(rawEnv)}`);
    }
  }
  if (values['fixCap.floor'] === null) { values['fixCap.floor'] = legacyFloor; sources['fixCap.floor'] = 'standard (fixDispatchMaxConcurrent)'; }
  if (values['fixCap.ceiling'] === null) {
    values['fixCap.ceiling'] = values['fixCap.floor'] + values['fixCap.ceilingAboveFloor'];
    sources['fixCap.ceiling'] = `floor + ${values['fixCap.ceilingAboveFloor']}`;
  }
  if (values['fixCap.ceiling'] < values['fixCap.floor']) {
    invalid.push(`fixCap.ceiling ${values['fixCap.ceiling']} < floor ${values['fixCap.floor']} (ceiling raised to the floor)`);
    values['fixCap.ceiling'] = values['fixCap.floor'];
  }
  const fixCap = {};
  for (const leaf of LEAVES.filter((l) => l.startsWith('fixCap.'))) {
    const parts = leaf.split('.').slice(1);
    let into = fixCap;
    for (const part of parts.slice(0, -1)) into = into[part] ??= {};
    into[parts.at(-1)] = values[leaf];
  }
  return { settings: { cutover: values.cutover, fixCap }, sources, invalid };
}

const repoRootOf = () => fileURLToPath(new URL('../../', import.meta.url));
/** IO: read the platform and tool layers (same files as `loadResourcePolicy`) and resolve. Never throws. */
export function loadResourceGateSettings({ env = process.env, repoRoot, home = homedir(), legacyFloor } = {}) {
  let platform; let tool; const errors = [];
  // Resolved here, not as a default param: some harnesses load modules from a non-file URL, where it throws.
  try { repoRoot ??= repoRootOf(); } catch (e) { errors.push(`tool: ${String(e?.message ?? e).split('\n')[0]}`); }
  try {
    const path = env.WE_PLATFORM_PREFERENCES || join(home, '.claude', 'platform-preferences.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    if (isObj(file) && Object.hasOwn(file, 'resourceGate')) platform = file.resourceGate;
  } catch (e) { if (e?.code !== 'ENOENT') errors.push(`platform: ${String(e?.message ?? e).split('\n')[0]}`); }
  if (repoRoot) try {
    const settingsDir = join(repoRoot, 'scripts', 'settings');
    const declared = readDeclaredSettings({ dir: settingsDir, legacyPath: join(dirname(settingsDir), basename(LEGACY_SETTINGS_PATH)) });
    if (Object.hasOwn(declared.settings, 'resourceGate')) tool = declared.settings.resourceGate;
  } catch (e) { errors.push(`tool: ${String(e?.message ?? e).split('\n')[0]}`); }
  let floor = legacyFloor;
  if (floor === undefined) { try { floor = resolveFixDispatchMaxConcurrent({ env: {} }); } catch { floor = 2; } }
  const resolved = resolveResourceGateSettings({ platform, tool, env, legacyFloor: floor });
  return { ...resolved, invalid: [...resolved.invalid, ...errors] };
}

/** The cut-over switch (`enforce` | `shadow`) for gates that consume the shared decision directly rather than through
 *  {@link cutoverDecision}. Never throws; an unreadable setting is the standard (`enforce`). */
export function resolveCutoverMode(env = process.env) {
  try { return loadResourceGateSettings({ env }).settings.cutover; } catch { return RESOURCE_GATE_STANDARD.cutover; }
}

let lastLogged = null;
/** One `resource-gate settings · leaf=value (source), …` line per process per distinct effective set. */
export function logGateSettingsOnce({ settings, sources, invalid = [] }, log = (line) => process.stderr.write(line)) {
  const parts = [`cutover=${settings.cutover} (${sources.cutover})`,
    ...LEAVES.filter((leaf) => leaf.startsWith('fixCap.')).map((leaf) => `${leaf}=${leafOf(settings, leaf)} (${sources[leaf]})`)];
  const line = `resource-gate settings · ${parts.join(', ')}${invalid.length ? ` · ignored: ${invalid.join('; ')}` : ''}\n`;
  if (line === lastLogged) return false;
  lastLogged = line;
  try { log(line); } catch { /* logging never changes a gate */ }
  return true;
}

const isDecision = (d) => d !== null && typeof d === 'object' && typeof d.verdict === 'string';
const summary = (d) => ({ verdict: d.verdict, reason: d.reason, snapshotAge: d.snapshotAge ?? null, unknown: Boolean(d.unknown) });

/**
 * THE cut-over step. `legacy` is the old gate's `{admit, why?, note?, kind?}`. Logs old | new (via
 * `shadowAdmission`), then: `enforce` → the shared verdict decides (`admit` only on verdict `admit`); `shadow` →
 * the legacy result stands. Never throws; unavailable shared decisions refuse in enforce mode.
 * @returns {{admit:boolean, decidedBy:'admit'|'legacy', why?:string, note?:string, kind?:string, admission?:object}}
 */
export function cutoverDecision({ gate, kind, legacy = { admit: true }, mode = 'enforce', env = process.env, nowMs = Date.now(),
  root, shadow = shadowAdmission, admitFn = admit, log } = {}) {
  const oldVerdict = legacy?.admit === false ? 'hold' : 'admit';
  const oldReason = legacy?.why ?? legacy?.note ?? (legacy?.admit === false ? (legacy?.kind ?? 'refused') : 'admitted');
  let decision;
  try { decision = shadow({ gate, kind, oldVerdict, oldReason, env, nowMs, ...(root ? { root } : {}), ...(log ? { log } : {}) }); } catch { decision = undefined; }
  if (!isDecision(decision)) { try { decision = admitFn({ kind, env, nowMs, ...(root ? { root } : {}) }); } catch { decision = undefined; } }
  if (mode === 'enforce' && !isDecision(decision)) {
    const out = { admit: false, reason: 'gate-error', kind: 'gate-error',
      why: 'gate-error: shared decision unavailable', decidedBy: 'legacy' };
    try { (log ?? ((l) => process.stderr.write(l)))(`resource-gate gate=${gate} kind=${kind} ${out.why}\n`); } catch { /* best effort */ }
    return out;
  }
  if (mode !== 'enforce') {
    return { ...legacy, decidedBy: 'legacy', ...(isDecision(decision) ? { admission: summary(decision) } : {}) };
  }
  const age = decision.snapshotAge == null ? '?' : `${decision.snapshotAge}s`;
  const text = `${decision.verdict} — ${decision.reason} (snapshot age ${age}; legacy said ${oldVerdict})`;
  const out = decision.verdict === 'admit'
    ? { admit: true, decidedBy: 'admit', signal: 'resource-admission', note: `decided by admit({kind:'${kind}'}): ${text}` }
    : { admit: false, decidedBy: 'admit', kind: 'host-load', signal: 'resource-admission',
      why: `decided by admit({kind:'${kind}'}): ${text}; ${kind} launch deferred, running work untouched` };
  try { (log ?? ((l) => process.stderr.write(l)))(`resource-gate gate=${gate} kind=${kind} ${out.admit ? out.note : out.why}\n`); } catch { /* best effort */ }
  return { ...out, admission: summary(decision) };
}

/**
 * `gateHost` cut over: the legacy gate still runs (it is the logged comparison), the shared decision decides.
 * `settings` defaults to the cascade; `legacyGate`, `shadow`, `admitFn` are test seams.
 */
export function gateLaunch({ kind = 'fix', gate, env = process.env, settings, legacyGate = gateHost, nowMs = Date.now(), root,
  shadow, admitFn, log, sample, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length } = {}) {
  let legacy;
  try { legacy = legacyGate({ kind, env, loadavg, cpuCount, ...(sample ? { sample } : {}) }); } catch (e) {
    // Fail closed (R559): a swallowed legacy-gate exception must never admit work, in any cutover mode.
    const why = `gate-error: ${String(e?.message ?? e).split('\n')[0]}`;
    try { (log ?? ((l) => process.stderr.write(l)))(`resource-gate gate=${gate ?? `launch.${kind}`} kind=${kind} ${why}\n`); } catch { /* best effort */ }
    return { admit: false, reason: 'gate-error', kind: 'gate-error', why, decidedBy: 'legacy' };
  }
  let mode = 'enforce';
  try { mode = (settings ?? loadResourceGateSettings({ env }).settings).cutover; } catch { /* the standard */ }
  return cutoverDecision({ gate: gate ?? `launch.${kind}`, kind, legacy, mode, env, nowMs, root,
    ...(shadow ? { shadow } : {}), ...(admitFn ? { admitFn } : {}), ...(log ? { log } : {}) });
}

/**
 * PURE: select the host capacity tier, with two-read upward hysteresis and immediate drops.
 * Unreadable, invalid or stale evidence resets the streak and uses medium; the memory-floor gate is separate.
 * `highStreak` counts consecutive upward reads (including low → medium), bounded at two.
 */
export function decideCapacityCap({ fixCap, bands, snapshot = null, nowMs = Date.now(), prevTier = 'medium', highStreak = 0 } = {}) {
  const f = { ...RESOURCE_GATE_STANDARD.fixCap, ...fixCap };
  const floor = f.floor ?? 2;
  const ceiling = Math.max(floor, f.ceiling ?? floor + f.ceilingAboveFloor);
  const caps = { ...RESOURCE_GATE_STANDARD.fixCap.capacityCaps, ...f.capacityCaps };
  const cpuIdlePct = pct(snapshot?.cpu?.idlePct) ? snapshot.cpu.idlePct : null;
  const memFreePct = pct(snapshot?.memory?.freePct) ? snapshot.memory.freePct : null;
  const sampledAt = Date.parse(snapshot?.sampledAt);
  const freshUntil = Date.parse(snapshot?.freshUntil);
  const fresh = Number.isFinite(sampledAt) && Number.isFinite(freshUntil)
    && freshUntil >= sampledAt
    && freshUntil - sampledAt <= (bands?.snapshotMaxFreshMs ?? DEFAULT_SNAPSHOT_MAX_FRESH_MS)
    && sampledAt <= nowMs + (bands?.snapshotClockSkewMs ?? DEFAULT_SNAPSHOT_CLOCK_SKEW_MS) && nowMs <= freshUntil;
  const validBands = bands && ['cpuIdleLowPct', 'cpuIdleMediumPct', 'memFreeLowPct', 'memFreeMediumPct'].every((key) => pct(bands[key]))
    && bands.cpuIdleLowPct <= bands.cpuIdleMediumPct && bands.memFreeLowPct <= bands.memFreeMediumPct;
  const pressure = snapshot?.memory?.pressureLevel;
  const known = fresh && validBands && cpuIdlePct !== null && memFreePct !== null && [1, 2, 4].includes(pressure);
  const rawTier = known ? (pressure === 1 ? capacityBand(cpuIdlePct, memFreePct, bands) : 'low') : 'medium';
  const previous = CAPACITY_TIERS.includes(prevTier) ? prevTier : 'medium';
  let tier = rawTier; let streak = 0;
  let reason = known ? `host capacity ${rawTier}${pressure !== 1 ? ` (memory pressure ${pressure})` : ''}`
    : 'unknown, invalid or stale capacity evidence: medium fallback';
  if (known && CAPACITY_TIERS.indexOf(rawTier) > CAPACITY_TIERS.indexOf(previous)) {
    streak = Math.min(2, (Number.isInteger(highStreak) && highStreak > 0 ? highStreak : 0) + 1);
    if (streak < 2) tier = previous;
    reason += `; upward reading ${streak}/2`;
  }
  const cap = Math.min(ceiling, Math.max(floor, caps[tier]));
  return { tier, rawTier, highStreak: streak, cap, floor, ceiling, cpuIdlePct, memFreePct, reason };
}

/**
 * PURE: the dynamic fixer cap for one pass, between `lowerMinimum` and `ceiling` (operator 2026-10-10).
 * LOWERED below the floor (to floor - lowerBy, never under lowerMinimum) when free memory, swap or the projected
 * heavy-queue wait is past its lower threshold. RAISED above the floor only when the snapshot is fresh, `fix` is
 * admitted, CPU idle is at least the backstop, free memory / swap / heavy wait are inside their raise thresholds
 * and queueLength > raiseQueueOver. An unknown cpu, memory, swap or wait reading never permits a RAISE (R559) but never blocks a hold or a lower.
 * @param {{fixCap:object, liveAtPassStart:number, queueLength:number|null, heavyWaitMinutes?:number|null, snapshot:object|null, nowMs:number, policy?:object}} o
 */
export function decideFixCap({ fixCap, liveAtPassStart = 0, queueLength = null, heavyWaitMinutes = null, snapshot = null, nowMs = Date.now(), policy } = {}) {
  const f = { ...RESOURCE_GATE_STANDARD.fixCap, ...fixCap };
  const { floor, raiseQueueOver, raiseStepPerPass } = f;
  // The settings loader raises a ceiling under the floor to the floor; callers handing settings in directly skip
  // that, so normalise here too — the cap never exceeds the ceiling, and the floor wins a conflict.
  const ceiling = Math.max(f.ceiling, floor);
  const d = decideAdmission({ kind: 'fix', snapshot, nowMs, ...(policy ? { policy } : {}) });
  const num = (v) => (Number.isFinite(v) ? v : null);
  const cpu = d.inputs?.cpuIdlePct ?? null;
  const fresh = !d.unknown;
  const mem = fresh ? num(snapshot?.memory?.freePct) : null;
  const swap = fresh ? num(snapshot?.memory?.swapUsedPct) : null;
  const wait = num(heavyWaitMinutes);
  const q = Number.isFinite(queueLength) ? queueLength : null;
  const base = { floor, ceiling, cap: floor, raised: false, lowered: false, cpuIdlePct: cpu, memFreePct: mem, swapUsedPct: swap,
    heavyWaitMinutes: wait, queueLength: q, snapshotAge: d.snapshotAge };
  const lowerWhy = [
    swap !== null && swap > f.lowerAboveSwapUsedPct ? `swap ${swap}% > ${f.lowerAboveSwapUsedPct}%` : null,
    mem !== null && mem < f.lowerBelowMemFreePct ? `mem free ${mem}% < ${f.lowerBelowMemFreePct}%` : null,
    wait !== null && wait > f.lowerAboveHeavyWaitMinutes ? `heavy wait ${wait}m > ${f.lowerAboveHeavyWaitMinutes}m` : null,
  ].filter(Boolean);
  if (lowerWhy.length) {
    // Lowering can only ever LOWER: the minimum is clamped under the floor (a floor of 1 stays 1), never lifted above it.
    const cap = Math.min(floor, Math.max(f.lowerMinimum, floor - f.lowerBy));
    return { ...base, cap, lowered: cap < floor, reason: `lowered: ${lowerWhy.join(', ')} → floor ${floor} - ${f.lowerBy}, minimum ${f.lowerMinimum}` };
  }
  if (d.unknown) return { ...base, reason: `floor: ${d.reason} (never raise on an unknown snapshot)` };
  if (d.verdict !== 'admit') return { ...base, reason: `floor: fix not admitted (${d.reason})` };
  // R559: an unknown reading never permits a raise (holding or lowering stay available on what is known).
  const unknownRaise = [['cpu idle', cpu], ['mem free', mem], ['swap', swap], ['heavy wait', wait]].filter(([, v]) => v === null).map(([n]) => n);
  if (unknownRaise.length) return { ...base, reason: `floor: ${unknownRaise.join(', ')} unknown (never raise on an unknown reading)` };
  if (cpu !== null && cpu < f.holdCpuIdleBelowPct) return { ...base, reason: `floor: cpu idle ${cpu}% < ${f.holdCpuIdleBelowPct}% backstop` };
  if (mem !== null && mem < f.raiseMinMemFreePct) return { ...base, reason: `floor: mem free ${mem}% < ${f.raiseMinMemFreePct}% raise threshold` };
  if (swap !== null && swap > f.raiseMaxSwapUsedPct) return { ...base, reason: `floor: swap ${swap}% > ${f.raiseMaxSwapUsedPct}% raise threshold` };
  if (wait !== null && wait > f.raiseMaxHeavyWaitMinutes) return { ...base, reason: `floor: heavy wait ${wait}m > ${f.raiseMaxHeavyWaitMinutes}m raise threshold` };
  if (q === null || q <= raiseQueueOver) return { ...base, reason: `floor: fix queue ${q ?? '?'} ≤ ${raiseQueueOver}` };
  const cap = Math.min(ceiling, Math.max(floor, liveAtPassStart + raiseStepPerPass));
  if (cap <= floor) return { ...base, reason: `floor: ${liveAtPassStart} live + step ${raiseStepPerPass} does not pass the floor` };
  return { ...base, cap, raised: true,
    reason: `raised: mem free ${mem ?? '?'}% ≥ ${f.raiseMinMemFreePct}%, swap ${swap ?? '?'}% ≤ ${f.raiseMaxSwapUsedPct}%, heavy wait ${wait ?? '?'}m ≤ ${f.raiseMaxHeavyWaitMinutes}m and fix queue ${q} > ${raiseQueueOver} → ${liveAtPassStart} live + step ${raiseStepPerPass}, ceiling ${ceiling}` };
}

/** The projected heavy-queue wait (minutes) a fixer's tests would see: the longer of the heavy and short lanes.
 *  Null when the live queue cannot be read (inside a test without a private pool, or any read error). */
export function readLiveHeavyWaitMinutes({ env = process.env } = {}) {
  try {
    const b = resolveLiveQueueBaseline({ env: { ...process.env, ...env } });
    if (!b || b.bypassed) return null;
    const waits = [b.heavyWaitMinutes, b.projectedWaitMinutes].filter(Number.isFinite);
    return waits.length ? Math.max(...waits) : null;
  } catch { return null; }
}

/**
 * The fix daemon's throttle (replaces `createDispatchThrottle` there): the capacity tier cap, then the
 * cut-over host gate. `tryAdmit(kind)` → `{admit:true, note?}` or `{admit:false, kind:'fix-cap'|'host-load', why}`.
 * `queueLength` and `readHeavyWait` remain accepted for caller compatibility; tier selection ignores them.
 * In `shadow` mode the cap is the legacy static cap; the computed one is still logged.
 */
export function createResourceFixThrottle({
  sendBackReservedSlots,
  listClaims = () => [], env = process.env, alive = isPidAlive, queueLength = null, settings, root, nowMs = () => Date.now(),
  readSnap = () => readSnapshot(root ? { root } : {}), readHeavyWait = () => readLiveHeavyWaitMinutes({ env }), gate, log = (line) => process.stderr.write(line),
  resolveFloor = () => { const r = loadHostOverloadSettings({ env, log: () => {} }); return { snapshotClockSkewMs: r.settings.host.capacity.snapshotClockSkewMs, snapshotMaxFreshMs: r.settings.host.capacity.snapshotMaxFreshMs, metric: r.settings.host.capacity.memoryMetric, floorMb: r.settings.host.capacity.memAvailableFloorMb, source: r.sources['host.capacity.memAvailableFloorMb'] ?? 'standard' }; },
  sample, loadavg, cpuCount, // forwarded to the legacy gate (the logged comparison)
} = {}) {
  sendBackReservedSlots ??= resolveHandoffSettings('fix', { env }).value.sendBackReservedSlots;
  // Explicit settings supply the floor/cutover in callers and fixtures; tier leaves still honour environment overrides.
  const capacityEnv = Object.fromEntries(CAPACITY_CAP_LEAVES.map((leaf) => RESOURCE_GATE_ENV[`fixCap.${leaf}`])
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  const resolved = settings ? resolveResourceGateSettings({ tool: settings, env: capacityEnv, legacyFloor: settings.fixCap?.floor ?? 2 })
    : loadResourceGateSettings({ env });
  const gateFor = gate ?? ((kind) => gateLaunch({ kind, gate: `fix-throttle.${kind}`, env, settings: resolved.settings, root, log,
    ...(sample ? { sample } : {}), ...(loadavg ? { loadavg } : {}), ...(cpuCount ? { cpuCount } : {}) }));
  if (!settings) logGateSettingsOnce(resolved, log);
  const legacyCap = (() => { try { return resolveFixDispatchMaxConcurrent({ env }); } catch { return resolved.settings.fixCap.floor; } })();
  let live = null; let capDecision = null; let lastSnap = null; let lastFloor = null;
  let prevTier = 'medium'; let highStreak = 0;
  const floorCheck = (kind) => {
    let snap = null; let floor = { floorMb: null, source: 'unreadable policy' };
    try { snap = readSnap(); } catch { snap = null; }
    try { floor = resolveFloor(); } catch { floor = { floorMb: null, source: 'unreadable policy' }; }
    lastSnap = snap; lastFloor = floor;
    const m = snap?.memory ?? {};
    const sampledAt = Date.parse(snap?.sampledAt);
    const freshUntil = Date.parse(snap?.freshUntil);
    const maxFreshMs = floor.snapshotMaxFreshMs ?? DEFAULT_SNAPSHOT_MAX_FRESH_MS;
    const skewMs = floor.snapshotClockSkewMs ?? DEFAULT_SNAPSHOT_CLOCK_SKEW_MS;
    const fresh = !!snap && Number.isFinite(sampledAt) && Number.isFinite(freshUntil)
      && freshUntil - sampledAt <= maxFreshMs && sampledAt <= nowMs() + skewMs && nowMs() <= freshUntil;
    // R559: the reading must have been taken under the SAME metric this process's policy names; a missing or different
    // stamp is a mismatch and refuses (a stricter "free" dispatcher never trusts a larger "available" reading).
    const metricOk = typeof floor.metric === 'string' && m.metric === floor.metric;
    const d = !metricOk && fresh && floor.floorMb != null
      ? { admit: false, reason: `memory metric mismatch (snapshot ${m.metric ?? 'unstamped'}, policy ${floor.metric ?? 'unknown'})` }
      : decideMemoryFloor({ availableMb: m.availableMb, floorMb: floor.floorMb, pressureLevel: m.pressureLevel, snapshotFresh: fresh });
    if (d.admit) return { admit: true };
    return { admit: false, refusal: { admit: false, kind: 'host-load', signal: 'mem-floor', why: `memory floor: ${d.reason} (floor ${floor.floorMb ?? '?'} MB from ${floor.source}); ${kind} deferred, no claim taken` } };
  };
  const currentCap = (floorAdmitted) => {
    let bands = null;
    try { bands = loadHostOverloadSettings({ env, log: () => {} }).settings.host.capacity; } catch { /* medium fallback */ }
    capDecision = decideCapacityCap({ fixCap: resolved.settings.fixCap, bands, snapshot: lastSnap, nowMs: nowMs(), prevTier, highStreak });
    prevTier = capDecision.tier; highStreak = capDecision.highStreak;
    capDecision.effective = resolved.settings.cutover === 'enforce' ? capDecision.cap : legacyCap;
    try {
      const c = capDecision; const v = (x, unit) => `${x ?? '?'}${unit}`;
      const fixCap = { ...RESOURCE_GATE_STANDARD.fixCap, ...resolved.settings.fixCap };
      const thresholds = CAPACITY_CAP_LEAVES.map((leaf) => `${leaf}=${leafOf(fixCap, leaf)} (${resolved.sources?.[`fixCap.${leaf}`] ?? 'standard'})`).join(', ');
      log(`resource-gate fix-cap: old: static cap ${legacyCap} | new: tier=${c.tier} cpu idle ${v(c.cpuIdlePct, '%')} mem free ${v(c.memFreePct, '%')} → cap ${c.cap} (floor ${c.floor}, ceiling ${c.ceiling}; ${c.reason}; ${live} live) → using ${c.effective} (${resolved.settings.cutover})`
        + ` · mem floor ${v(lastFloor?.floorMb, ' MB')} (${lastFloor?.source ?? '?'}) available ${v(lastSnap?.memory?.availableMb, ' MB')} pressure ${v(lastSnap?.memory?.pressureLevel, '')} → ${floorAdmitted ? 'admit' : 'refuse'}`
        + ` · thresholds: ${thresholds}\n`);
    } catch { /* best effort */ }
    return capDecision;
  };
  return {
    capDecision: () => capDecision,
    tryAdmit(kind = 'fix', { sendBack = false } = {}) {
      if (live === null) { try { live = countLiveFixSessions(listClaims(), { alive }); } catch { live = 0; } }
      // R553/R559 hard floor, before any cap arithmetic. The memory reading is re-read on EVERY admission (never the
      // pass-start copy) and the floor comes from THIS process's own policy cascade, never from the sampler's snapshot.
      // Below the floor, under pressure warn/critical, stale, or unreadable on either side → refuse.
      const fl = floorCheck(kind);
      const c = currentCap(fl.admit);
      if (!fl.admit) return fl.refusal;
      // The reserve never takes the last slot: a cap of 1 still runs ordinary repairs. Its refusal IS a fixer-cap
      // refusal (`kind: 'fix-cap'`), so every reader of that kind — the red-main past-the-cap bypass, the builder-slot
      // borrow, the ci-heal reserve, the main-CI-red owner priority — treats a reserved slot like a full cap.
      const reserved = Math.min(sendBackReservedSlots, Math.max(0, c.effective - 1));
      if (!sendBack && live >= c.effective - reserved && live < c.effective) {
        return { admit: false, kind: 'fix-cap', reserved: 'send-back', why: `${live} live fix/ci-heal session(s) >= ${c.effective - reserved} ordinary slot(s): ${reserved} of cap ${c.effective} reserved for send-backs; ${kind} deferred, no claim taken` };
      }
      if (live >= c.effective) {
        return { admit: false, kind: 'fix-cap', why: `${live} live fix/ci-heal session(s) >= cap ${c.effective} (dynamic fixer cap: floor ${c.floor}, ceiling ${c.ceiling}; ${c.reason}); ${kind} deferred, no claim taken` };
      }
      let g = { admit: true };
      try { g = gateFor(kind); } catch (e) {
        const why = `host gate threw (${String(e?.message ?? e).slice(0, 120)}); ${kind} refused, no claim taken`;
        try { log(`resource-gate fix-throttle: ${why}\n`); } catch { /* best effort */ }
        return { admit: false, kind: 'host-load', signal: 'gate-error', why };
      }
      if (!g.admit) return g;
      live += 1;
      const above = live > legacyCap ? ` — fixer ${live} is above the old static cap ${legacyCap} (${c.reason})` : '';
      return { admit: true, note: `${g.note ?? 'admitted'}; fixer ${live}/${c.effective}${above}`, ...(g.signal ? { signal: g.signal } : {}), ...(above ? { aboveStaticCap: true } : {}) };
    },
  };
}
