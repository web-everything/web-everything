/**
 * @file scripts/operations/__tests__/pr-sweep-io-real.test.mjs
 * @description #2949 fidelity qualifier for `pr-sweep-io.mjs`: the two local reads it makes, proven against the
 *   real thing instead of stubs. `ps` is a REAL subprocess whose argv names a review job; the drain-log tail reads a
 *   REAL file in a temp directory (a missing file must throw, a large file must be tailed, the newest skip-reasons
 *   row must win). Isolated subprocess probes also defend zero writes by the default reader and CLI wiring.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parseDrainSkips, parseLiveJobs, tailOf } from '../pr-sweep-io.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';

async function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pr-sweep-'));
  try { return await fn({ root }); } finally { rmSync(root, { recursive: true, force: true }); }
}

const snapshot = (root) => Object.fromEntries(readdirSync(root).sort().map((name) => {
  const path = join(root, name);
  return [name, statSync(path).isDirectory() ? snapshot(path) : readFileSync(path).toString('base64')];
}));

const moduleUrl = (name) => pathToFileURL(resolve('scripts/operations', name)).href;
// The suite's tracer otherwise injects a trace-file append into children at exit. Load its no-op mode explicitly
// so the guard measures operation writes, and does not mistake the test infrastructure's trace for a product write.
const childEnv = () => ({ ...process.env, WE_TRACE_FILE: '',
  NODE_OPTIONS: `--import ${pathToFileURL(resolve('scripts/test-cache/child-tracer.mjs')).href}` });

// Run the actual modules in a fresh process with only external commands stubbed. Guard writes anywhere (including
// swallowed write failures), and snapshot cwd/HOME as a second, behavioral check. No fixture Git writes are needed.
const preload = `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const writeSync = fs.writeSync;
const forbidden = (api) => (...args) => {
  process.stderr.write('FORBIDDEN WRITE: ' + api + '\\n');
  throw new Error('write refused: ' + api);
};
for (const name of ['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'fchmod', 'fchown', 'fdatasync', 'fsync',
  'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
  'symlink', 'truncate', 'unlink', 'utimes', 'write', 'writeFile', 'writev']) {
  for (const api of [name, name + 'Sync']) if (typeof fs[api] === 'function') fs[api] = forbidden(api);
  if (typeof fs.promises[name] === 'function') fs.promises[name] = forbidden('promises.' + name);
}
fs.createWriteStream = forbidden('createWriteStream');
// stdout/stderr are the CLI's result surface. Every other file descriptor remains guarded.
fs.writeSync = (fd, ...args) => fd === 1 || fd === 2 ? writeSync(fd, ...args) : forbidden('writeSync')();
const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const readOnly = (flags) => flags === undefined || flags === 'r' || flags === 'rs'
  || typeof flags === 'number' && (flags & writeFlags) === 0;
for (const [target, api] of [[fs, 'openSync'], [fs, 'open'], [fs.promises, 'open']]) {
  const original = target[api];
  target[api] = (path, flags, ...rest) => readOnly(flags)
    ? original(path, flags, ...rest) : forbidden(api + ' ' + flags)();
}
globalThis.sweepReads = [];
const readSync = fs.readSync;
fs.readSync = (fd, buf, offset, length, position) => {
  globalThis.sweepReads.push({ length, position });
  return readSync(fd, buf, offset, length, position);
};
cp.execFileSync = (file, args) => {
  if (file === 'gh') {
    if (args[0] === 'api') return '[[]]';
    if (args.includes('commits')) return '{"commits":[]}';
    const pr = { number: 9, state: 'OPEN', title: 'fixture', labels: [], updatedAt: '2026-10-21T00:00:00Z' };
    return JSON.stringify(args[1] === 'list' ? [pr] : pr);
  }
  if (file === 'ps') return '';
  if (file === 'git') {
    if (args.includes('fetch')) return forbidden('git fetch')();
    if (args.includes('--show-toplevel') || args.includes('--absolute-git-dir')) return process.cwd();
    if (args.includes('remote')) return 'fixture-origin';
    if (args.includes('rev-list')) return '0';
    return 'a'.repeat(40);
  }
  throw new Error('unexpected subprocess: ' + file);
};
syncBuiltinESMExports();
`;

async function isolated(fn) {
  return withTempDir(async ({ root }) => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'workspace', 'plateau-app', '.drain-daemon'), { recursive: true });
    writeFileSync(join(home, 'workspace', 'plateau-app', '.drain-daemon', 'daemon.log'), 'fixture log\n');
    const hook = join(root, 'preload.mjs');
    writeFileSync(hook, preload);
    const before = snapshot(root);
    const run = (args) => spawnSync(process.execPath, ['--import', hook, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...childEnv(), HOME: home, WE_DAEMON_MANAGED_CLONE: '',
        LANE_POOL_ROOT: join(root, 'absent-pool'), WE_OPERATION_ALLOW_STALE: '',
        OPERATION_RUNS_DIR: join(root, 'runs'), WE_DAEMON_JOBS_ROOT: join(root, 'jobs') },
    });
    await fn({ run, root });
    expect(snapshot(root)).toEqual(before);
  });
}

it('the default pr-sweep reader creates or modifies no files', async () => {
  const url = moduleUrl('pr-sweep-io.mjs');
  await isolated(({ run }) => {
    const result = run(['--input-type=module', '-e', `import { createPrSweepReader } from ${JSON.stringify(url)};
      console.log(JSON.stringify(createPrSweepReader()({ repo: 'o/r' })));`]);
    expect(result.stderr).not.toContain('FORBIDDEN WRITE');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ prs: [{ number: 9 }], unreadable: [] });
  });
});

it('pr-sweep CLI creates no files', async () => {
  const entry = resolve('scripts/operations/run.mjs');
  await isolated(({ run }) => {
    const result = run([entry, 'pr-sweep', '--repo=o/r', '--pr=9', '--stalled-after=10', '--json']);
    expect(result.stderr).not.toContain('FORBIDDEN WRITE');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 1, stalledAfterMinutes: 10, unreadable: [] });
  });
});

it.each([0, 37, 10_000])('tailOf bounds disk reads for a file of %i bytes', async (size) => {
  const url = moduleUrl('pr-sweep-io.mjs');
  await withTempDir(async ({ root }) => {
    const log = join(root, 'log');
    const hook = join(root, 'preload.mjs');
    writeFileSync(log, 'x'.repeat(size));
    writeFileSync(hook, preload);
    const result = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e',
      `import { tailOf } from ${JSON.stringify(url)};
       tailOf(${JSON.stringify(log)}, 4096); console.log(JSON.stringify(globalThis.sweepReads));`], { encoding: 'utf8', timeout: 10_000, env: childEnv() });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ position: Math.max(0, size - 4096), length: Math.min(size, 4096) }]);
  });
});

it('parseLiveJobs finds a REAL running review-job process in the real `ps` output', () => {
  const child = spawn(process.execPath, ['-e', keepAliveScript({ maxLifetimeMs: 20_000 }), '--', '/x/scripts/operations/review-job.mjs', 'run', '--pr=7777', '--repo=o/r'], { stdio: 'ignore' });
  try {
    const ps = execFileSync('ps', ['-axo', 'pid,etime,command'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    expect(parseLiveJobs(ps)).toContainEqual({ kind: 'review-job', pr: 7777, repo: 'o/r', source: 'ps' });
  } finally { child.kill(); }
});

it('tailOf reads the end of a REAL log, throws for a missing one, and the newest skip row wins', async () => {
  await withTempDir(async ({ root }) => {
    const log = join(root, 'daemon.log');
    const filler = 'x'.repeat(200);
    const row = (n) => `merge-ai-prs · skip-reasons: [{"num":${n},"repo":"o/r","kind":"red-team-pending","reason":"r"}]`;
    writeFileSync(log, `${row(1)}\n${Array.from({ length: 50 }, () => filler).join('\n')}\n${row(2)}\n${filler}\n`);
    const tail = tailOf(log, 4096);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(parseDrainSkips(tail).rows.map((r) => r.num)).toEqual([2]);
    expect(() => tailOf(join(root, 'absent.log'))).toThrow(/does not exist/);
  });
});
