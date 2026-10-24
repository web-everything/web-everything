export const ROUTE_DEFAULTS = Object.freeze({ thresholdMinutes: 10, loadCap: 36, enabled: true });
const bound = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const cleanRouteText = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
export function decideRoute(options = {}) {
  const local = reason => ({ path: 'local', reason });
  if (!['lane-check', 'full', 'targeted'].includes(options.mode)) return local('unavailable mode or targeted ref');
  for (const key of ['projectedWaitMinutes', 'heavyWaitMinutes', 'load1', 'loadCap', 'thresholdMinutes']) {
    if (!bound(options[key])) return local(`invalid or missing ${key}`);
  }
  const readiness = options.remoteReady;
  if (readiness !== true && readiness?.ready !== true) return local(
    typeof readiness?.reason === 'string' ? readiness.reason : 'remote unavailable: readiness not proven');
  if (options.load1 > options.loadCap) return { path: 'remote', reason: '1-minute load exceeds load cap' };
  const wait = options.mode === 'full' ? options.heavyWaitMinutes : options.projectedWaitMinutes;
  if (wait > options.thresholdMinutes) return { path: 'remote', reason: 'queue wait exceeds threshold' };
  return local('tiny runs are faster locally');
}
export function resolveRouteSettings(env = {}, cascadeDefaults = {}) {
  const settings = { ...ROUTE_DEFAULTS, source: {} };
  for (const key of Object.keys(ROUTE_DEFAULTS)) {
    const valid = key === 'enabled' ? v => typeof v === 'boolean' : bound;
    if (valid(cascadeDefaults[key])) settings[key] = cascadeDefaults[key];
    settings.source[key] = valid(cascadeDefaults[key]) ? cascadeDefaults.source?.[key] ?? 'standard' : 'standard';
    const variable = { thresholdMinutes: 'WE_REMOTE_ROUTE_THRESHOLD_MINUTES', loadCap: 'WE_REMOTE_ROUTE_LOAD_CAP', enabled: 'WE_REMOTE_ROUTE' }[key];
    const text = env[variable]?.trim();
    if (!text) continue;
    const value = key === 'enabled' ? ({ on: true, off: false, true: true, false: false, 1: true, 0: false })[text]
      : /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
    settings[key] = valid(value) ? value : key === 'enabled' ? false : ROUTE_DEFAULTS[key];
    settings.source[key] = valid(value) ? 'environment' : key === 'enabled' ? 'disabled (invalid environment fallback)' : 'standard (invalid environment fallback)';
  }
  return settings;
}
export function formatRouteLog(decision, settings) {
  return cleanRouteText(`verify-lane route: ${decision.path} — ${decision.reason}; ` +
    Object.keys(ROUTE_DEFAULTS).map(key => `${key}=${settings[key]} (${settings.source[key]})`).join(', '));
}
export async function autoRouteVerify({ settings, mode, eligible = true, readQueue, readLoad, readiness, remote, log }) {
  let decision = { path: 'local', reason: settings.enabled ? 'explicit gate requires local verification' : 'remote routing disabled' };
  let ref;
  if (settings.enabled && eligible) {
    try {
      const queue = await readQueue();
      const load1 = await readLoad();
      const evidence = { ...settings, projectedWaitMinutes: queue.projectedWaitMinutes,
        heavyWaitMinutes: queue.heavyWaitMinutes, load1, mode };
      decision = decideRoute({ ...evidence, remoteReady: true });
      if (decision.path === 'remote') {
        let remoteReady;
        try {
          const ready = await readiness();
          ref = ready.ref;
          remoteReady = typeof ref === 'string' && ref.length > 0;
        } catch { remoteReady = { ready: false, reason: 'remote unavailable: clean pushed HEAD and gh required' }; }
        decision = decideRoute({ ...evidence, remoteReady });
      }
    } catch { decision = { path: 'local', reason: 'queue or load evidence unavailable; using local gate' }; }
  }
  log(formatRouteLog(decision, settings));
  if (decision.path !== 'remote') return false;
  try { if (await remote({ ref, mode }) === 0) return true; } catch { /* local gate remains required */ }
  log('Remote verification failed or unavailable — falling back to the local gate.');
  return false;
}
