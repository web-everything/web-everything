/** Async scope keeps indirect evidence consumers on the originating child's reader policy. */
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const rebuildReaders = () => scope.getStore();
export const withRebuildReaders = (readers, run) => scope.run(readers, run);
