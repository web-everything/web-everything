/**
 * @file bounded-child.test.mjs — `runBounded` times out and kills the whole tree; `installChildReaper` kills
 * children when their parent is orphaned (#x7xv2xt). Real processes, all short-lived, all cleaned up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { keepAliveScript } from '../test-keepalive.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  runBounded, summarizeStderr, resolveChildTimeoutMs, DEFAULT_CHILD_TIMEOUT_MS, CHILD_TIMEOUT_ENV,
} from '../bounded-child.mjs';

const LIB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'bounded-child.mjs')).href;
const NODE = process.execPath;
const SHIM_WARNING = 'gh-shim: GitHub App role "worker" unavailable (worker: no fresh token cached) - using the legacy App for this call';
const THROTTLE_ERROR = 'gh-throttle: GitHub core API rate limit exceeded for this identity — shared backoff until 2026-10-18T12:00:00Z, call not sent';

describe('summarizeStderr', () => {
  it('puts the real error first while retaining the skipped shim warning', () => {
    expect(summarizeStderr(`${SHIM_WARNING}\n${THROTTLE_ERROR}\n`))
      .toBe(`${THROTTLE_ERROR} [warning: ${SHIM_WARNING}]`);
  });

  it('skips multiple shim warnings and retains the first warning', () => {
    expect(summarizeStderr(`${SHIM_WARNING}\ngh-shim: using personal auth for this call\n${THROTTLE_ERROR}\n`))
      .toBe(`${THROTTLE_ERROR} [warning: ${SHIM_WARNING}]`);
  });

  it('keeps the first line when stderr contains only shim warnings', () => {
    expect(summarizeStderr(`${SHIM_WARNING}\n`)).toBe(SHIM_WARNING);
    expect(summarizeStderr(`${SHIM_WARNING}\ngh-shim: no GitHub App installation is configured\n`)).toBe(SHIM_WARNING);
  });

  it('preserves a normal first error line', () => {
    expect(summarizeStderr(`boom\n${SHIM_WARNING}\nmore\n`)).toBe('boom');
  });

  it('preserves the empty-stderr fallback', () => {
    expect(summarizeStderr('')).toBe('(no stderr)');
    expect(summarizeStderr(' \n\t')).toBe('(no stderr)');
  });
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return pred();
};

let dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bounded-child-')); dirs.push(d); return d; };
const leftover = [];
afterEach(() => {
  for (const pid of leftover.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveChildTimeoutMs', () => {
  it('uses a positive integer from env, else the default', () => {
    expect(resolveChildTimeoutMs({ [CHILD_TIMEOUT_ENV]: '1500' })).toBe(1500);
    expect(resolveChildTimeoutMs({ [CHILD_TIMEOUT_ENV]: '0' })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
    expect(resolveChildTimeoutMs({ [CHILD_TIMEOUT_ENV]: 'soon' })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
    expect(resolveChildTimeoutMs({})).toBe(DEFAULT_CHILD_TIMEOUT_MS);
  });
});

describe('runBounded', () => {
  it('resolves the child stdout', async () => {
    await expect(runBounded(NODE, ['-e', 'process.stdout.write(JSON.stringify({ok:1}))'])).resolves.toBe('{"ok":1}');
  });

  it('rejects a non-zero exit with the first stderr line', async () => {
    await expect(runBounded(NODE, ['-e', 'console.error("boom\\nmore"); process.exit(3)'])).rejects.toThrow(/exited 3: boom/);
  });

  it.each([
    [`${SHIM_WARNING}\n${THROTTLE_ERROR}\n`, `exited 1: ${THROTTLE_ERROR} [warning: ${SHIM_WARNING}]`],
    [`${SHIM_WARNING}\n`, `exited 1: ${SHIM_WARNING}`],
    ['boom\nmore\n', 'exited 1: boom'],
  ])('rejects exit 1 with the expected stderr summary for %s', async (stderr, message) => {
    const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`;
    await expect(runBounded(NODE, ['-e', script])).rejects.toMatchObject({ message, stderr, status: 1 });
  });

  it('on timeout kills the child AND the processes it started', async () => {
    const d = tmp();
    const pidFile = join(d, 'grandchild.pid');
    // The child starts a long-lived grandchild, records its pid, then hangs.
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript({ maxLifetimeMs: 60_000 }))}], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      ${keepAliveScript({ maxLifetimeMs: 60_000 })}
    `;
    const started = Date.now();
    await expect(runBounded(NODE, ['-e', script], { timeoutMs: 1500 })).rejects.toThrow(/timed out after 1500ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    leftover.push(grandchild);
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 20_000);

  // #x5n4zn3 — several call sites this function's rollout replaces relied on `execFileSync`'s `maxBuffer` to
  // cap a verbose-but-not-hung child; `maxBytes` is the same protection for the async primitive, and must not
  // regress that safety net when they switch over.
  it('on maxBytes overflow kills the child and rejects, without waiting for the timeout', async () => {
    const started = Date.now();
    await expect(
      runBounded(NODE, ['-e', keepAliveScript({ prelude: 'process.stdout.write("x".repeat(1000));', maxLifetimeMs: 60_000 })], { timeoutMs: 20_000, maxBytes: 100 }),
    ).rejects.toThrow(/output exceeded 100 bytes/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  // #x5n4zn3 review — `maxBytes` must count real UTF-8 BYTES (what `execFileSync`'s `maxBuffer` counted), not JS
  // string length: 'é' is 1 UTF-16 code unit but 2 bytes, '😀' is 2 code units but 4 bytes.
  it('maxBytes counts UTF-8 bytes, not string length, on a multi-byte payload', async () => {
    await expect(
      runBounded(NODE, ['-e', "process.stdout.write('é'.repeat(100))"], { timeoutMs: 20_000, maxBytes: 150 }),
    ).rejects.toThrow(/output exceeded 150 bytes/);
    await expect(
      runBounded(NODE, ['-e', "process.stdout.write('😀'.repeat(50))"], { timeoutMs: 20_000, maxBytes: 150 }),
    ).rejects.toThrow(/output exceeded 150 bytes/);
    // Exactly at the cap is allowed, and the multi-byte payload still decodes intact.
    const out = await runBounded(NODE, ['-e', "process.stdout.write('é'.repeat(75))"], { timeoutMs: 20_000, maxBytes: 150 });
    expect(out).toBe('é'.repeat(75));
  }, 20_000);

  it('omitting maxBytes keeps unbounded output (today\'s default, unchanged)', async () => {
    // The big string is built INSIDE the child (never passed as a literal argv value) — a 500KB argv string blew
    // past `ARG_MAX` on a CI runner (`spawn E2BIG`) even though it fit fine locally; `repeat` in-process has no
    // such ceiling.
    const out = await runBounded(NODE, ['-e', "process.stdout.write('y'.repeat(500000))"]);
    expect(out).toHaveLength(500_000);
    expect(out).toBe('y'.repeat(500_000));
  });
});

describe('installChildReaper', () => {
  it('kills running children when the parent process is orphaned', async () => {
    const d = tmp();
    const childPidFile = join(d, 'child.pid');
    const reaperPidFile = join(d, 'reaper.pid');
    // B: installs the reaper, then runs a long child through runBounded and records the child's pid.
    const reaper = join(d, 'reaper.mjs');
    writeFileSync(reaper, `
      import { writeFileSync } from 'node:fs';
      import { runBounded, installChildReaper } from ${JSON.stringify(LIB)};
      installChildReaper({ pollMs: 100 });
      writeFileSync(${JSON.stringify(reaperPidFile)}, String(process.pid));
      runBounded(process.execPath, ['-e', ${JSON.stringify(keepAliveScript({ prelude: `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`, maxLifetimeMs: 60_000 }))}], { timeoutMs: 60000 }).catch(() => {});
    `);
    // A: the parent that will die. It starts B and waits.
    const a = spawn(NODE, ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(reaper)}], { stdio: 'ignore' }); ${keepAliveScript({ maxLifetimeMs: 60_000 })}`], { stdio: 'ignore' });
    leftover.push(a.pid);
    expect(await waitFor(() => existsSync(childPidFile) && existsSync(reaperPidFile), 10_000)).toBe(true);
    const child = Number(readFileSync(childPidFile, 'utf8'));
    const reaperPid = Number(readFileSync(reaperPidFile, 'utf8'));
    leftover.push(child, reaperPid);
    expect(alive(child)).toBe(true);

    process.kill(a.pid, 'SIGKILL'); // B is now orphaned — exactly the vitest-died shape

    expect(await waitFor(() => !alive(child) && !alive(reaperPid))).toBe(true);
  }, 20_000);
});

// The next error boundary must receive the full diagnostic, not only its first line.
it('preserves multiline stderr and exit status for the tick/daemon logger', async () => {
  await expect(runBounded(NODE, ['-e', 'console.error("heading\\nactual root cause"); process.exit(3)']))
    .rejects.toMatchObject({ stderr: 'heading\nactual root cause\n', status: 3 });
});

it('preserves failing stdout for load-flake reverify summaries', async () => {
  await expect(runBounded(NODE, ['-e', 'console.log("failing test detail"); console.error("gate red"); process.exitCode = 1'], { timeoutMs: 5000 }))
    .rejects.toMatchObject({ stdout: 'failing test detail\n', stderr: 'gate red\n', status: 1 });
});
