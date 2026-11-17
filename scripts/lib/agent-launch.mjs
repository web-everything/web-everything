/**
 * The execution boundary for Claude/Codex sessions and management commands (R1003).
 * Callers own argv/options; this module forwards them without copying or normalising.
 * Inject the existing primitive so synchronous returns, promises and child handles stay intact.
 */
import { spawn } from 'node:child_process';
import { spawnToCompletion } from './spawn-to-completion.mjs';

/** Closed inventory of existing behaviours. Adding a launch requires choosing a mode explicitly. */
export const AGENT_LAUNCH_MODES = Object.freeze([
  'claude-dispatch-bg', 'claude-dispatch-to-completion', 'claude-wrapper-run',
  'claude-review', 'claude-print', 'claude-agents-list', 'claude-stop', 'claude-rm',
  'claude-auth-status', 'claude-resume', 'claude-judge', 'claude-scheduled-sweep',
  'claude-operator', 'claude-explore', 'claude-maintenance', 'claude-converge',
  'codex-exec', 'codex-exec-resume', 'codex-self-review', 'codex-delivery', 'codex-judge',
  'agent-version', 'judge-measurement', 'worker-result-probe', 'review-recheck',
]);
const modes = new Set(AGENT_LAUNCH_MODES);

export class AgentLaunchRefusedError extends TypeError {
  constructor(reason, { mode, cause } = {}) {
    super(`agent-launch refused: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'AgentLaunchRefusedError';
    this.code = 'EAGENTLAUNCHREFUSED';
    this.mode = mode;
    this.reason = reason;
  }
}

function refuse(reason, descriptor, log, cause) {
  const error = new AgentLaunchRefusedError(reason, { mode: descriptor?.mode, cause });
  // A broken optional sink must never suppress the refusal or its diagnostic.
  try { log(`${error.message}\n`); } catch { process.stderr.write(`${error.message}\n`); }
  throw error;
}

/** The native id already present in argv, never a reporting slug or a newly minted id. */
export function agentResumeId(argv = []) {
  return resumeIds(typeof argv === 'string' ? shellWords(argv) : argv)[0] ?? null;
}

function resumeIds(argv) {
  let hasExec = false;
  return argv.flatMap((word, i) => {
    if (word === 'exec') hasExec = true;
    if (word === '--resume' || word === '-r' || word === '--session-id' || (word === 'resume' && hasExec)) return [argv[i + 1] ?? ''];
    return typeof word === 'string' && /^(?:--resume=|--session-id=|-r=?)/.test(word) ? [word.replace(/^(?:--resume=|--session-id=|-r=?)/, '')] : [];
  });
}

// Read shell quoting without evaluating expansions or executing any part of the command.
function shellWords(text) {
  const words = []; let word = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { word += text[++i] ?? ''; started = true; }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s|[;|&()]/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false;
      if (/[;|&()\n]/.test(c)) words.push(';');
    } else { word += c; started = true; }
  }
  if (started) words.push(word);
  return words;
}

function shellResumeIds(text) {
  const words = shellWords(text), ids = [];
  for (let i = 0; i < words.length; i++) {
    const end = words.indexOf(';', i + 1), tail = words.slice(i + 1, end < 0 ? undefined : end);
    if (/(?:^|[/\\])(?:claude|codex)$/.test(words[i])) ids.push(...resumeIds(tail));
    if (/(?:^|\/)(?:ba|z|da|k)?sh$/.test(words[i])) {
      const flag = tail.findIndex(w => /^-[a-z]*c[a-z]*$/.test(w));
      if (flag >= 0 && tail[flag + 1] != null) ids.push(...shellResumeIds(tail[flag + 1]));
    }
  }
  return ids;
}

/**
 * Execute exactly one primitive with its original arguments and return value.
 * `resumeId` is an explicit key even for management commands/fresh launches (null/undefined).
 * The guard is synchronous: a promise is refused rather than accidentally launching before it resolves.
 */
export function launchAgent(descriptor, primitive, ...args) {
  const log = typeof descriptor?.log === 'function' ? descriptor.log : (s) => process.stderr.write(s);
  if (!descriptor || typeof descriptor !== 'object') refuse('descriptor is required', descriptor, log);
  if (!descriptor.mode) refuse('mode is required', descriptor, log);
  if (!modes.has(descriptor.mode)) refuse(`unknown mode ${String(descriptor.mode)}`, descriptor, log);
  if (!Object.hasOwn(descriptor, 'resumeId')) refuse('resumeId key is required', descriptor, log);
  const argv = Array.isArray(args[1]) ? args[1] : typeof args[1] === 'string' ? shellWords(args[1]) : [];
  const nativeIds = [...resumeIds(argv), ...shellResumeIds(String(args[0] ?? ''))];
  if (/(?:^|\/)(?:ba|z|da|k)?sh$/.test(args[0])) {
    const flag = argv.findIndex(w => typeof w === 'string' && /^-[a-z]*c[a-z]*$/.test(w));
    if (typeof argv[flag + 1] === 'string' && flag >= 0) nativeIds.push(...shellResumeIds(argv[flag + 1]));
  }
  if (nativeIds.some(id => descriptor.resumeId !== id)) refuse('resumeId must equal the native resume id in argv', descriptor, log);
  if ('launchGuard' in descriptor) {
    if (typeof descriptor.launchGuard !== 'function') refuse('launchGuard must be a function', descriptor, log);
    let allowed;
    try { allowed = descriptor.launchGuard(); } catch (cause) {
      refuse(`launchGuard threw: ${String(cause?.message ?? cause)}`, descriptor, log, cause);
    }
    if (allowed === false) refuse('launchGuard returned false', descriptor, log);
    if (allowed && typeof allowed.then === 'function') refuse('launchGuard must be synchronous', descriptor, log);
    if (allowed !== true && allowed !== undefined) refuse('launchGuard must return true or undefined', descriptor, log);
  }
  if (typeof primitive !== 'function') refuse('execution primitive is required', descriptor, log);
  return primitive(...args);
}

/** Preserve spawnToCompletion's options/result and the injected spawnFn seam at the OS boundary. */
export function launchAgentToCompletion(descriptor, command, argv, options, io = {}) {
  return spawnToCompletion(command, argv, options, {
    ...io, spawnFn: (...args) => launchAgent(descriptor, io.spawnFn ?? spawn, ...args),
  });
}
