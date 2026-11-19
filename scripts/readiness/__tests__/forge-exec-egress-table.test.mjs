// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRunner, digestInput, digestArgv, execute, cliFailure} from '../forge-exec-run.mjs';
import * as manifestAPI from '../forge-exec-run.mjs';
import {keepAliveScript} from '../../lib/test-keepalive.mjs';
const children = vi.hoisted(() => []);
// When set, a spawn of the production nft path is replaced by a child exiting with this code
// (the original file/argv are still recorded), so the production probe is observable and hermetic.
const nftStub = vi.hoisted(() => ({code: undefined}));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  return {...original, spawn: (...args) => {
    const [file, argv] = args;
    const stubbed = file === '/usr/sbin/nft' && nftStub.code !== undefined;
    const child = stubbed
      ? original.spawn(process.execPath, ['-e', `process.exit(${nftStub.code})`], args[2])
      : original.spawn(...args);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    children.push({child, closed, file, argv});
    return child;
  }};
});
// R595 S1 / xq2mydd: the launcher checks nft table inet forge_exec_egress before EVERY run
// (prepare and run) and refuses with `egress-table-absent`; only a zero exit passes.
const hash = data => createHash('sha256').update(data).digest('hex');
const argv = ['npm','run','test:unit','--','x'];
const nonce = 'c'.repeat(32);
let root, bin, probeCalls, probeResult;
const probe = async () => { probeCalls++; return typeof probeResult === 'function' ? probeResult() : probeResult; };
const makeRunner = () => createRunner({testRoot: root, testPath: bin + ':/usr/bin:/bin', testEgressProbe: probe});
async function requestFor(runner) {
  const prepared = await runner.prepare({nonce, label: 'abcdef-1'});
  const work = join(root, 'runs', prepared.run, 'work');
  await writeFile(join(work, 'package-lock.json'), 'lock');
  const entries = [{path: Buffer.from('package-lock.json'), sha256: hash('lock'), executable: false}];
  const manifest = manifestAPI.manifestWire({entries, excluded: []});
  return {nonce, run: prepared.run, argv, env: {CI: 'true'}, lock: hash('lock'), manifest,
    manifestDigest: hash(JSON.stringify(manifest)), inputDigest: await digestInput(work), argvDigest: digestArgv(argv)};
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.TMPDIR, 'forge-egress-')));
  bin = join(root, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(bin, 'npm'), `#!/bin/bash\necho ran >> '${root}/npm.log'\nmkdir -p node_modules\nexit 0\n`, {mode: 0o755});
  probeCalls = 0;
  probeResult = {code: 0};
  nftStub.code = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  nftStub.code = undefined;
  for (const {child} of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.splice(0).map(({closed}) => closed));
  await rm(root, {recursive: true, force: true});
});
const ran = () => readFile(join(root, 'npm.log'), 'utf8').then(() => true, () => false);

