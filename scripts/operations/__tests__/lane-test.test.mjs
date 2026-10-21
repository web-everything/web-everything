/** @file scripts/operations/__tests__/lane-test.test.mjs
 * @description Fake-backed admission, checkout safety and summary regressions. */
import { expect, it, vi } from 'vitest';
import { planLaneTest, summarizeVitest, LANE_TEST_EFFECT } from '../lane-test.mjs';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { depsReady, ensureDeps } from '../../lib/lane-pool-deps.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLaneTestSinks, boundedSpawn } from '../lane-test-io.mjs';
import { runLaneTestCli } from '../lane-test-cli.mjs';

const sha = 'a'.repeat(40);
const pass = '\x1b[32m Test Files  2 passed (2)\x1b[0m\n      Tests  6 passed (6)\n';
const fail = '\x1b[31m FAIL  scripts/a.test.mjs > broken\x1b[0m\n FAIL  scripts/a.test.mjs > again\n FAIL  scripts/b.test.mjs\n Test Files  2 failed | 1 passed (3)\n      Tests  2 failed | 6 passed | 1 skipped (9)';
function setup(codes = [0], { mismatch = false, missing = false, throwRun = false, output = pass, lockDiff = 0, depsStatus = 0 } = {}) {
  const sleep = vi.fn(), spawn = vi.fn(async (cmd, args) => {
    if (args.includes('acquire')) return { status: 0, stdout: JSON.stringify({ lane: 7, path: '/tmp/test-lane', holder: 'holder' }) };
    if (args.includes('status')) return { status: 0, stdout: JSON.stringify({ lanes: [{ lane: 7, lease: null }] }) };
    if (args.includes('diff')) return { status: lockDiff };
    if (args.some(a => a.endsWith('/lane-pool-deps.mjs'))) return { status: depsStatus };
    if (args.includes('cat-file')) return { status: missing ? 1 : 0 };
    if (args.includes('rev-parse')) return { status: 0, stdout: args.includes('HEAD') && mismatch ? 'b'.repeat(40) : sha };
    if (args.includes('vitest')) {
      if (throwRun) throw new Error('spawn failed');
      const status = codes.shift();
      return { status, output, admitted: status !== 75 };
    }
    return { status: 0, stdout: '' };
  });
  return { spawn, sleep, sinks: createLaneTestSinks({ spawn, sleep }) };
}
const argv = ['--ref=main', '--files=scripts/a.test.mjs'];
it('parses ANSI pass and fail summaries and unique failed files', () => {
  expect(summarizeVitest(pass)).toEqual({ testFiles: { passed: 2, failed: 0, total: 2 }, tests: { passed: 6, failed: 0, total: 6 }, failedFiles: [] });
  expect(summarizeVitest(fail)).toEqual({ testFiles: { passed: 1, failed: 2, total: 3 }, tests: { passed: 6, failed: 2, total: 9 }, failedFiles: ['scripts/a.test.mjs', 'scripts/b.test.mjs'] });
});
it.each([{ codes: [75, 0] }, { codes: [75, 75, 75] }, { codes: [42] }])('preserves status and admission and releases: $codes', async ({ codes }) => {
  const attempts = codes.length, exitCode = codes.at(-1), { spawn, sleep, sinks } = setup([...codes]);
  const result = await runLaneTestCli([...argv, '--json', '--retryWaitSec=2'], sinks);
  expect(result.code).toBe(exitCode === 42 ? 1 : exitCode);
  expect(JSON.parse(result.lines[0])).toMatchObject({ sha, lane: 7, attempts, exitCode, signal: null, admitted: exitCode !== 75 });
  expect(sleep).toHaveBeenCalledTimes(attempts - 1);
  if (attempts > 1) expect(sleep.mock.calls[0][0]).toBe(2000);
  const calls = spawn.mock.calls;
  expect(calls.find(c => c[1].includes('reset'))[2].env.LANE_SESSION).toBe('holder');
  expect(calls.find(c => c[1].includes('release'))[1]).toEqual(expect.arrayContaining(['release', '--lane=7', '--session=holder']));
  expect(calls.at(-1)[1]).toEqual(expect.arrayContaining(['status', '--lane=7', '--json']));
  expect(calls.findIndex(c => c[1].includes('HEAD'))).toBeLessThan(calls.findIndex(c => c[1].includes('vitest')));
});
it('refuses a HEAD mismatch without running Vitest, and releases', async () => {
  const { spawn, sinks } = setup([], { mismatch: true });
  expect((await runLaneTestCli(argv, sinks)).code).toBe(2);
  expect(spawn.mock.calls.some(c => c[1].includes('vitest'))).toBe(false);
  expect(spawn.mock.calls.find(c => c[1].includes('release'))[1]).toContain('--session=holder');
});
it.each(['../a.test.mjs', '/tmp/a.test.mjs', 'a;pwd', 'a$(pwd)', '-x', 'C:\\a', ', ,', ''])('refuses unsafe files at plan: %s', files => expect(() => planLaneTest({ ref: 'main', files })).toThrow());
it.each([0, 1, 'throw', 'valid-failure'])('cleans up unsuccessful acquisition (%s)', async status => {
  const spawn = vi.fn(async (_, args) => {
    if (args.includes('acquire')) {
      if (status === 'throw') throw Error('lost receipt');
      return status === 'valid-failure' ? { status: 1, stdout: JSON.stringify({ lane: 7, path: '/tmp/test-lane', holder: 'holder' }) } : { status, stdout: '{' };
    }
    return { status: 0, stdout: JSON.stringify({ lanes: [{ lane: 7, lease: null }] }) };
  });
  await expect(createLaneTestSinks({ spawn })[LANE_TEST_EFFECT](planLaneTest({ ref: 'main', files: 'a' }))).rejects.toThrow();
  const acquire = spawn.mock.calls[0][1], release = spawn.mock.calls.find(c => c[1].includes('release'))[1];
  expect(release).toEqual(expect.arrayContaining(status === 'valid-failure' ? ['release', '--lane=7', '--session=holder'] : ['release', '--all', acquire.find(a => a.startsWith('--session='))]));
  expect(release.some(a => a.includes('force'))).toBe(false);
});
it.each([0, 1, 'throw'])('reports release failure separately from the primary outcome (%s)', async status => {
  const { spawn } = setup([status], { throwRun: status === 'throw' }), log = vi.fn(), original = spawn.getMockImplementation();
  spawn.mockImplementation((cmd, args, opts) => args.includes('release') ? (status === 'throw' ? Promise.reject(Error('release broke')) : { status: 1 }) : original(cmd, args, opts));
  const sinks = createLaneTestSinks({ spawn, log });
  if (status === 'throw') await expect(sinks[LANE_TEST_EFFECT](planLaneTest({ ref: 'main', files: 'a' }))).rejects.toThrow('spawn failed');
  else {
    const outcome = await runLaneTestCli([...argv, '--json'], sinks);
    expect(outcome.code).toBe(3);
    expect(JSON.parse(outcome.lines[0])).toMatchObject({ exitCode: status, summary: summarizeVitest(pass), cleanupError: expect.stringContaining('--session=holder') });
  }
  expect(log).toHaveBeenCalledWith(expect.stringContaining('--lane=7'));
});
it('resolves hexadecimal branch names via FETCH_HEAD and refuses missing abbreviated IDs', async () => {
  const { spawn, sinks } = setup();
  await sinks[LANE_TEST_EFFECT](planLaneTest({ ref: 'deadbee', files: 'a' }));
  expect(spawn.mock.calls.find(c => c[1].includes('--verify'))[1]).toContain('FETCH_HEAD^{commit}');
  const absent = setup([0], { missing: true });
  await absent.sinks[LANE_TEST_EFFECT](planLaneTest({ ref: sha, files: 'a' }));
  expect(absent.spawn.mock.calls.some(c => c[1].join(' ') === 'fetch origin main')).toBe(true);
  expect(absent.spawn.mock.calls.find(c => c[1].includes('--verify'))[1]).toContain(`${sha}^{commit}`);
  expect(spawn.mock.calls.some(c => c[1].includes('cat-file'))).toBe(false);
  const original = spawn.getMockImplementation();
  spawn.mockImplementation((cmd, args, opts) => args.includes('fetch') ? { status: 1 } : original(cmd, args, opts));
  await expect(sinks[LANE_TEST_EFFECT](planLaneTest({ ref: 'deadbee', files: 'a' }))).rejects.toThrow('full 40-character SHA');
});
it.each([['acquire', 'SIGINT', 130], ['vitest', 'SIGTERM', 143], ['sleep', 'SIGHUP', 129]])('defers cancellation during %s until release', async (phase, signal, code) => {
  const proc = new EventEmitter(), { spawn } = setup([75]), original = spawn.getMockImplementation(), order = [];
  spawn.mockImplementation(async (cmd, args, opts) => {
    if (args.includes(phase)) { const child = { kill: vi.fn() }; opts.cancellation.child = child; proc.emit(signal); expect(child.kill).toHaveBeenCalledWith(signal); opts.cancellation.child = null; order.push('stopped'); }
    if (args.includes('release')) order.push('release');
    return original(cmd, args, opts);
  });
  const sleep = async (_, c) => { proc.emit(signal); expect(c.abort.signal.aborted).toBe(true); order.push('stopped'); };
  const outcome = await runLaneTestCli([...argv, '--json'], createLaneTestSinks({ spawn, sleep, proc }));
  expect(outcome.code).toBe(code);
  expect(JSON.parse(outcome.lines[0])).toMatchObject({ signal, exitCode: code });
  expect(order).toEqual(['stopped', 'release']);
  expect(proc.listenerCount(signal)).toBe(0);
});
it('retains real child signals, unknown admission, and streaming UTF-8 within the byte bound', async () => {
  const killed = await boundedSpawn(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
  expect(killed).toMatchObject({ status: 143, signal: 'SIGTERM', admitted: null });
  const unicode = await boundedSpawn(process.execPath, ['-e', "const b=Buffer.from('😀'.repeat(60000)); for(let i=0;i<b.length;i+=101)process.stdout.write(b.subarray(i,i+101));"]);
  expect(unicode.output).not.toContain('�');
  expect(unicode.admitted).toBeNull();
  expect((await boundedSpawn(process.execPath, ['-e', "console.error('heavy-command admission: acquired slot-1 after waiting 1ms (cap=3).')"])).admitted).toBe(true);
  expect((await boundedSpawn(process.execPath, ['-e', "console.error('heavy-command admission deferred: busy'); process.exitCode=75"]))).toMatchObject({ status: 75, signal: null, admitted: false });
  expect(Buffer.byteLength(unicode.output)).toBeLessThanOrEqual(200 * 1024);
  const { spawn } = setup(), original = spawn.getMockImplementation();
  spawn.mockImplementation((cmd, args, opts) => args.includes('vitest') ? killed : original(cmd, args, opts));
  const result = await runLaneTestCli([...argv, '--json'], createLaneTestSinks({ spawn }));
  expect(result.code).toBe(143);
  expect(JSON.parse(result.lines[0])).toMatchObject({ admitted: null, signal: 'SIGTERM' });
});
it('drains surviving lane-using descendants before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lane-test-')), marker = join(dir, 'stopped');
  try {
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 150)`;
    const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); process.kill(process.pid, 'SIGTERM')`;
    expect((await boundedSpawn(process.execPath, ['-e', leader])).signal).toBe('SIGTERM');
    expect(await readFile(marker, 'utf8')).toBe('done');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  ['retained holder', 0, { lanes: [{ lane: 7, lease: { holder: 'holder', session: 'original-session' }, leased: false }] }],
  ['retained session', 0, { lanes: [{ lane: 7, lease: { session: 'holder' } }] }],
  ['unreadable marker', 0, { lanes: [{ lane: 7, lease: null, readError: 'bad marker' }] }],
  ['missing lane', 0, { lanes: [] }],
  ['invalid shape', 0, {}],
  ['missing lease field', 0, { lanes: [{ lane: 7 }] }],
  ['malformed JSON', 0, '{'],
  ['failed status', 1, { lanes: [{ lane: 7, lease: null }] }],
])('refuses CLI success when release verification fails: %s', async (_, status, snapshot) => {
  const { spawn } = setup(), original = spawn.getMockImplementation();
  spawn.mockImplementation((cmd, args, opts) => args.includes('status')
    ? { status, stdout: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot) } : original(cmd, args, opts));
  const outcome = await runLaneTestCli([...argv, '--json'], createLaneTestSinks({ spawn, log: vi.fn() }));
  expect(outcome.code).toBe(3);
  expect(JSON.parse(outcome.lines[0])).toMatchObject({ exitCode: 0, cleanupError: expect.stringContaining('--session=holder') });
});
it('accepts a different holder acquiring the lane after release', async () => {
  const { spawn } = setup(), original = spawn.getMockImplementation();
  spawn.mockImplementation((cmd, args, opts) => args.includes('status')
    ? { status: 0, stdout: JSON.stringify({ lanes: [{ lane: 7, lease: { holder: 'new-holder', session: 'new-session' } }] }) } : original(cmd, args, opts));
  expect((await runLaneTestCli(argv, createLaneTestSinks({ spawn }))).code).toBe(0);
});
it.each([0, 1])('prepares target dependencies only when the lockfile differs (%s)', async lockDiff => {
  const { spawn, sinks } = setup([0], { lockDiff });
  expect((await runLaneTestCli(argv, sinks)).code).toBe(0);
  const calls = spawn.mock.calls, diff = calls.find(c => c[1].includes('diff'));
  expect(diff[1]).toEqual(['diff', '--quiet', 'origin/main', sha, '--', 'package-lock.json']);
  expect(diff[2]).toMatchObject({ cwd: '/tmp/test-lane', env: { LANE_SESSION: 'holder' } });
  const depsIndex = calls.findIndex(c => c[1].some(a => a.endsWith('/lane-pool-deps.mjs')));
  if (lockDiff === 0) expect(depsIndex).toBe(-1);
  else {
    expect(depsIndex).toBeGreaterThan(calls.findIndex(c => c[1].includes('HEAD')));
    expect(depsIndex).toBeLessThan(calls.findIndex(c => c[1].includes('vitest')));
    expect(calls[depsIndex][2]).toMatchObject({ cwd: '/tmp/test-lane', env: { LANE_SESSION: 'holder' } });
  }
});
it.each([{ lockDiff: 2 }, { lockDiff: 1, depsStatus: 1 }])('refuses tests and releases when dependency reconciliation fails: %j', async options => {
  const { spawn, sinks } = setup([0], options);
  expect((await runLaneTestCli(argv, sinks)).code).toBe(2);
  expect(spawn.mock.calls.some(c => c[1].includes('vitest'))).toBe(false);
  expect(spawn.mock.calls.find(c => c[1].includes('release'))[1]).toContain('--session=holder');
});
it('reuses the pool dependency hash, install policy and success marker for target locks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lane-test-deps-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package-lock.json'), 'main lock');
    const run = vi.fn(() => mkdirSync(join(dir, 'node_modules'), { recursive: true })), log = vi.fn();
    expect(ensureDeps(dir, { run, log })).toBe('installed');
    expect(depsReady(dir)).toBe('ok');
    expect(ensureDeps(dir, { run, log })).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    const oldMarker = await readFile(join(dir, '.git/.lane-pool-deps'), 'utf8');
    writeFileSync(join(dir, 'package-lock.json'), 'target lock');
    expect(depsReady(dir)).toBe('stale');
    expect(() => ensureDeps(dir, { run: () => { throw Error('install failed'); }, log })).toThrow('install failed');
    expect(await readFile(join(dir, '.git/.lane-pool-deps'), 'utf8')).toBe(oldMarker);
    expect(ensureDeps(dir, { run, log })).toBe('installed');
    expect(depsReady(dir)).toBe('ok');
    expect(await readFile(join(dir, '.git/.lane-pool-deps'), 'utf8')).not.toBe(oldMarker);
    expect(run.mock.calls[1]).toEqual(['npm', ['ci'], expect.objectContaining({ cwd: dir, stdio: ['inherit', 2, 'inherit'], killSignal: 'SIGKILL' })]);
    expect(existsSync(join(dir, 'node_modules'))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
