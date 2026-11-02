// Per-pass heap record for the long-running daemons (operator ruling R368): one bounded structured line so a V8
// heap cap can be sized from data instead of RSS alone. On by default; switch off via env WE_DAEMON_HEAP_LOG=0 or the
// `daemonHeapLog.enabled` platform preference. Observation only — never changes daemon behaviour.
import { cascadePolicy } from './policy-cascade.mjs';

const STANDARD = Object.freeze({ enabled: true });

/** Resolve the on/off setting through the policy cascade; a malformed override keeps the lower layer. */
export function resolveDaemonHeapLog(env = process.env) {
  try {
    const v = env?.WE_DAEMON_HEAP_LOG;
    const r = cascadePolicy('daemonHeapLog', undefined, {
      env, standard: STANDARD,
      envValues: { enabled: v === '1' ? true : v === '0' ? false : undefined },
      valid: { enabled: (x) => typeof x === 'boolean' },
    });
    return { ...STANDARD, ...r.value };
  } catch { return { ...STANDARD }; }
}

/** PURE: the record from a `process.memoryUsage()` result. Megabytes to one decimal. */
export function buildHeapRecord({ daemon, pass, passMs, usage, at = new Date() }) {
  const mb = (n) => Math.round((Number(n) || 0) / 1048576 * 10) / 10;
  return {
    at: at.toISOString(), daemon, pass,
    heapUsedMb: mb(usage.heapUsed), heapTotalMb: mb(usage.heapTotal), rssMb: mb(usage.rss), externalMb: mb(usage.external),
    passMs: Number.isFinite(passMs) ? Math.round(passMs) : null,
  };
}

/** Log one heap line at the end of a pass unless switched off. Never throws. */
export function logDaemonHeap({ daemon, pass, passMs, log = console, env = process.env, memoryUsage = () => process.memoryUsage(), now = () => new Date() }) {
  try {
    if (!resolveDaemonHeapLog(env).enabled) return null;
    const record = buildHeapRecord({ daemon, pass, passMs, usage: memoryUsage(), at: now() });
    log.error(`${daemon}: heap ${JSON.stringify(record)}`);
    return record;
  } catch { return null; }
}
