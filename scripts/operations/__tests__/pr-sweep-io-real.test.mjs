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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDrainSkips, parseLiveJobs, tailOf } from '../pr-sweep-io.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

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
       // Module loading can itself call readSync; measure only the operation below.
       globalThis.sweepReads.length = 0;
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

it('tailOf reads a REAL external log without changing the checkout, throws for a missing one, and the newest skip row wins', async () => {
  await withRealRepo(async ({ tmp, root }) => {
    const log = join(tmp, 'daemon.log');
    const filler = 'x'.repeat(200);
    const row = (n) => `merge-ai-prs · skip-reasons: [{"num":${n},"repo":"o/r","kind":"red-team-pending","reason":"r"}]`;
    writeFileSync(log, `${row(1)}\n${Array.from({ length: 50 }, () => filler).join('\n')}\n${row(2)}\n${filler}\n`);
    const before = snapshot(root);
    const tail = tailOf(log, 4096);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(parseDrainSkips(tail).rows.map((r) => r.num)).toEqual([2]);
    expect(() => tailOf(join(tmp, 'absent.log'))).toThrow(/does not exist/);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('stand-down lapse enrichment in the reader', async () => {
  const { createPrSweepReader } = await import('../pr-sweep-io.mjs');
  const { assessPrSweep } = await import('../pr-sweep-core.mjs');
  const { STAND_DOWN_MARKER, buildStandDownComment } = await import('../../conveyor/stand-down.mjs');
  const { AUTOMATION_LOGINS } = await import('../../lib/marker-authorship.mjs');
  const head = 'd'.repeat(40);
  const now = Date.parse('2026-10-21T13:00:00Z');
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.stubEnv('WE_FIX_STAND_DOWN_HOLDS_ACROSS_HEADS', 'false');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const gh = (thread) => (_b, args) => {
    if (args[1] === 'list') return JSON.stringify([{ number: 7, state: 'OPEN', headRefOid: head, updatedAt: '2026-10-21T10:00:00Z', labels: [{ name: 'review:changes' }] }]);
    if (args.includes('commits')) return JSON.stringify({ commits: [{ oid: head, committedDate: '2026-10-21T12:00:00Z' }] });
    if (String(args.at(-1)).includes('/comments')) return JSON.stringify([thread]);
    return JSON.stringify([[]]);
  };
  const make = (thread, lapseContext) => createPrSweepReader({ run: gh(thread), ps: () => '', readText: () => '', settings: () => ({ prSweep: { repos: ['web-everything/web-everything'] } }), lapseContext });
  const sd = (reason, fromHead) => ({ id: 2, user: { login: AUTOMATION_LOGINS[0] }, created_at: '2026-10-21T11:00:00Z',
    body: buildStandDownComment({ reason, head: fromHead, detail: 'repair stopped' }) });
  const classified = (read) => assessPrSweep({ ...read, standDownLapse: 'off' }).prs[0];
  it.each(['e'.repeat(40), undefined])('reader annotates a stand-down lapsed on a new head (previous head %s)', (fromHead) => {
    // Even a ledger outage must not suppress a lapse proven by the commit date/head.
    const read = make([sd('gate-red', fromHead)], () => { throw new Error('ledger gone'); })({});
    expect(read.unreadable).toEqual([]);
    expect(read.prs[0].comments[0].standDownLapsed).toEqual({ fromHead: fromHead ?? null, toHead: head });
    expect(classified(read)).toMatchObject({ waitingOn: 'fixing', stalled: true });
    const held = { ...read, prs: [{ ...read.prs[0], comments: read.prs[0].comments.map(({ standDownLapsed, ...c }) => c) }] };
    expect(classified(held).waitingOn).toBe('system:fix-stood-down');
  });
  const redMainContext = () => ({
    rows: ['10:10:00', '10:20:00', '10:30:00', '10:40:00'].map((time, i) => ({
      v: 1, repo: 'we', pr: 7, head, at: `2026-10-21T${time}Z`, kind: i === 3 ? 'park' : 'fix',
      session: `repair-${i}`, reason: 'budget',
    })),
    config: { hold: true, maxSessions: 3, windowHours: 6, rearmAfterMinutes: 120, redMainDiscount: 'on',
      redMainWindows: [{ start: '2026-10-21T10:00:00Z', end: '2026-10-21T12:00:00Z' }] },
  });
  it('reader annotates a fix-loop stand-down whose attempts all ran while main was red', () => {
    const read = make([sd('fix-loop-exhausted', head)], redMainContext)({});
    expect(read.unreadable).toEqual([]);
    expect(read.prs[0].standDownLapses).toEqual([{ fromHead: head, toHead: head, reason: 'fix-loop-exhausted', lapse: 'red-main-only' }]);
    expect(read.prs[0].comments[0].standDownLapsed).toEqual({ fromHead: head, toHead: head });
    expect(classified(read)).toMatchObject({ waitingOn: 'fixing', stalled: true });
    const held = { ...read, prs: [{ ...read.prs[0], comments: read.prs[0].comments.map(({ standDownLapsed, ...c }) => c) }] };
    expect(classified(held).waitingOn).toBe('system:fix-stood-down');
  });
  it.each(['repository', 'PR', 'head', 'discount off', 'main still red', 'no park'])
  ('reader keeps a fix-loop stand-down terminal with invalid lapse evidence: %s', (variant) => {
    const context = redMainContext();
    if (variant === 'repository') context.rows.forEach((r) => { r.repo = 'plateau-app'; });
    if (variant === 'PR') context.rows.forEach((r) => { r.pr = 8; });
    if (variant === 'head') context.rows.forEach((r) => { r.head = 'e'.repeat(40); });
    if (variant === 'discount off') context.config.redMainDiscount = 'off';
    if (variant === 'main still red') context.config.redMainWindows[0].end = null;
    if (variant === 'no park') context.rows = context.rows.filter((r) => r.kind !== 'park');
    const read = make([sd('fix-loop-exhausted', head)], () => context)({});
    expect(read.prs[0].comments[0].standDownLapsed).toBeUndefined();
    expect(classified(read)).toMatchObject({ waitingOn: 'system:fix-stood-down', stalled: true });
  });
  it('keeps the comment url and reads the ledger only for a thread with a stand-down', () => {
    let reads = 0;
    const plain = make([{ id: 1, html_url: 'https://x/1', user: { login: 'a' }, body: 'hi', created_at: '2026-10-21T11:00:00Z' }], () => { reads += 1; return { rows: [], config: {} }; })({});
    expect(plain.prs[0].comments[0].url).toBe('https://x/1'); expect(reads).toBe(0);
    const sd = { id: 2, html_url: 'https://x/2', user: { login: AUTOMATION_LOGINS[0] }, created_at: '2026-10-21T11:00:00Z', body: `${STAND_DOWN_MARKER}\n\nx stopped rather than guessing: y.\n<!-- stand-down reason=gate-red -->` };
    const out = make([sd], () => { reads += 1; throw new Error('ledger gone'); })({});
    expect(reads).toBe(1); expect(out.prs).toHaveLength(1);
  });
});

describe('ps job start times', async () => {
  const { parseLiveJobs, etimeSeconds } = await import('../pr-sweep-io.mjs');
  it('reads etime into a start time', () => {
    expect(etimeSeconds('01:02')).toBe(62); expect(etimeSeconds('1-02:03:04')).toBe(((24 + 2) * 60 + 3) * 60 + 4); expect(etimeSeconds('x')).toBeNull();
    const [j] = parseLiveJobs(' 123 01:00:00 node scripts/conveyor/fix-run.mjs --pr=5 --repo=a/b', 10_000_000);
    expect(j).toMatchObject({ kind: 'fix-run', pr: 5, startedAt: 10_000_000 - 3_600_000 });
  });
});
