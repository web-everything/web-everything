/** The execution authority for fixer processes, including retries and resumed turns.
 * `exec` is synchronous through process creation (it may return a completion promise).
 * Each invocation consumes fresh admission evidence; no successful check is cached.
 */
import { assertFixerLaunch } from '../conveyor/conflict-rebase-launch-gate.mjs';
import { spawn } from 'node:child_process';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';

export function execGuardedFixer(command, argv, opts = {}, {
  exec, gate = assertFixerLaunch, ...gateOptions
} = {}) {
  const { mode, launchGuard, launchContext, launchGateOptions, ...execOpts } = opts;
  gate({ ...launchContext, mode, launchGuard }, { ...launchGateOptions, ...gateOptions });
  return exec(command, argv, execOpts);
}

/** Streaming workers gate at the actual child creation callback, inside the completion primitive. */
export function spawnFixerToCompletion(command, argv, opts = {}, io = {}) {
  const { mode, launchGuard, launchContext, launchGateOptions, ...execOpts } = opts;
  return spawnToCompletion(command, argv, execOpts, {
    spawnFn: (cmd, args, spawnOpts) => execGuardedFixer(cmd, args, {
      ...spawnOpts, mode, launchGuard, launchContext, launchGateOptions,
    }, { exec: io.spawnFn ?? spawn, gate: io.gate }),
  });
}
