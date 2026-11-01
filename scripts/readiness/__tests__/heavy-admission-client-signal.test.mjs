// x40a9dk: a killed heavy-admission client cancels its remote run and clears its marker only when cancellation is confirmed.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {resolveAdmissionPolicy, runWithRemoteDecision} from '../heavy-admission.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {defaultExec} from '../remote-exec.mjs';

const roots = [];
const scratch = () => {const root = mkdtempSync(join(process.env.TMPDIR, 'client-signal-')); roots.push(root); return root;};
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
const now = Date.parse('2026-10-29T21:40:00-04:00');
const sample = () => ({sampledAtET: easternTimestamp(now), cores: 8, loadPerCore: 0.12, memFreePct: 96, activeRuns: 3, recent: []});
const policy = resolveAdmissionPolicy({platform: {remote: {enabled: true, mode: 'always'}}});
const marker = (root) => join(root, 'remote', 'slot-0.unconfirmed');
const fixture = (remoteExec) => {
  const root = scratch();
  return {argv: ['npx', 'vitest', 'run', 'a.test.mjs'], policy, cwd: root, env: {WE_HEAVY_SIGNAL_CANCEL_WAIT_MS: '200'},
    lockRoot: join(root, 'heavy'), clock: () => now, readTelemetry: async () => sample(), remoteExec, log: vi.fn(), hostOverloaded: () => false};
};
const waitsForAbort = (result) => ({signal}) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(result), {once: true}));
const signalWhenMarked = (f, name) => { const t = setInterval(() => { if (existsSync(marker(f.cwd))) { clearInterval(t); process.emit(name); } }, 5); };

describe('heavy-admission client signals', () => {
  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]])('%s cancels the remote run, clears the marker and exits %i', async (name, code) => {
    const f = fixture(vi.fn(waitsForAbort({mode: 'cancelled', terminated: true, reason: 'client-signal'})));
    signalWhenMarked(f, name);
    expect(await runWithRemoteDecision(f)).toMatchObject({handled: true, exitCode: code, signal: name});
    expect(existsSync(marker(f.cwd))).toBe(false);
    expect(process.listenerCount(name)).toBe(process.listenerCount(name)); // handlers removed below
  });
  it('removes its signal handlers when the run ends', async () => {
    const before = process.listenerCount('SIGTERM');
    const f = fixture(vi.fn(async () => ({mode: 'remote', code: 0})));
    await runWithRemoteDecision(f);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('fails closed: unconfirmed cancellation leaves the marker for the reaper', async () => {
    const f = fixture(vi.fn(waitsForAbort({mode: 'unconfirmed', reason: 'ambiguous-result'})));
    signalWhenMarked(f, 'SIGTERM');
    expect(await runWithRemoteDecision(f)).toMatchObject({handled: true, exitCode: 143});
    expect(existsSync(marker(f.cwd))).toBe(true);
  });
  it('fails closed when the cancel never answers', async () => {
    const f = fixture(vi.fn(() => new Promise(() => {})));
    signalWhenMarked(f, 'SIGTERM');
    expect(await runWithRemoteDecision(f)).toMatchObject({handled: true, exitCode: 143});
    expect(existsSync(marker(f.cwd))).toBe(true);
  });
  it('a really killed client process cancels its remote run and leaves no marker', async () => {
    const root = scratch();
    const script = join(root, 'client.mjs');
    writeFileSync(script, `
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {resolveAdmissionPolicy, runWithRemoteDecision} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/readiness/heavy-admission.mjs')).href)};
const root = ${JSON.stringify(root)};
const policy = resolveAdmissionPolicy({platform: {remote: {enabled: true, mode: 'always'}}});
const result = await runWithRemoteDecision({argv: ['npx','vitest','run','a.test.mjs'], policy, cwd: root, env: {}, lockRoot: join(root,'heavy'),
  clock: () => ${now}, readTelemetry: async () => (${JSON.stringify(sample())}), log: () => {}, hostOverloaded: () => false,
  remoteExec: ({signal}) => { process.stdout.write('ready\\n'); return new Promise((resolve) => signal.addEventListener('abort', () => resolve({mode:'cancelled', terminated:true}), {once:true})); }});
process.exit(result.exitCode);
`);
    const child = spawn(process.execPath, [script], {stdio: ['ignore', 'pipe', 'inherit']});
    await once(child.stdout, 'data');
    expect(existsSync(marker(root))).toBe(true);
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    expect(code).toBe(143);
    expect(existsSync(marker(root))).toBe(false);
  });
  it('defaultExec stops its child when the signal aborts', async () => {
    const controller = new AbortController();
    const run = defaultExec({file: 'sleep', args: ['30'], signal: controller.signal});
    controller.abort();
    expect((await run).code).not.toBe(0);
  });
});
