/** Native ESM fault-injection probe; only the supplied temporary debug file is intercepted. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { describeErrorClass } from '../../review-loop-cli.mjs';

const [path, kind, replacement] = process.argv.slice(2);
if (!path || !['race', 'non-regular', 'wrong-owner', 'stat-failure'].includes(kind)) {
  throw new Error('invalid debug-log probe arguments');
}
const actual = { open: fs.openSync, stat: fs.fstatSync, close: fs.closeSync, write: fs.writeSync };
const result = { openCalls: [], openedFd: null, statFds: [], closedFds: [], writeFds: [] };
fs.openSync = (target, ...args) => {
  if (target === path) {
    result.openCalls.push([target, ...args]);
    if (kind === 'race') fs.renameSync(replacement, path);
  }
  const fd = actual.open(target, ...args);
  if (target === path) result.openedFd = fd;
  return fd;
};
fs.fstatSync = (fd, ...args) => {
  if (fd === result.openedFd) {
    result.statFds.push(fd);
    if (kind === 'stat-failure') throw new Error('descriptor unavailable');
  }
  const st = actual.stat(fd, ...args);
  if (fd === result.openedFd) {
    if (kind === 'non-regular') st.isFile = () => false;
    if (kind === 'wrong-owner') st.uid = process.getuid() + 1;
  }
  return st;
};
fs.closeSync = (fd, ...args) => {
  if (fd === result.openedFd) result.closedFds.push(fd);
  return actual.close(fd, ...args);
};
fs.writeSync = (fd, ...args) => {
  if (fd === result.openedFd) result.writeFds.push(fd);
  return actual.write(fd, ...args);
};
// Update the real named imports used by the CLI, without Vitest's module cache.
syncBuiltinESMExports();
process.env.REVIEW_LOOP_CLI_DEBUG_LOG = path;
result.output = describeErrorClass('filing-failed', new Error('Bearer probe-secret'));
// Avoid the instrumented filesystem for the probe's own output.
process.stdout.write(JSON.stringify(result));