describe('egress table readiness', () => {
  it.each([
    ['absent table', () => ({code: 1})],
    ['nonzero exit', () => ({code: 2})],
    ['missing nft', () => { throw Object.assign(new Error('spawn'), {code: 'ENOENT'}); }],
  ])('production probe argv and timeout: rejects %s', async (_name, result) => {
    const testExecute = vi.fn(result);
    const runner = createRunner({testRoot: root, testPath: bin + ':/usr/bin:/bin', testExecute});
    await expect(runner.prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code: 'egress-table-absent'});
    expect(testExecute).toHaveBeenCalledTimes(1);
    expect(testExecute).toHaveBeenCalledWith('/usr/sbin/nft',
      ['list', 'table', 'inet', 'forge_exec_egress'],
      {env: {PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C'}, timeoutMs: 5000});
  });
  it('execute timeout resolves timedOut and kills a real sleeping child with SIGKILL', async () => {
    const pending = execute(process.execPath, ['-e', keepAliveScript()], {timeoutMs: 100});
    const {child, closed} = children.at(-1);
    expect(child.pid).toBeGreaterThan(0);
    await expect(pending).resolves.toEqual({code: null, timedOut: true});
    await expect(closed).resolves.toEqual({code: null, signal: 'SIGKILL'});
    expect(child.killed).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({code: 'ESRCH'}));
  });
  it('egress readiness: prepare refuses with egress-table-absent when the table is absent', async () => {
    probeResult = {code: 1};
    await expect(makeRunner().prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code: 'egress-table-absent'});
  });
  // The CLI main maps any thrown prepare error to cliFailure(); the Mac reads exit 254 before any bytes move as a safe local fallback.
  it('egress readiness: the prepare CLI failure mapping exits 254 and prints the egress-table-absent diagnostic', async () => {
    probeResult = {code: 1};
    const error = await makeRunner().prepare({nonce, label: 'abcdef-1'}).catch(e => e);
    expect(error.code).toBe('egress-table-absent');
    expect(cliFailure('prepare', error)).toEqual({
      stdout: '', exitCode: 254,
      stderr: 'forge-exec-run: Egress table inet forge_exec_egress absent; use local fallback\n',
    });
    // forge-busy keeps its protected stdout line; other subcommands never print it.
    const busy = Object.assign(new Error('busy'), {code: 'forge-busy'});
    expect(cliFailure('prepare', busy)).toEqual({stdout: '{"reason":"forge-busy"}\n', stderr: 'forge-exec-run: busy\n', exitCode: 254});
    expect(cliFailure('run', busy).stdout).toBe('');
  });
  it.each([
    ['testEgressProbe', () => ({testEgressProbe: vi.fn(() => ({code: 0}))})],
    ['testExecute', () => ({testExecute: vi.fn(() => ({code: 0}))})],
    ['both', () => ({testEgressProbe: vi.fn(() => ({code: 0})), testExecute: vi.fn(() => ({code: 0}))})],
  ])('egress readiness: ignores %s without testRoot and uses the production nft probe', async (_name, make) => {
    const injected = make();
    nftStub.code = 1;
    const before = children.length;
    await expect(createRunner(injected).egressReady()).rejects.toMatchObject({code: 'egress-table-absent'});
    for (const callback of Object.values(injected)) expect(callback).not.toHaveBeenCalled();
    const nft = children.slice(before).filter(c => c.file === '/usr/sbin/nft');
    expect(nft).toHaveLength(1);
    expect(nft[0].argv).toEqual(['list', 'table', 'inet', 'forge_exec_egress']);
    // A zero exit from the production probe is the only thing that lets it pass.
    nftStub.code = 0;
    await expect(createRunner(injected).egressReady()).resolves.toBeUndefined();
    for (const callback of Object.values(injected)) expect(callback).not.toHaveBeenCalled();
  });
  // Honest scope: this pins the launcher side only. The Mac's reaction to this exact record (it does NOT treat it as
  // a certified not-started, so heavy-admission refuses rather than rerunning local) is pinned in remote-exec.test.mjs.
  it('egress readiness: a run-time absent table rejects the slot, records the rejection and never executes', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    probeResult = {code: 1};
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runner.run(request)).rejects.toMatchObject({code: 'egress-table-absent'});
    expect(stderr).toHaveBeenCalledWith('forge-exec-run: egress-table-absent\n');
    expect(JSON.parse(await readFile(join(root, 'receipts', request.run + '.rejected'), 'utf8'))).toEqual({
      v: 1, nonce, run: request.run, phase: 'rejected', reason: 'snapshot-rejected', siblings: false,
    });
    expect(await ran()).toBe(false);
  });
  it('egress readiness: rechecks per run (the table deleted after a passing prepare refuses the run; it is not re-polled mid-run)', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    const before = probeCalls;
    expect(before).toBeGreaterThan(0);
    probeResult = {code: 1};
    await expect(runner.run(request)).rejects.toMatchObject({code: 'egress-table-absent'});
    expect(probeCalls).toBeGreaterThan(before);
  });
  it.each([
    ['nonzero exit', () => ({code: 1})],
    ['unexecutable nft', () => { throw Object.assign(new Error('spawn'), {code: 'ENOENT'}); }],
    ['hung (timeout)', () => ({code: null, timedOut: true})],
    ['timed out even with exit 0', () => ({code: 0, timedOut: true})],
    ['missing exit status', () => ({})],
  ])('egress readiness: fails closed on %s', async (_name, result) => {
    probeResult = result;
    await expect(makeRunner().prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code: 'egress-table-absent'});
  });
  // The fixed warmer invokes warm-install directly (no prepare/run), and npm ci there launches as the slot user.
  it.each([
    ['absent table', () => ({code: 1})],
    ['hung (timeout)', () => ({code: null, timedOut: true})],
    ['unexecutable nft', () => { throw Object.assign(new Error('spawn'), {code: 'ENOENT'}); }],
  ])('egress readiness: warm-install refuses with egress-table-absent on %s before npm ci or any slot work', async (_name, result) => {
    probeResult = result;
    const source = join(root, 'warm-source');
    await mkdir(source);
    await writeFile(join(source, 'package-lock.json'), 'lock');
    const manifest = manifestAPI.manifestWire({entries: [{path: Buffer.from('package-lock.json'), sha256: hash('lock'), executable: false}], excluded: []});
    await expect(makeRunner().warmInstall(source, manifest)).rejects.toMatchObject({code: 'egress-table-absent'});
    expect(probeCalls).toBe(1);
    expect(await ran()).toBe(false);
    await expect(readFile(join(root, 'runs'), 'utf8')).rejects.toMatchObject({code: expect.stringMatching(/ENOENT|EISDIR/)});
    await expect(readFile(join(root, 'cache'), 'utf8')).rejects.toMatchObject({code: expect.stringMatching(/ENOENT|EISDIR/)});
  });
  it('egress readiness: warm-install ignores test probes without testRoot and uses the production nft probe', async () => {
    const injected = {testEgressProbe: vi.fn(() => ({code: 0})), testExecute: vi.fn(() => ({code: 0}))};
    nftStub.code = 1;
    const before = children.length;
    await expect(createRunner(injected).warmInstall(join(root, 'none'), {})).rejects.toMatchObject({code: 'egress-table-absent'});
    for (const callback of Object.values(injected)) expect(callback).not.toHaveBeenCalled();
    expect(children.slice(before).filter(c => c.file === '/usr/sbin/nft')).toHaveLength(1);
  });
  it('egress readiness: a zero exit lets the run proceed', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    expect((await runner.run(request)).code).toBe(0);
    expect(await ran()).toBe(true);
  });
});
