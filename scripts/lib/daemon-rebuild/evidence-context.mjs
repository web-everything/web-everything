/** Async scope keeps indirect evidence consumers on the originating child's reader policy. */
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const rebuildReaders = () => scope.getStore();
export const withRebuildReaders = (readers, run) => scope.run(readers, run);

/** Emergency compatibility rollback affects ordinary ticks only, never unattended launches. */
export const strictRebuildEvidence = (env = process.env, launchedBy = 'tick-start') =>
  env.WE_DAEMON_REBUILD_STRICT_EVIDENCE !== '0' || launchedBy !== 'tick-start';
