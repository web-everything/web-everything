// Restart reviewed launchd labels when the adopted sha differs from their last successful restart.
import childProcess from 'node:child_process';
import { cloneKey } from './daemon-overlays.mjs';
import { readRebuildState } from './daemon-rebuild/state.mjs';
import { cascadePolicy } from './policy-cascade.mjs';

const commandOptions = { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 };
const message = e => String(e?.message ?? e);
const safeLog = (log, line) => {
  try {
    (typeof log === 'function' ? log : log?.error?.bind(log))?.(line.replace(/[\x00-\x1f\x7f]/g, ' '));
  } catch {}
};
const runHost = (command, argv) => new Promise((ok, fail) => childProcess.execFile(command, argv, commandOptions,
  (error, stdout, stderr) => error ? fail(error) : ok({ stdout, stderr, status: 0 })));
const launchHost = argv => runHost('launchctl', argv);
const userId = () => process.getuid();
const inFlight = new Set();
const restartedLabels = new Map();

function assertActive(signal) {
  if (signal?.aborted) throw new Error('service restart cancelled: inspect LaunchAgents before retrying');
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LABEL = 128, MAX_ALLOWED = 64;
const labels = value => Array.isArray(value) && value.length <= MAX_ALLOWED
  && value.every(x => typeof x === 'string' && x.length <= MAX_LABEL && LABEL.test(x))
  && new Set(value.map(x => x.toLowerCase())).size === value.length;
const defaults = { enabled: true, allowedLabels: ['com.we.resource-sampler'] };
const ENABLE_WORDS = new Set(['true', '1', 'yes', 'on']);

function parseKillSwitch(raw) {
  if (raw === undefined || raw === null) return undefined;
  const word = String(raw).trim().toLowerCase();
  return word === '' ? undefined : ENABLE_WORDS.has(word);
}

function resolveRestartPolicy({ settings, platform, env, envValues, log }) {
  const values = envValues ?? {
    enabled: parseKillSwitch(env.WE_DAEMON_SERVICE_RESTART_ENABLED),
  };
  return cascadePolicy('daemon.serviceRestart', settings, {
    standard: defaults, platform, env, envValues: values,
    valid: { enabled: v => typeof v === 'boolean', allowedLabels: labels },
    log: line => safeLog(log, line),
  });
}

const DEV_LABEL = /(?:^|[._-])(?:dev|vite|storybook|playground|npm-start)(?:[._-]|$)/i;
const neverRestartReason = (label, p) =>
  DEV_LABEL.test(label) ? 'built-in-never'
  : !p.allowedLabels.includes(label) ? 'not-allowlisted' : null;

export async function restartServicesForClone({ settings, platform, env = process.env, envValues,
  launchctl = launchHost, uid = userId, log = console, restarted = restartedLabels,
  adoptedSha, signal, selfLabel = null } = {}) {
  const result = { restarted: [], skipped: [], flagged: [], errors: [] };
  let source = 'unresolved';
  const report = (kind, service, reason) => {
    result[kind].push({ ...service, reason });
    safeLog(log, `daemon.serviceRestart ${kind} ${service.label ?? '?'}: ${reason} (source ${source})`);
  };
  try {
    const policy = resolveRestartPolicy({ settings, platform, env, envValues, log });
    source = JSON.stringify({ values: policy.value, sources: policy.sources });
    const p = policy.value;
    for (const label of new Set(p.allowedLabels)) {
      const service = { label };
      const reason = label === selfLabel ? 'self' : !p.enabled ? 'disabled' : neverRestartReason(label, p);
      if (reason) {
        report('skipped', service, reason);
        continue;
      }
      if (inFlight.has(label)) {
        report('skipped', service, 'restart-in-flight');
        continue;
      }
      inFlight.add(label);
      try {
        assertActive(signal);
        if (typeof adoptedSha !== 'string' || !adoptedSha.trim()) {
          throw new Error('unknown adopted sha: inspect rebuild state');
        }
        if (restarted.get(label) === adoptedSha) {
          report('skipped', service, 'same-adopted-sha');
          continue;
        }
        const id = typeof uid === 'function' ? uid() : uid;
        if (!Number.isInteger(id) || id < 0) throw new Error('unreadable uid');
        assertActive(signal);
        const answer = await launchctl(['kickstart', '-k', `gui/${id}/${label}`]);
        if (!answer || answer.error || answer.status !== 0 || answer.code != null && answer.code !== 0) {
          throw new Error(message(answer.error ?? answer.stderr ?? 'launchctl failed'));
        }
        restarted.set(label, adoptedSha);
        report('restarted', service, 'kickstart -k');
      } catch (error) {
        report('errors', service, message(error));
      } finally {
        inFlight.delete(label);
      }
    }
  } catch (error) {
    report('errors', {}, message(error));
  }
  return result;
}

function processStart(label, { launchctl, uid, ps }) {
  const id = typeof uid === 'function' ? uid() : uid;
  if (!Number.isInteger(id) || id < 0) throw new Error('unreadable uid');
  let printed;
  try { printed = launchctl(['print', `gui/${id}/${label}`]); }
  catch (error) {
    if (/could not find service/i.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
  if (printed?.error || printed?.status != null && printed.status !== 0
    || printed?.code != null && printed.code !== 0) throw new Error('launchctl print failed');
  const output = typeof printed === 'string' ? printed : printed?.stdout;
  if (typeof output !== 'string') throw new Error('unreadable launchctl print');
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  if (!pid) {
    if (/state\s*=\s*(?:not running|waiting|exited)/i.test(output)) return null;
    throw new Error('unknown launchctl process state');
  }
  const start = Date.parse(ps(['-o', 'lstart=', '-p', pid]).trim());
  if (!Number.isFinite(start)) throw new Error('unreadable process start');
  const cwd = output.match(/^\s*working directory = (.+)$/m)?.[1]?.trim().replace(/^"(.*)"$/, '$1');
  if (!cwd) throw new Error('unknown service clone: inspect launchctl working directory');
  const root = childProcess.execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], commandOptions).trim();
  if (!root) throw new Error('unknown service clone: inspect its working directory');
  return { start, cloneRoot: root, precisionMs: 1000 };
}

// null adoption means no adopted build; NaN means an unusable adoption timestamp.
const readAdoption = root => {
  const adopted = readRebuildState(root)?.adopted;
  return adopted == null ? { atMs: null, head: null }
    : { atMs: Date.parse(adopted.at ?? ''), head: adopted.head ?? null };
};

/** Inspect only policy-approved labels; fresh callbacks require positive process evidence. */
export function findStaleCodeServices({ cloneRoot, settings, platform, env = process.env, envValues, log,
  selfLabel = null, readProcessStartMs = processStart, readAdoptedAtMs,
  onFreshService = () => {}, now = Date.now, graceMs = 120_000,
  launchctl = argv => childProcess.execFileSync('launchctl', argv, commandOptions), uid = userId,
  ps = argv => childProcess.execFileSync('ps', argv, commandOptions) } = {}) {
  let p;
  try {
    const policy = resolveRestartPolicy({ settings, platform, env, envValues, log });
    p = policy.value;
    safeLog(log, `daemon.serviceRestart inspection ${JSON.stringify({ values: p, sources: policy.sources })}`);
  }
  catch (error) { return [{ label: null, reason: 'policy-unreadable', error: message(error) }]; }
  const flags = [];
  // Keep unresolved evidence distinct from an empty, complete inspection without changing the array API.
  Object.defineProperty(flags, 'complete', { value: true, writable: true });
  for (const label of new Set(p.allowedLabels)) {
    if (!p.enabled || label === selfLabel || neverRestartReason(label, p)) { flags.complete = false; continue; }
    const service = { label };
    try {
      // Injected numeric readers supply already-scoped evidence; the host reader also supplies ownership.
      const evidence = readProcessStartMs(label, { launchctl, uid, ps });
      if (evidence && typeof evidence === 'object' && cloneKey(evidence.cloneRoot) !== cloneKey(cloneRoot)) {
        onFreshService(service); continue; // Positively no longer owned by this clone; never compare its adoption.
      }
      const start = evidence && typeof evidence === 'object' ? evidence.start : evidence;
      if (start === null) { onFreshService(service); continue; }
      if (!Number.isFinite(start)) throw new Error('unreadable process start');
      let adopted;
      try {
        adopted = readAdoptedAtMs ? readAdoptedAtMs(cloneRoot) : readAdoption(cloneRoot).atMs;
        if (adopted !== null && !Number.isFinite(adopted)) throw new Error('unreadable adoption time');
      } catch (error) { flags.complete = false; flags.push({ ...service, reason: 'adoption-unreadable', error: message(error) }); continue; }
      if (adopted === null) { flags.complete = false; continue; }
      // ps lstart has whole-second precision; injected millisecond readings retain their exact boundary.
      const boundary = evidence?.precisionMs === 1000 ? Math.floor(adopted / 1000) * 1000 : adopted;
      if (start >= boundary) { onFreshService(service); continue; }
      const at = now();
      if (!Number.isFinite(at) || !Number.isFinite(graceMs) || graceMs < 0) throw new Error('unreadable grace window');
      if (at - adopted > graceMs) flags.push({ ...service, reason: 'stale-code', processStartMs: start, adoptedAtMs: adopted });
      else flags.complete = false;
    } catch (error) { flags.complete = false; flags.push({ ...service, reason: 'process-unreadable', error: message(error) }); }
  }
  return flags;
}
