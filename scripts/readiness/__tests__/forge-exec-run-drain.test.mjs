// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect} from 'vitest';
import {mkdtemp, mkdir, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createRunner, cliFailure, parseTelemetry, DRAIN_MARKER} from '../forge-exec-run.mjs';
// Deploy drain (designs/forge-self-deploy.md 2.6): a root-owned marker refuses NEW reservations only.
let root;
const nonce = 'a'.repeat(32);
const regular = (uid = 0) => ({isFile: () => true, isSymbolicLink: () => false, uid});
const enoent = () => Object.assign(new Error('missing'), {code: 'ENOENT'});
function makeRunner(testDrainStat) {
  return createRunner({testRoot: root, testPath: '/usr/bin:/bin', testDrainStat,
    testWorkerIdentity: async user => ({uid: 20000 + Number(user.slice(11)), gid: 30000 + Number(user.slice(11)), groups: [30000 + Number(user.slice(11))]}),
    testSlotStat: async path => ({isSymbolicLink: () => false, isDirectory: () => true, mode: 0o40710, uid: process.getuid(), gid: 30000 + Number(path.slice(-1))})});
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.TMPDIR, 'forge-drain-')));
  for (const slot of [1, 2]) await mkdir(join(root, 'runs', 'slot-' + slot), {recursive: true, mode: 0o710});
  await mkdir(join(root, 'receipts'), {mode: 0o700});
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
describe('forge deploy drain marker', () => {
  it('uses one fixed path', () => { expect(DRAIN_MARKER).toBe('/run/forge-deploy/drain'); });
  it('refuses a new reservation as forge-draining when the marker is present', async () => {
    const runner = makeRunner(async path => { expect(path).toBe(DRAIN_MARKER); return regular(); });
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code: 'forge-draining'});
  });
  it('reserves normally when the marker is absent', async () => {
    const runner = makeRunner(async () => { throw enoent(); });
    expect((await runner.prepare({nonce})).run).toMatch(/^r-/);
  });
  it('ignores a symlink marker', async () => {
    const runner = makeRunner(async () => ({...regular(), isFile: () => false, isSymbolicLink: () => true}));
    expect((await runner.prepare({nonce})).run).toMatch(/^r-/);
  });
  it('ignores a non-root-owned marker', async () => {
    const runner = makeRunner(async () => regular(1000));
    expect((await runner.prepare({nonce})).run).toMatch(/^r-/);
  });
  it('treats an unreadable stat as draining', async () => {
    const runner = makeRunner(async () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); });
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code: 'forge-draining'});
  });
  it('leaves an in-flight reservation untouched when the marker appears', async () => {
    let draining = false;
    const runner = makeRunner(async () => { if (draining) return regular(); throw enoent(); });
    const first = await runner.prepare({nonce});
    draining = true;
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code: 'forge-draining'});
    const t = await runner.telemetry();
    expect(t.deploy).toEqual({draining: true});
    expect(first.run).toMatch(/^r-/);
    expect(t.activeRuns).toBe(1);
  });
  it('treats ENOTDIR on the marker path as draining too (only ENOENT is absent)', async () => {
    const runner = makeRunner(async () => { throw Object.assign(new Error('notdir'), {code: 'ENOTDIR'}); });
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code: 'forge-draining'});
  });
  it('gives the lock back when the marker appears during reservation', async () => {
    let calls = 0;
    const runner = makeRunner(async () => { if (++calls >= 2) return regular(); throw enoent(); });
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code: 'forge-draining'});
    calls = -100;
    const t = await runner.telemetry();
    expect(t.activeRuns).toBe(0);
    expect((await runner.prepare({nonce})).run).toMatch(/^r-/);
  });
  it('reports deploy.draining in telemetry both ways', async () => {
    let draining = false;
    const runner = makeRunner(async () => { if (draining) return regular(); throw enoent(); });
    expect((await runner.telemetry()).deploy).toEqual({draining: false});
    draining = true;
    expect((await runner.telemetry()).deploy).toEqual({draining: true});
  });
  it('parseTelemetry accepts documents with or without deploy and rejects a malformed deploy', async () => {
    const runner = makeRunner(async () => { throw enoent(); });
    const doc = await runner.telemetry();
    expect(parseTelemetry(JSON.stringify(doc))).toEqual(doc);
    const {deploy, ...old} = doc;
    expect(parseTelemetry(JSON.stringify(old))).toEqual(old);
    for (const bad of [{draining: 'yes'}, {}, {draining: true, extra: 1}, null])
      expect(() => parseTelemetry(JSON.stringify({...doc, deploy: bad}))).toThrow('Invalid telemetry schema');
  });
  it('maps the prepare failure to a distinct stdout reason', () => {
    const error = Object.assign(new Error('draining'), {code: 'forge-draining'});
    expect(cliFailure('prepare', error).stdout).toBe(JSON.stringify({reason: 'forge-draining'}) + '\n');
  });
});
