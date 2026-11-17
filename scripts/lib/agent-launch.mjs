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
  const claude = argv.indexOf('--resume');
  if (claude >= 0) return argv[claude + 1] ?? null;
  const codex = argv[0] === 'exec' ? argv.indexOf('resume') : -1;
  return codex >= 0 ? argv[codex + 1] ?? null : null;
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
  const nativeId = Array.isArray(args[1]) ? agentResumeId(args[1]) : null;
  if (nativeId != null && descriptor.resumeId !== nativeId) refuse('resumeId must equal the native resume id in argv', descriptor, log);
  if (descriptor.launchGuard !== undefined) {
    if (typeof descriptor.launchGuard !== 'function') refuse('launchGuard must be a function', descriptor, log);
    let allowed;
    try { allowed = descriptor.launchGuard(); } catch (cause) {
      refuse(`launchGuard threw: ${String(cause?.message ?? cause)}`, descriptor, log, cause);
    }
    if (allowed === false) refuse('launchGuard returned false', descriptor, log);
    if (allowed && typeof allowed.then === 'function') refuse('launchGuard must be synchronous', descriptor, log);
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
