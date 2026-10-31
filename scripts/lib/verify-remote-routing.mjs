import { existsSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { admissionLockRoot, admissionBypassReason, poolRootOf, loadAdmissionPolicy, decideRemote, resolveRemoteClient } from '../readiness/heavy-admission.mjs';
import { defaultPoolRoot } from './lane-pool-paths.mjs';
import { allowedCommand } from '../readiness/forge-exec-run.mjs';

function simpleShellWords(command) {
  if (/[\r\n]/.test(command)) return null;
  // Plain words and single-quoted segments only; shell operators and expansions stay local.
  const word = "(?:[a-zA-Z0-9_./:=@%+,\\-]|'[a-zA-Z0-9_./:=@%+, \\-]*')+";
  if (!new RegExp(`^${word}(?:[ \\t]+${word})*$`).test(command)) return null;
  return command.match(new RegExp(word, 'g'));
}
const unquote = arg => arg.replaceAll("'", '');

function wrappedVitestCommand(command) {
  if (/[\r\n]/.test(command)) return null;
  const match = /^npx vitest run[ \t]+(.+)$/.exec(command);
  if (!match) return null;
  const words = simpleShellWords(match[1]);
  if (!words) return null;
  // Strip only the gate's trailing local flags: default timeouts (5s tests, 10s hooks) and
  // failing empty matches without passWithNoTests make remote runs stricter or equal,
  // never greener. Forge is not loaded, so load-scaled timeouts are unneeded.
  const canStrip = arg => {
    const value = unquote(arg);
    if (value === '--passWithNoTests') return true;
    const timeout = /^--(testTimeout|hookTimeout)=(\d+)$/.exec(value);
    return !!timeout && Number(timeout[2]) >= (timeout[1] === 'testTimeout' ? 5000 : 10000);
  };
  const args = words.slice(0, words.findLastIndex(arg => !canStrip(arg)) + 1);
  // Reuse Forge's guard: unknown options, report files and worker overrides stay local.
  if (!allowedCommand(['npx', 'vitest', 'run', ...args.map(unquote)])) return null;
  return `npm run test:unit -- ${args.join(' ')}`;
}

export function phaseAdmissionPlan({ command, decision }) {
  if (/^npx vitest(?=\s|$)/.test(command)) {
    const wrapped = decision?.remote === true ? wrappedVitestCommand(command) : null;
    return { command: wrapped ?? command, takeLocalSlot: !wrapped, setHeld: !wrapped };
  }
  const words = simpleShellWords(command)?.map(unquote);
  const eligible = !!words && (
    (words[0] === 'npm' && words[1] === 'run' && ['test:unit', 'check:standards'].includes(words[2])
      && (words.length === 3 || words[3] === '--'))
    || (words[0] === 'node' && /^(?:.*\/)?scripts\/readiness\/heavy-admission\.mjs$/.test(words[1])
      && words[2] === 'run'));
  const remote = eligible && decision?.remote === true;
  return { command, takeLocalSlot: !remote, setHeld: !remote };
}

// This is a preflight only. The nested wrapper remains the sole remote executor and fallback owner.
export async function decidePhaseRemote({ cwd, env = process.env, policy, argv = [],
  loadPerCore = () => loadavg()[0] / cpus().length, checkHealth } = {}) {
  try {
    const lockRoot = admissionLockRoot(cwd, env);
    if (admissionBypassReason({ env, poolExists: existsSync(poolRootOf(lockRoot)) })) return { remote: false, reason: 'admission-bypass' };
    policy ??= loadAdmissionPolicy({ env, checkoutRoot: cwd });
    let load;
    try { load = loadPerCore(); } catch { /* unreadable load remains local */ }
    const decision = decideRemote({ policy, loadPerCore: load, argv });
    if (!decision.remote) return decision;
    const client = resolveRemoteClient({ clientPath: policy.settings.remote.clientPath,
      laneRoots: [defaultPoolRoot(cwd, env), defaultPoolRoot()] });
    if (client.reason) return { remote: false, reason: 'remote-client-unusable' };
    checkHealth ??= (await import('../readiness/forge-remote-health.mjs')).checkRemoteHealth;
    const health = await checkHealth({ root: join(dirname(lockRoot), 'remote'), settings: policy.settings.remote });
    return health.ok === true ? decision : { remote: false, reason: health.reason ?? 'remote-health-unreadable' };
  } catch { return { remote: false, reason: 'remote-preflight-unreadable' }; }
}

function readBoundedReport(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 65536) throw new Error('invalid report size');
    const buffer = Buffer.alloc(65537);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 65536 || size !== st.size) throw new Error('incomplete or oversized report');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}
export function readRemoteReport(path, read = readBoundedReport) {
  try {
    const text = read(path, 'utf8');
    if (Buffer.byteLength(text) > 65536) return [];
    const reports = text.trim().split('\n').map(line => JSON.parse(line));
    if (!reports.length || reports.some(r => !['remote', 'local-fallback'].includes(r?.location)
      || !Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 254
      || (r.location === 'remote' && typeof r.receiptId !== 'string')
      || (r.receiptId !== undefined && (typeof r.receiptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.receiptId))))) return [];
    return reports;
  } catch { return []; }
}
export function phaseRunLocation(reports) {
  if (!reports.length) return { location: 'local' };
  const locations = new Set(reports.map(r => r.location === 'remote' ? 'remote' : 'local'));
  const receiptId = reports.find(r => r.location === 'remote' && r.receiptId)?.receiptId;
  return { location: locations.size > 1 ? 'mixed' : [...locations][0], ...(receiptId ? { receiptId } : {}) };
}
export function overallRunLocation(phases) {
  const locations = new Set(Object.values(phases).map(p => p.location));
  return { location: locations.size > 1 || locations.has('mixed') ? 'mixed' : [...locations][0] ?? 'local', phases };
}
export function remoteInfrastructureFailure({ exitCode } = {}) {
  return exitCode === 124 ? { reason: 'remote-termination-unconfirmed',
    detail: 'verification infrastructure failure: remote termination unconfirmed (exit 124); confirm remote termination before retrying; no test verdict.' } : null;
}
