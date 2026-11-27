// @vitest-environment node
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveAdmissionPolicy, runWithRemoteDecision} from '../heavy-admission.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });

it('default list with a runner-missing probe uses local admission with reason=no-healthy-remote despite healthy telemetry', async () => {
  const cwd = mkdtempSync(join(process.env.TMPDIR, 'default-readiness-')); roots.push(cwd);
  writeFileSync(join(cwd, 'a.test.mjs'), 'export {};\n');
  const now = Date.parse('2026-11-26T20:00:00-05:00');
  const targetExec = vi.fn(async () => ({code:1}));
  const remoteExec = vi.fn(async () => ({mode:'remote', code:0}));
  const readTelemetry = vi.fn(async () => ({sampledAtET:easternTimestamp(now),
    cores:8, loadPerCore:0.1, memFreePct:90, activeRuns:0, recent:[]}));
  const log = vi.fn();
  const lockRoot = join(cwd, 'heavy');
  const policy = resolveAdmissionPolicy({env:{},platform:{remote:{enabled:true, mode:'always', manifest:'legacy'}}});
  expect(await runWithRemoteDecision({argv:['npm','run','test:unit','--','a.test.mjs'], cwd,
    env:{NODE_ENV:'test'}, lockRoot, policy, clock:() => now, loadPerCore:() => 4,
    hostOverloaded:() => false, targetExec, remoteExec, readTelemetry, readCapability:() => true, log}))
    .toEqual({handled:false});
  expect(targetExec).toHaveBeenCalledTimes(1);
  expect(targetExec).toHaveBeenCalledWith(expect.objectContaining({file:'ssh', cwd,
    args:['--','mesa-01','test -x /usr/local/libexec/forge-exec-run.mjs']}));
  expect(readTelemetry).not.toHaveBeenCalled();
  expect(remoteExec).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join('')).toContain('location=local reason=no-healthy-remote');
  expect(log.mock.calls.flat().join('')).not.toContain('location=remote');
  expect(JSON.parse(readFileSync(join(lockRoot, 'remote-fallbacks.jsonl'), 'utf8'))).toMatchObject({
    reason:'no-healthy-remote', detail:JSON.stringify([{alias:'mesa-01',reason:'runner-missing'}])});
});

it.each([
  ['the overridden host is ready and mesa-01 is unavailable', 0, 255, true],
  ['the overridden runner is missing and mesa-01 is ready', 1, 0, false],
])('explicit host override probes the dispatched alias when %s', async (_case, overrideCode, defaultCode, ready) => {
  const cwd = mkdtempSync(join(process.env.TMPDIR, 'override-readiness-')); roots.push(cwd);
  writeFileSync(join(cwd, 'a.test.mjs'), 'export {};\n');
  const now = Date.parse('2026-11-26T20:00:00-05:00');
  const host = 'explicit-runner';
  const targetExec = vi.fn(async ({args}) => ({code:args[1] === host ? overrideCode : defaultCode}));
  const remoteExec = vi.fn(async () => ({mode:'remote', code:0}));
  const readTelemetry = vi.fn(async () => ({sampledAtET:easternTimestamp(now),
    cores:8, loadPerCore:0.1, memFreePct:90, activeRuns:0, recent:[]}));
  const log = vi.fn();
  const lockRoot = join(cwd, 'heavy');
  const policy = resolveAdmissionPolicy({env:{},platform:{remote:{enabled:true, mode:'always', manifest:'legacy'}}});
  const result = await runWithRemoteDecision({argv:['npm','run','test:unit','--','a.test.mjs'], cwd, host,
    env:{NODE_ENV:'test'}, lockRoot, policy, clock:() => now, loadPerCore:() => 4,
    hostOverloaded:() => false, targetExec, remoteExec, readTelemetry, readCapability:() => true, log});
  expect(result).toEqual(ready ? {handled:true, exitCode:0, remoteResult:{mode:'remote', code:0}} : {handled:false});
  expect(targetExec).toHaveBeenCalledTimes(1);
  expect(targetExec).toHaveBeenCalledWith(expect.objectContaining({file:'ssh', cwd,
    args:['--',host,'test -x /usr/local/libexec/forge-exec-run.mjs']}));
  if (ready) {
    expect(remoteExec).toHaveBeenCalledTimes(1);
    expect(remoteExec).toHaveBeenCalledWith(expect.objectContaining({host:targetExec.mock.calls[0][0].args[1]}));
    expect(readTelemetry).toHaveBeenCalledWith(expect.objectContaining({host}));
  } else {
    expect(remoteExec).not.toHaveBeenCalled();
    expect(readTelemetry).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('')).toContain('location=local reason=no-healthy-remote');
    expect(log.mock.calls.flat().join('')).not.toContain('location=remote');
    expect(JSON.parse(readFileSync(join(lockRoot, 'remote-fallbacks.jsonl'), 'utf8'))).toMatchObject({
      reason:'no-healthy-remote', detail:JSON.stringify([{alias:host,reason:'runner-missing'}])});
  }
});
