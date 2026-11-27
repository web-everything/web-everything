// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, readdir, stat} from 'node:fs/promises';
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
  const runRoot = prepared.slot
    ? join(root, 'runs', 'slot-' + prepared.slot.slice('forge-exec-'.length))
    : join(root, 'runs');
  const work = join(runRoot, prepared.run, 'work');
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
  probeResult = {code: 0, stdout: ruleset(process.getuid())};
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
// Numeric `nft list table` form of the complete forge-egress.sh ruleset.
const ruleset = uid => `table inet forge_exec_egress {
  set registry4 {
    type ipv4_addr
    elements = { 104.16.24.34, 104.16.25.34 }
  }
  set registry6 {
    type ipv6_addr
    elements = { 2606:4700::6810:1822 }
  }
  chain slot_egress {
    oifname "lo" accept
    ip daddr @registry4 tcp dport 443 accept
    ip6 daddr @registry6 tcp dport 443 accept
    reject with icmpx type admin-prohibited
  }
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid { ${uid} } jump slot_egress
  }
}`;

const numericListing = (uids, verdict, priority) => ruleset(uids.join(', '))
  .replace('reject with icmpx type admin-prohibited', verdict)
  .replace('priority filter', 'priority ' + priority);
const plannedUIDs = Array.from({length: 8}, (_, i) => 999 - i);

