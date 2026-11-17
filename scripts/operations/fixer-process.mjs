/** The execution authority for fixer processes, including retries and resumed turns.
 * `exec` is synchronous through process creation (it may return a completion promise).
 * Each invocation consumes fresh admission evidence; no successful check is cached.
 */
import { assertFixerLaunch, assertLaunchDescriptor } from '../conveyor/conflict-rebase-launch-gate.mjs';
import { spawn } from 'node:child_process';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';

export function execGuardedFixer(command, argv, opts = {}, {
  exec, gate: checkLaunch = assertFixerLaunch, ...gateOptions
} = {}) {
  const { mode, launchGuard, launchContext, launchGateOptions, ...execOpts } = opts ?? {};
  const gate = (descriptor, options) => {
    checkLaunch(descriptor, options);
    assertLaunchDescriptor(opts);
  };
  gate({ ...launchContext, mode, launchGuard }, { ...launchGateOptions, ...gateOptions });
  return exec(command, argv, execOpts);
}

/** Streaming workers gate at the actual child creation callback, inside the completion primitive. */
export async function spawnFixerToCompletion(command, argv, opts = {}, io = {}) {
  assertLaunchDescriptor(opts);
  const { mode, launchGuard, launchContext, launchGateOptions, ...execOpts } = opts;
  return spawnToCompletion(command, argv, execOpts, {
    spawnFn: (cmd, args, spawnOpts) => execGuardedFixer(cmd, args, {
      ...spawnOpts, mode, launchGuard, launchContext, launchGateOptions,
    }, { exec: io.spawnFn ?? spawn, gate: io.gate }),
  });
}
