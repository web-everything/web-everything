// Restart reviewed launchd labels when the adopted sha differs from their last successful restart.
import childProcess from 'node:child_process';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

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

const POLICY_KEYS = { enabled: v => typeof v === 'boolean', allowedLabels: labels };
const POLICY = 'daemon.serviceRestart';

// The cascade flattens nested objects into leaves and validates each leaf by its TOP key only, so
// `enabled: {value: false}` passes the boolean check and is rebuilt as a truthy object. Keep only the two known
// keys, each already a valid whole value; drop (and log) anything else before the cascade sees it.
function strictLayer(layer, name, log) {
  if (layer === undefined || layer === null) return undefined;
  const clean = {};
  if (typeof layer !== 'object' || Array.isArray(layer)) {
    safeLog(log, `${POLICY} ignored malformed ${name} layer (not an object)`);
    return clean;
  }
  for (const [key, valid] of Object.entries(POLICY_KEYS)) {
    if (!Object.hasOwn(layer, key)) continue;
    const value = layer[key];
    if (value === undefined) continue;
    if (valid(value)) clean[key] = value;
    else if (key === 'enabled') {
      // A kill switch that is present but unreadable means "off", never "fall through to a lower layer's on".
      clean.enabled = false;
      safeLog(log, `${POLICY} ${name}.enabled is malformed: treating as disabled`);
    } else safeLog(log, `${POLICY} ignored malformed ${name}.${key}`);
  }
  return clean;
}

function resolveRestartPolicy({ settings, platform, env, envValues, log }) {
  const raw = envValues ?? { enabled: parseKillSwitch(env.WE_DAEMON_SERVICE_RESTART_ENABLED) };
  let plat = platform;
  if (plat === undefined) { try { plat = platformPreference(POLICY, { env }); } catch { plat = undefined; } }
  const policy = cascadePolicy(POLICY, strictLayer(settings, 'settings', log), {
    standard: defaults, env,
    platform: strictLayer(plat, 'platform', log) ?? {},
    envValues: strictLayer(raw, 'env', log) ?? {},
    valid: POLICY_KEYS,
    log: line => safeLog(log, line),
  });
  const p = policy.value;
  if (typeof p?.enabled !== 'boolean' || !labels(p.allowedLabels)) throw new Error('service restart policy is malformed');
  return policy;
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
