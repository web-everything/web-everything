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
  // The nested wrapper owns local fallback. Only a reported remote red authorizes confirmation:
  // missing/malformed reports or a successful prefix cannot rule out an already-local failure.
  return plan?.takeLocalSlot === false && ['remote', 'mixed'].includes(ranOn?.location)
    && ranOn.failureLocation === 'remote'
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
      // The executor also accepts receiptless completions. Receipts are optional metadata, but
      // when supplied must remain valid; a missing receipt must not discard a sibling local red.
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
  // A successful local segment in an && chain says nothing about a later remote failure.
  // Even inconsistent reports must preserve a local red rather than let confirmation erase it.
  const failureLocation = reports.some(r => r.location === 'local-fallback' && r.exitCode > 0) ? 'local'
    : reports.some(r => r.location === 'remote' && r.exitCode > 0) ? 'remote' : null;
  const last = reports.at(-1);
  // An && chain stops at its first nonzero exit. Only a final local completion after a successful
  // prefix can explain the overall local exit; an earlier local success cannot explain exit 124.
  const localExitCode = last.location === 'local-fallback' && reports.slice(0, -1).every(r => r.exitCode === 0)
    ? last.exitCode : undefined;
  return { location: locations.size > 1 ? 'mixed' : [...locations][0], ...(receiptId ? { receiptId } : {}),
    ...(failureLocation ? { failureLocation } : {}), ...(localExitCode !== undefined ? { localExitCode } : {}) };
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
// does not prove that the failing segment finished locally with 124. A local attempt (never dispatched,
// or a local confirmation) exiting 124 is an ordinary local exit code.
export function remoteInfrastructureFailure({ exitCode, remoteAttempt, ranOn } = {}) {
  return exitCode === 124 && remoteAttempt === true && ranOn?.localExitCode !== 124 ? { ...REMOTE_TERMINATION_UNCONFIRMED } : null;
}

// ── xfwf4zc / x1bppc5 Fork 3: rebuild-smoke code checks on Forge ─────────────────────────────────────────────
// The ONLY transport is the heavy-admission remote wrapper this file already preflights; Forge-routed smokes are
// admitted through the heavy-command queue by that wrapper. This helper decides, runs through an injected
// executor, and validates; it never throws and never turns doubt into a pass (any non-`ran` result means the Mac
// runs the same checks with the same verdict rules).
export const FORGE_SMOKE_MARKER = 'FORGE_SMOKE_RESULT ';
const FORGE_SMOKE_MAX_BYTES = 65536;
const FORGE_SMOKE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** PURE: parse Forge output as untrusted text (never executed). Exactly one marker line carrying JSON
 *  `{tree, rows:[{name, ok, ms, detail, closureHash?}]}`. Only a row naming an expected check, with `ok === true`, is kept. */
export function parseForgeSmokeOutput(text, { expectedTree, allowedChecks = [] } = {}) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > FORGE_SMOKE_MAX_BYTES) return { ran: false, reason: 'forge-output-invalid' };
    const lines = text.split('\n').filter((l) => l.startsWith(FORGE_SMOKE_MARKER));
    if (lines.length !== 1) return { ran: false, reason: 'forge-output-invalid' };
    const body = JSON.parse(lines[0].slice(FORGE_SMOKE_MARKER.length));
    if (typeof body?.tree !== 'string' || !/^[0-9a-f]{40,64}$/.test(body.tree) || !Array.isArray(body.rows)) return { ran: false, reason: 'forge-output-invalid' };
    if (!expectedTree || body.tree !== expectedTree) return { ran: false, reason: 'tree-mismatch' };
    const rows = {};
    for (const r of body.rows) {
      if (!r || typeof r.name !== 'string' || !FORGE_SMOKE_NAME.test(r.name) || !allowedChecks.includes(r.name) || r.ok !== true || r.name in rows) continue;
      rows[r.name] = { name: r.name, ok: true, ms: Number.isFinite(r.ms) && r.ms >= 0 ? r.ms : 0,
        detail: typeof r.detail === 'string' ? r.detail.slice(0, 500) : '',
        ...(typeof r.closureHash === 'string' && /^[0-9a-f]{64}$/.test(r.closureHash) ? { closureHash: r.closureHash } : {}) };
    }
    return { ran: true, tree: body.tree, rows };
  } catch { return { ran: false, reason: 'forge-output-invalid' }; }
}

/**
 * Run the shareable code checks of the candidate tree on Forge when its health says ready.
 * `exec({argv, cwd, env})` is the injected executor (default: none -> Mac fallback, `forge-smoke-executor-unconfigured`).
 * @returns {Promise<{ran:true, tree:string, rows:object}|{ran:false, reason:string}>}
 */
export async function runSmokeCodeChecksOnForge({ cwd, env = process.env, expectedTree, allowedChecks, exec, decide = decidePhaseRemote } = {}) {
  try {
    const argv = ['npm', 'run', 'test:unit', '--', 'scripts/lib/__tests__/smoke-forge-code-checks.forge.test.mjs'];
    if (!allowedCommand(argv)) return { ran: false, reason: 'forge-argv-not-allowlisted' };
    const decision = await decide({ cwd, env, argv });
    if (!decision?.remote) return { ran: false, reason: decision?.reason ?? 'forge-not-ready' };
    if (typeof exec !== 'function') return { ran: false, reason: 'forge-smoke-executor-unconfigured' };
    const out = await exec({ argv, cwd, env });
    return parseForgeSmokeOutput(out, { expectedTree, allowedChecks });
  } catch { return { ran: false, reason: 'forge-transport-error' }; }
}