describe('egress table readiness', () => {
  it.each(['reject with icmpx type admin-prohibited', 'reject with icmpx admin-prohibited',
    'reject with icmpx type 3', 'reject with icmpx 3'].flatMap(verdict => ['0', 'filter'].map(priority => [verdict, priority])))(
    'numeric nft listing covers every planned first-install UID: %s / %s', async (verdict, priority) => {
      probeResult = {code: 0, stdout: numericListing(plannedUIDs, verdict, priority)};
      for (const uid of plannedUIDs) await expect(makeRunner().egressReady(uid)).resolves.toBeUndefined();
    });
  it.each(['nft-n-forge-exec-egress-mesa-01.txt', 'nft-forge-exec-egress-mesa-01.txt'])(
    'captured Mesa-01 nft listing is accepted: %s', async file => {
      probeResult = {code: 0, stdout: await readFile(new URL('./fixtures/' + file, import.meta.url), 'utf8')};
      // Preserve the capture: this host had occupied UIDs, unlike the fresh fixture.
      for (const uid of [987, 988, 990, 993, 994, 995, 996, 999])
        await expect(makeRunner().egressReady(uid)).resolves.toBeUndefined();
      await expect(makeRunner().egressReady(991)).rejects.toMatchObject({code: 'egress-uid-uncovered'});
    });
  it.each(['reject with icmpx 0', 'reject with icmpx port-unreachable', 'reject', 'accept', 'reject with tcp reset'])(
    'other verdicts still refuse: %s', async verdict => {
      probeResult = {code: 0, stdout: numericListing(plannedUIDs, verdict, '0')};
      await expect(makeRunner().egressReady(999)).rejects.toMatchObject({
        code: 'egress-table-unrecognized',
        message: 'Egress table inet forge_exec_egress has an unrecognised ruleset; use local fallback',
      });
    });
  it.each([
    ['unrecognised table', 'egress-table-unrecognized'],
    ['uncovered UID', 'egress-uid-uncovered'],
  ])('active-worker prepare refuses an %s', async (_name, code) => {
    await mkdir(join(root, 'runs', 'slot-14'), {recursive: true, mode: 0o710});
    const {uid} = await stat(root);
    probeResult = {code: 0, stdout: code === 'egress-table-unrecognized' ? 'unknown' : ruleset(uid + 1)};
    const runner = createRunner({testRoot: root, testPath: bin + ':/usr/bin:/bin', testEgressProbe: probe,
      clock: () => 1800000000000,
      testDrainStat: async () => { throw Object.assign(new Error('fixture: no drain'), {code: 'ENOENT'}); },
      testReapProbe: {uidBusy: async () => false, unitActive: async () => false}});
    await expect(runner.prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code});
    expect((await readdir(join(root, 'receipts'))).filter(file => file.endsWith('.prepared'))).toEqual([]);
    expect(await ran()).toBe(false);
  });
  it.each([
    ['unrecognised table', 'egress-table-unrecognized'],
    ['uncovered UID', 'egress-uid-uncovered'],
  ])('active-worker run refuses an %s before execution', async (_name, code) => {
    await mkdir(join(root, 'runs', 'slot-14'), {recursive: true, mode: 0o710});
    const {uid} = await stat(root);
    probeResult = {code: 0, stdout: ruleset(uid)};
    const runner = createRunner({testRoot: root, testPath: bin + ':/usr/bin:/bin', testEgressProbe: probe,
      clock: () => 1800000000000,
      testDrainStat: async () => { throw Object.assign(new Error('fixture: no drain'), {code: 'ENOENT'}); },
      testReapProbe: {uidBusy: async () => false, unitActive: async () => false}});
    const request = await requestFor(runner);
    probeResult = {code: 0, stdout: code === 'egress-table-unrecognized' ? 'unknown' : ruleset(uid + 1)};
    await expect(runner.run(request)).rejects.toMatchObject({code});
    expect(await ran()).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'receipts', request.run + '.rejected'), 'utf8')))
      .toMatchObject({reason: 'snapshot-rejected', run: request.run, phase: 'rejected'});
  });
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
      ['-n', 'list', 'table', 'inet', 'forge_exec_egress'],
      {env: {PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C'}, timeoutMs: 5000});
  });
  it.each([false, true])('checks this run UID against installed coverage (covered=%s)', async covered => {
    const uid = process.getuid();
    await mkdir(join(root, 'runs'), {recursive: true});
    await mkdir(join(root, 'runs', 'slot-14'), {mode: 0o710});
    const table = value => ({code: 0, stdout: ruleset(value)});
    probeResult = table(uid);
    const runner = makeRunner(), request = await requestFor(runner);
    probeResult = table(covered ? uid : uid + 1);
    if (covered) {
      expect((await runner.run(request)).code).toBe(0);
      expect(await ran()).toBe(true);
    } else {
      await expect(runner.run(request)).rejects.toMatchObject({code: 'egress-uid-uncovered'});
      expect(await ran()).toBe(false);
    }
  });
  it.each(['', 'garbage', 'meta skuid { 2014 } jump slot_egress'])('refuses incomplete UID evidence %j', async stdout => {
    probeResult = {code: 0, stdout};
    await expect(makeRunner().egressReady(2014)).rejects.toMatchObject({code: 'egress-table-unrecognized'});
  });
  it.each([
    ['preceding unconditional accept', text => text.replace('meta skuid', 'accept\n    meta skuid')],
    ['preceding broader accept', text => text.replace('meta skuid', 'meta skuid { 2014, 2015 } accept\n    meta skuid')],
    ['preceding return', text => text.replace('meta skuid', 'return\n    meta skuid')],
    ['preceding jump-away', text => text.replace('meta skuid', 'jump other_chain\n    meta skuid')],
    ['preceding unparseable rule', text => text.replace('meta skuid', 'unknown rule\n    meta skuid')],
    ['empty slot_egress chain', text => text.replace(/chain slot_egress \{[^}]*\}/, 'chain slot_egress { }')],
    ['missing slot_egress chain', text => text.replace(/chain slot_egress \{[^}]*\}/, '')],
    ['missing terminal restriction', text => text.replace('reject with icmpx type admin-prohibited', '')],
    ['permissive terminal verdict', text => text.replace('reject with icmpx type admin-prohibited', 'accept')],
    ['wrong hook', text => text.replace('hook output', 'hook input')],
    ['unrestricted destination accept', text => text.replace('ip daddr @registry4 tcp dport 443 accept', 'accept')],
    ['malformed UID set', text => text.replace('{ 2014 } jump', '{ 2014, } jump')],
    ['trailing unknown evidence', text => text + '\nunknown'],
  ])('refuses UID coverage with %s', async (_name, change) => {
    probeResult = {code: 0, stdout: change(ruleset(2014))};
    await expect(makeRunner().egressReady(2014)).rejects.toMatchObject({code: 'egress-table-unrecognized'});
  });
  it.each([
    ['numeric priority and singleton UID', text => text.replace('priority filter', 'priority 0').replace('{ 2014 } jump', '2014 jump')],
    ['terminal drop', text => text.replace('reject with icmpx type admin-prohibited', 'drop')],
    ['empty registry sets', text => text.replace(/\s*elements = \{[^}]*\}/g, '')],
  ])('accepts complete restrictions with %s', async (_name, change) => {
    probeResult = {code: 0, stdout: change(ruleset(2014))};
    await expect(makeRunner().egressReady(2014)).resolves.toBeUndefined();
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
    expect(nft[0].argv).toEqual(['-n', 'list', 'table', 'inet', 'forge_exec_egress']);
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
  it('egress readiness: complete rules covering the run UID let the run proceed', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    expect((await runner.run(request)).code).toBe(0);
    expect(await ran()).toBe(true);
  });
});
