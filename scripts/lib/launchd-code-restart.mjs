// Restart reviewed launchd labels when the adopted sha differs from their last successful restart.
import childProcess from 'node:child_process';
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
