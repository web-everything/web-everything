// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRunner, digestInput, digestArgv} from '../forge-exec-run.mjs';
import * as manifestAPI from '../forge-exec-run.mjs';
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
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
const ran = () => readFile(join(root, 'npm.log'), 'utf8').then(() => true, () => false);

describe('egress table readiness', () => {
  it('egress readiness: prepare refuses with egress-table-absent when the table is absent', async () => {
    probeResult = {code: 1};
    await expect(makeRunner().prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code: 'egress-table-absent'});
  });
  it('egress readiness: refuses the slot and falls back to local when the egress table is absent', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    probeResult = {code: 1};
    await expect(runner.run(request)).rejects.toMatchObject({code: 'egress-table-absent'});
    expect(await ran()).toBe(false);
  });
  it('egress readiness: rechecks per command (the table deleted after a passing check refuses the next command)', async () => {
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
    ['missing exit status', () => ({})],
  ])('egress readiness: fails closed on %s', async (_name, result) => {
    probeResult = result;
    await expect(makeRunner().prepare({nonce, label: 'abcdef-1'})).rejects.toMatchObject({code: 'egress-table-absent'});
  });
  it('egress readiness: a zero exit lets the run proceed', async () => {
    const runner = makeRunner(), request = await requestFor(runner);
    expect((await runner.run(request)).code).toBe(0);
    expect(await ran()).toBe(true);
  });
});
