/** Async drain reads use the existing throttle CLI so its host-wide budgets still apply. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const throttle = join(dirname(fileURLToPath(import.meta.url)), 'gh-throttle.mjs');
export function execDrainAsync(file, args, options = {}) {
  // Test CLI fixtures supply a fake gh on PATH. Keep that seam hermetic even when the host's shim
  // exports a real-binary override; they still execute the throttle, with the fake as its subprocess.
  const env = options.env ?? process.env;
  const testOptions = env.VITEST || env.WE_UNDER_TEST
    ? { env: { ...env, WE_GH_THROTTLE_GH_BIN: 'gh' } } : {};
  return file === 'gh'
    ? exec(process.execPath, [throttle, ...args], { maxBuffer: 64 * 1024 * 1024, ...options, ...testOptions })
    : exec(file, args, options);
}
