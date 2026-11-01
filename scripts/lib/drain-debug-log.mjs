/** Observational drain diagnostics. No IO except the injected sink; never retain argv/results. */
import { resolveCascade } from './policy-cascade.mjs';

const guardedStreams = new WeakSet();
export function createDrainDebugSink(stream = process.stderr) {
  return line => {
    try {
      if (!guardedStreams.has(stream)) {
        stream.on('error', () => {});
        guardedStreams.add(stream);
      }
      stream.write(line);
    } catch { /* Both synchronous writes and asynchronous stream errors are best-effort. */ }
  };
}

export function resolveDrainDebugSetting({ tool, platform, env = {} } = {}) {
  const raw = env.WE_DRAIN_DEBUG;
  const r = resolveCascade({ standard: { debugLog: true },
    tool: { debugLog: tool?.debugLog }, platform: { debugLog: platform?.debugLog },
    envValues: { debugLog: raw == null ? undefined : !['0', 'false'].includes(String(raw).toLowerCase()) },
    valid: { debugLog: v => typeof v === 'boolean' } });
  return { enabled: r.value.debugLog, source: r.sources.debugLog };
}

// Only metadata fields are accepted. Do not add bodies, errors, argv, SHAs or environment here.
const FIELDS = new Set('num repo step label ms totalMs reads slowest cache hits misses ghCalls pages checks fetched reused decision reason untilMs source enabled truncated'.split(' '));
const scrub = s => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')
  .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+|Bearer\s+\S+|[A-Za-z0-9_+\/=.-]{32,}/gi, '[redacted]').slice(0, 80);
function clean(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
  if (Array.isArray(value)) return value.slice(0, 10).map(v => clean(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => FIELDS.has(k)).map(([k, v]) => [k, clean(v, depth + 1)]));
}
export function createDrainDebugLog({ enabled = true, source = 'standard', sink = () => {}, now = Date.now } = {}) {
  const clock = () => { try { return now(); } catch { return 0; } };
  let emitMs = 0;
  const timingNow = () => clock() - emitMs;
  const emit = (kind, data) => {
    if (!enabled || !['listing', 'gateReads', 'decision', 'mergeCascade', 'postMergeSync'].includes(kind)) return;
    const start = clock();
    try {
      const prefix = `[drain-debug] ${kind} `;
      let row = clean(data) || {};
      // Drop bounded trailing metadata until the line fits; preserve valid single-line JSON.
      if ((prefix + JSON.stringify(row)).length > 599) {
        row.truncated = true;
        while ((prefix + JSON.stringify(row)).length > 599) {
          const key = Object.keys(row).filter(k => k !== 'truncated').at(-1);
          if (!key) break;
          if (Array.isArray(row[key]) && row[key].length) row[key].pop(); else delete row[key];
        }
      }
      sink(prefix + JSON.stringify(row) + '\n');
    } catch { /* Diagnostics must never change drain outcomes, including a broken stderr pipe. */ }
    finally { emitMs += Math.max(0, clock() - start); }
  };
  // Observe a separate branch; callers keep their exact value/promise and scheduling.
  const observe = (result, done) => {
    try {
      if (result != null && typeof result.then === 'function') {
        const branch = result.then(done, done);
        branch?.catch?.(() => {});
      } else done();
    } catch { /* A diagnostic observer must not replace the caller's result. */ }
    return result;
  };
  let calls = 0, slowest = [], pages = 0, hits = 0, misses = 0;
  const record = (label, start) => {
    const ms = Math.max(0, clock() - start);
    calls++;
    slowest.push({ label, ms });
    slowest.sort((a, b) => b.ms - a.ms);
    slowest.length = Math.min(5, slowest.length);
  };
  const wrapGh = (fn, label = 'gh') => {
    if (!enabled) return fn;
    return function (...args) {
      if (args[0] !== 'gh') return fn.apply(this, args);
      const start = clock();
      let result;
      try { result = fn.apply(this, args); } catch (e) { record(label, start); throw e; }
      return observe(result, () => record(label, start));
    };
  };
  const gate = metadata => {
    const start = enabled ? clock() : 0, reads = [];
    return {
      read(label, fn) {
        if (!enabled) return fn();
        const t = clock();
        const done = () => { reads.push({ label, ms: Math.max(0, clock() - t) }); };
        let result;
        try { result = fn(); } catch (e) { done(); throw e; }
        return observe(result, done);
      },
      finish(cached) { emit('gateReads', { ...metadata, totalMs: enabled ? clock() - start : 0,
        cache: cached ? 'hit' : 'miss', slowest: [...reads].sort((a, b) => b.ms - a.ms)[0]?.label ?? null, reads }); },
    };
  };
  const checkpoint = kind => {
    let last = enabled ? timingNow() : 0;
    return (step, metadata = {}) => {
      if (!enabled) return;
      const end = timingNow(); emit(kind, { ...metadata, step, ms: end - last }); last = end;
    };
  };
  return { enabled, emit, wrapGh, gate, checkpoint, timingNow,
    // Project existing terminal buckets only; never feed diagnostics back into the planner.
    decisions({ verdicts = [], enqueueOutcomes = [], skipReasons = [], deferred = [], merged = [], localSlug } = {}) {
      if (!enabled) return;
      for (const v of verdicts) {
        const same = x => x.num === v.num && (x.repo || localSlug) === (v.repo || localSlug);
        const enqueue = enqueueOutcomes.findLast(same);
        const skip = skipReasons.find(same);
        const wait = deferred.find(same);
        const landed = merged.some(same);
        emit('decision', { num: v.num, repo: v.repo || localSlug,
          decision: enqueue?.outcome === 'enqueued' ? 'enqueued' : landed ? 'merged' : wait?.overlapYield ? 'yielded' : 'skipped',
          reason: enqueue?.outcome === 'enqueued' ? 'enqueued' : skip?.kind ?? (landed ? 'merged' : 'ready-not-reached'),
          untilMs: wait?.overlapYield?.untilMs ?? v.untilMs ?? v.holdUntilMs ?? null });
      }
    },
    listingPage(data) {
      if (!enabled) return;
      pages += data.pages || 0; hits += data.reused || 0; misses += data.hydrated || 0;
    },
    listing(data = {}) { emit('listing', { enabled, source, ghCalls: calls, pages, hits, misses, slowest, ...data }); },
  };
}
