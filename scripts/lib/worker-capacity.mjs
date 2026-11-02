/**
 * @file we:scripts/lib/worker-capacity.mjs
 * R313/R349 measured worker capacity, SHADOW only. Pure: from the last hour of host samples (1-min load + active
 * agent session count) fit load = baseline + perWorkerCost * sessions, then
 *   cap = floor((targetLoad - baseline) / perWorkerCost), clamped to [1, ceiling].
 * The R349 step rule is returned beside it for comparison; nothing here changes behaviour.
 */
export const WORKER_CAPACITY_DEFAULTS = Object.freeze({ targetLoad: 30, ceiling: 10 });
export const WORKER_CAPACITY_WINDOW_MS = 60 * 60 * 1000;
const MIN_SAMPLES = 30;

/** R349 stopgap: L<24 -> 8, 24-35 -> 5, >=36 -> 0. */
export function stepRuleCap(load1) {
  if (!Number.isFinite(load1)) return null;
  return load1 < 24 ? 8 : load1 < 36 ? 5 : 0;
}

/** Keep only well-formed samples inside the window, from resource history jsonl text. */
export function parseSamples(text, { nowMs, windowMs = WORKER_CAPACITY_WINDOW_MS } = {}) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.sampledAt);
    const load1 = row?.cpu?.loadAvg?.[0];
    const sessions = row?.agentSessions?.total;
    if (!Number.isFinite(at) || !Number.isFinite(load1) || !Number.isFinite(sessions)) continue;
    if (at > nowMs || nowMs - at > windowMs) continue;
    out.push({ at, load1, sessions });
  }
  return out;
}

/** Least squares load = baseline + cost * sessions; falls back to a plain ratio when the data cannot support a fit. */
export function fitWorkerCost(samples) {
  const n = samples.length;
  if (n < MIN_SAMPLES) return { method: 'insufficient', n, baseline: null, perWorkerCost: null };
  const mx = samples.reduce((s, p) => s + p.sessions, 0) / n;
  const my = samples.reduce((s, p) => s + p.load1, 0) / n;
  const sxx = samples.reduce((s, p) => s + (p.sessions - mx) ** 2, 0);
  const sxy = samples.reduce((s, p) => s + (p.sessions - mx) * (p.load1 - my), 0);
  const slope = sxx > 0 ? sxy / sxx : 0;
  if (slope > 0.05) return { method: 'regression', n, baseline: Math.max(0, my - slope * mx), perWorkerCost: slope };
  if (mx > 0 && my > 0) return { method: 'ratio', n, baseline: 0, perWorkerCost: my / mx };
  return { method: 'insufficient', n, baseline: null, perWorkerCost: null };
}

export function computeCap({ targetLoad, ceiling, baseline, perWorkerCost }) {
  if (!Number.isFinite(baseline) || !Number.isFinite(perWorkerCost) || perWorkerCost <= 0) return null;
  const raw = Math.floor((targetLoad - baseline) / perWorkerCost);
  return Math.min(ceiling, Math.max(1, raw));
}

const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** Cascade: standard defaults -> repo settings (`workerCapacity`) -> env. Invalid layers are skipped. */
export function resolveWorkerCapacitySettings({ settings = {}, env = {} } = {}) {
  const repo = settings?.workerCapacity ?? {};
  const envLayer = {
    targetLoad: env.WE_WORKER_CAPACITY_TARGET_LOAD === undefined ? undefined : Number(env.WE_WORKER_CAPACITY_TARGET_LOAD),
    ceiling: env.WE_WORKER_CAPACITY_CEILING === undefined ? undefined : Number(env.WE_WORKER_CAPACITY_CEILING),
  };
  const pick = (key, ok) => {
    for (const [source, layer] of [['env', envLayer], ['repo', repo]]) if (ok(layer[key])) return { value: layer[key], source };
    return { value: WORKER_CAPACITY_DEFAULTS[key], source: 'standard' };
  };
  const t = pick('targetLoad', posNum), c = pick('ceiling', (v) => Number.isSafeInteger(v) && v > 0);
  return { targetLoad: t.value, ceiling: c.value, sources: { targetLoad: t.source, ceiling: c.source } };
}

export function assessWorkerCapacity({ historyText, load1, settings, nowMs }) {
  const samples = parseSamples(historyText, { nowMs });
  const fit = fitWorkerCost(samples);
  const cap = computeCap({ ...settings, baseline: fit.baseline, perWorkerCost: fit.perWorkerCost });
  const sessionNow = samples.length ? samples[samples.length - 1].sessions : null;
  return { at: new Date(nowMs).toISOString(), load1: Number.isFinite(load1) ? load1 : null, sessions: sessionNow,
    targetLoad: settings.targetLoad, ceiling: settings.ceiling, sources: settings.sources, ...fit,
    cap, stepCap: stepRuleCap(load1), shadow: true };
}

export function renderWorkerCapacity(a) {
  const f = (n, d = 2) => Number.isFinite(n) ? String(Math.round(n * 10 ** d) / 10 ** d) : 'n/a';
  return [`worker capacity (SHADOW, changes nothing)  load1 ${f(a.load1, 1)} · sessions ${f(a.sessions, 0)} · samples ${a.n} (${a.method})`,
    `  baseline ${f(a.baseline)} · per-worker cost ${f(a.perWorkerCost)} · target ${a.targetLoad} · ceiling ${a.ceiling}`,
    `  measured cap ${a.cap ?? 'n/a (insufficient data)'}  vs  R349 step rule ${a.stepCap ?? 'n/a'}`].join('\n');
}
