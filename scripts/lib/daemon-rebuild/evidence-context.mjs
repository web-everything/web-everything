/** Async scope keeps indirect evidence consumers on the originating child's reader policy. */
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const rebuildReaders = () => scope.getStore();
export const withRebuildReaders = (readers, run) => scope.run(readers, run);

/** Strict fleet rollout is opt-in until captured deployment evidence has been replayed.
 * Unattended launches always require strict evidence; `0` rolls ordinary ticks back. */
export const strictRebuildEvidence = (env = process.env, launchedBy = 'tick-start') =>
  env.WE_DAEMON_REBUILD_STRICT_EVIDENCE === '1' || launchedBy !== 'tick-start';
