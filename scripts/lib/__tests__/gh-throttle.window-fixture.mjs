// Historical slot, retry, output and fixed-window tests require immediate admission
// from absent state. Pin that contract explicitly; bucket defaults have their own suite.
import * as gh from '../gh-throttle.mjs';
export * from '../gh-throttle.mjs';
const windowOptions = (opts = {}) => ({ ...opts, throttle: { pointsAlgorithm: 'window', ...opts.throttle } });
export const acquireGhPointsSync = opts => gh.acquireGhPointsSync({ pointsAlgorithm: 'window', ...opts });
export const runGhSync = (args, opts) => gh.runGhSync(args, windowOptions(opts));
export const runGhCliPassthrough = (args, opts) => gh.runGhCliPassthrough(args, windowOptions(opts));
export const execFileSyncThrottled = (file, args, opts) => gh.execFileSyncThrottled(file, args, windowOptions(opts));
