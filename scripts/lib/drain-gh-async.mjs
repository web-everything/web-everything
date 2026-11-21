/** Async drain reads run the sync throttle in a worker so its budgets and child timeout still apply. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const worker = fileURLToPath(import.meta.url);
export function execDrainAsync(file, args, options = {}) {
  // Test CLI fixtures supply a fake gh on PATH. Keep that seam hermetic even when the host's shim
  // exports a real-binary override; they still execute the throttle, with the fake as its subprocess.
  const env = options.env ?? process.env;
  const testOptions = env.VITEST || env.WE_UNDER_TEST
    ? { env: { ...env, WE_GH_THROTTLE_GH_BIN: 'gh' } } : {};
  if (file !== 'gh') return exec(file, args, options);
  const { timeout, killSignal: _requestedSignal, ...wrapperOptions } = options;
  // spawnSync waits for gh to exit even after its timeout signal. A catchable signal can
  // hang forever; drain reads therefore always use a hard kill at the child deadline.
  // Leave the worker alive to reap gh and release its throttle slot before rejecting.
  return exec(process.execPath, [worker, JSON.stringify({ timeout, killSignal: 'SIGKILL' }), ...args], {
    maxBuffer: 64 * 1024 * 1024, ...wrapperOptions, ...testOptions,
  });
}

// Keep the worker alive until runGhSync kills/reaps gh and releases its slot in finally.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { runGhSync } = await import('./gh-throttle.mjs');
    const output = runGhSync(process.argv.slice(3), {
      ...JSON.parse(process.argv[2]), maxBuffer: 64 * 1024 * 1024,
      stdio: ['inherit', 'pipe', 'pipe'],
      // Gate evidence (required checks, rollups) must be live: never serve it from the read memo.
      throttle: { caller: 'merge-ai-prs.mjs', bin: process.env.WE_GH_THROTTLE_GH_BIN || 'gh',
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WE_GH_READ_MEMO_DIR')) },
    });
    process.stdout.write(output);
  } catch (error) {
    if (error.stderr?.length) process.stderr.write(error.stderr);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status || 1;
  }
}
