/**
 * @file scripts/lib/run-cli-batch.cjs
 * @description Run a build-time child process WITHOUT buffering its output through spawnSync's pipe
 *   `maxBuffer` (which fails with `spawnSync node ENOBUFS` once the batch envelope grows). stdin is fed
 *   from a temp file, stdout goes to a temp file that is read back after exit, and stderr is inherited
 *   (streamed to the build log, never buffered). No size ceiling other than disk.
 *
 *   Drop-in default for the `runner` seam of the SSR build hooks: `(cmd, args, { input }) => string`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Generous explicit ceiling on the child's stdout (read back into memory); exceeding it is a typed error. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Typed failure so callers/CI can tell a child failure from a parse failure. */
class CliBatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CliBatchError';
    this.code = 'E_CLI_BATCH';
    Object.assign(this, details);
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 * @returns {string} the child's full stdout (utf8)
 */
function runCliToFile(cmd, args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-cli-batch-'));
  const inPath = path.join(dir, 'stdin.json');
  const outPath = path.join(dir, 'stdout.out');
  let inFd;
  let outFd;
  try {
    fs.writeFileSync(inPath, opts.input == null ? '' : String(opts.input));
    inFd = fs.openSync(inPath, 'r');
    outFd = fs.openSync(outPath, 'w');
    const res = spawnSync(cmd, args, { stdio: [inFd, outFd, 'inherit'] });
    if (res.error) {
      throw new CliBatchError(`[cli-batch] failed to run ${cmd}: ${res.error.message}`, { cause: res.error });
    }
    if (res.status !== 0) {
      throw new CliBatchError(
        `[cli-batch] ${cmd} exited with ${res.signal ? `signal ${res.signal}` : `status ${res.status}`}`,
        { status: res.status, signal: res.signal },
      );
    }
    fs.closeSync(outFd);
    outFd = undefined;
    const size = fs.statSync(outPath).size;
    if (size > MAX_OUTPUT_BYTES) {
      throw new CliBatchError(
        `[cli-batch] ${cmd} wrote ${size} bytes of stdout, over the ${MAX_OUTPUT_BYTES}-byte limit (MAX_OUTPUT_BYTES)`,
        { size, limit: MAX_OUTPUT_BYTES },
      );
    }
    return fs.readFileSync(outPath, 'utf8');
  } finally {
    if (inFd !== undefined) fs.closeSync(inFd);
    if (outFd !== undefined) fs.closeSync(outFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCliToFile, CliBatchError, MAX_OUTPUT_BYTES };
