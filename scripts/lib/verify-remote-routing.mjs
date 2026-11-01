import { existsSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { admissionLockRoot, admissionBypassReason, poolRootOf, loadAdmissionPolicy, decideRemote, resolveRemoteClient } from '../readiness/heavy-admission.mjs';
import { defaultPoolRoot } from './lane-pool-paths.mjs';
import { allowedCommand, allowedEnv } from '../readiness/forge-exec-run.mjs';
import { verificationInfrastructureFailure } from './lane-verify.mjs';

function simpleShellWords(command) {
  if (/[\r\n]/.test(command)) return null;
  // Plain words and single-quoted segments only; shell operators and expansions stay local. A quoted
  // segment may also hold `"[]`, literal inside single quotes, so a JSON VERIFY_SCAN_FILES list parses.
  const word = "(?:[a-zA-Z0-9_./:=@%+,\\-]|'[a-zA-Z0-9_./:=@%+, \"\\[\\]\\-]*')+";
  if (!new RegExp(`^${word}(?:[ \\t]+${word})*$`).test(command)) return null;
  return command.match(new RegExp(word, 'g'));
}
const unquote = arg => arg.replaceAll("'", '');

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Keys that change neither the nested wrapper's admission (CI bypasses it) nor its routing. Each must
// also pass Forge's env allowlist, so the remote run sees the same value.
const SEGMENT_ENV_KEYS = Object.freeze(['TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'VERIFY_SCAN_FILES']);
const VITEST_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*npx vitest(?=\s|$)/;

function wrappedVitestCommand(command) {
  if (/[\r\n]/.test(command)) return null;
  const words = simpleShellWords(command);
  if (!words) return null;
  // Leading assignments run with the nested wrapper, so they apply locally and reach Forge only
  // through its env allowlist. Any other key keeps the segment local.
  let start = 0;
  for (; start < words.length; start++) {
    const assignment = ENV_ASSIGNMENT.exec(words[start]);
    if (!assignment) break;
    if (!SEGMENT_ENV_KEYS.includes(assignment[1]) || !allowedEnv({ [assignment[1]]: unquote(assignment[2]) })) return null;
  }
  if (words[start] !== 'npx' || words[start + 1] !== 'vitest' || words[start + 2] !== 'run') return null;
  const args = words.slice(start + 3);
  // The nested wrapper and Forge both receive every original argument; Forge's allowlist accepts the
  // gate options (R314), so nothing is stripped. Options must be literal words: a quoted spelling stays local.
  if (!args.length || args.some(arg => arg.startsWith("'-") || (arg.startsWith('-') && arg.includes("'")))) return null;
  if (!allowedCommand(['npx', 'vitest', 'run', ...args.map(unquote)])) return null;
  return [...words.slice(0, start), 'npm run test:unit --', ...args].join(' ');
}

// A gate built as `vitest run … && VAR=… vitest run …` is remote-eligible only when EVERY top-level
// segment is; the shell keeps `&&` short-circuiting and each nested wrapper owns its own fallback.
function wrappedVitestChain(command) {
  const segments = command.split(' && ');
  const wrapped = segments.map(wrappedVitestCommand);
  return wrapped.every(Boolean) ? wrapped.join(' && ') : null;
}

export function phaseAdmissionPlan({ command, decision, cwd = process.cwd() }) {
  if (command.split(' && ').every(segment => VITEST_SEGMENT.test(segment))) {
    const wrapped = decision?.remote === true ? wrappedVitestChain(command) : null;
    return { command: wrapped ?? command, takeLocalSlot: !wrapped, setHeld: !wrapped };
  }
  const words = simpleShellWords(command)?.map(unquote);
  const eligible = !!words && (
    (words[0] === 'npm' && words[1] === 'run' && ['test:unit', 'check:standards'].includes(words[2])
      && (words.length === 3 || words[3] === '--'))
    || (words[0] === 'node' && words[2] === 'run'
      && resolve(cwd, words[1]) === resolve(cwd, 'scripts/readiness/heavy-admission.mjs')));
  const remote = eligible && decision?.remote === true;
  return { command, takeLocalSlot: !remote, setHeld: !remote };
}

export function shouldConfirmRemoteRed({ plan, exitCode, signal, timedOut, ranOn } = {}) {
  // The nested wrapper owns local fallback. A local or mixed phase has already run locally;
  // confirming the whole chain again could discard a failure before isolated-retry safeguards run.
  return plan?.takeLocalSlot === false && !['local', 'mixed'].includes(ranOn?.location)
    && Number.isInteger(exitCode) && exitCode > 0 && exitCode !== 124
    && !timedOut && !verificationInfrastructureFailure({ exitCode, signal });
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
// `remoteAttempt` says whether this attempt was handed to the nested remote wrapper. Only an attempt that was
// never dispatched (verify-lane held admission itself) is local without a report. A dispatched attempt without a
// valid report is `unknown`: it may have run anywhere. A missing flag counts as dispatched (fails closed).
export function phaseRunLocation(reports, { remoteAttempt } = {}) {
  if (!reports.length) return { location: remoteAttempt === false ? 'local' : 'unknown' };
  const locations = new Set(reports.map(r => r.location === 'remote' ? 'remote' : 'local'));
  const receiptId = reports.find(r => r.location === 'remote' && r.receiptId)?.receiptId;
  return { location: locations.size > 1 ? 'mixed' : [...locations][0], ...(receiptId ? { receiptId } : {}) };
}
export function mergeRunLocation(a, b) {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return a === b ? a : 'mixed';
}
export function overallRunLocation(phases) {
  const locations = [...new Set(Object.values(phases).map(p => p.location))];
  return { location: locations.length ? locations.reduce(mergeRunLocation) : 'local', phases };
}
export const REMOTE_TERMINATION_UNCONFIRMED = Object.freeze({ reason: 'remote-termination-unconfirmed',
  detail: 'verification infrastructure failure: remote termination unconfirmed (exit 124); confirm remote termination before retrying; no test verdict.' });
// Exit 124 means "remote termination unconfirmed" only for an attempt dispatched to the remote wrapper whose report
// does not prove it finished locally. A local attempt (never dispatched, or a local confirmation) exiting 124 is an
// ordinary local exit code.
export function remoteInfrastructureFailure({ exitCode, remoteAttempt, ranOn } = {}) {
  return exitCode === 124 && remoteAttempt === true && ranOn?.location !== 'local' ? { ...REMOTE_TERMINATION_UNCONFIRMED } : null;
}
