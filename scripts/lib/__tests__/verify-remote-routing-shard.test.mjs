import { it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { phaseAdmissionPlan, shouldConfirmRemoteRed, remoteInfrastructureFailure, mergeRunLocation, SHARD_RUN_SCRIPT } from '../verify-remote-routing.mjs';
import { verificationInfrastructureFailure, verifyFinishBody } from '../lane-verify.mjs';
it('a wrapper executing from an apostrophe path owns admission under every decision', () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-executing-checkout's-"));
  try {
    const sourceUrl = pathToFileURL(resolve('scripts/lib/verify-remote-routing.mjs'));
    const source = readFileSync(sourceUrl, 'utf8').replace(/from '(\.\.?\/[^']+)'/g,
      (_, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`);
    const copy = join(directory, 'verify-remote-routing.mjs');
    writeFileSync(copy, source);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { phaseAdmissionPlan, SHARD_RUN_SCRIPT } from ${JSON.stringify(pathToFileURL(copy).href)};
const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
const command = 'node ' + quote(SHARD_RUN_SCRIPT) + ' --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a b';
process.stdout.write(JSON.stringify([undefined, { remote: true }, { remote: false }].map(decision => phaseAdmissionPlan({ command, decision }))));
`], { encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    for (const plan of JSON.parse(child.stdout)) {
      expect(plan).toMatchObject({ takeLocalSlot: false, setHeld: false, shardWrapper: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('shard wrappers own admission and confirmation under every decision, including chains', () => {
  for (const decision of [undefined, { remote: true }, { remote: false }]) for (const suffix of ['']) {
  for (const head of [`node '${SHARD_RUN_SCRIPT}'`]) {
    const command = head + ' --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a b' + suffix;
    const plan = phaseAdmissionPlan({ command, decision });
    expect(plan).toEqual({ command, takeLocalSlot: false, setHeld: false, shardWrapper: true });
    expect(shouldConfirmRemoteRed({ plan, exitCode: 1, ranOn: { location: 'remote', failureLocation: 'remote' } })).toBe(false);
  }}
});
it('a wrapper chained with raw vitest segments keeps ordinary admission', () => {
  const command = `node '${SHARD_RUN_SCRIPT}' --shards=2 --parallel=2 --budget-ms=1 -- npx vitest run a && npx vitest run scan`;
  expect(phaseAdmissionPlan({ command, decision: { remote: true } }).shardWrapper).toBeUndefined();
});
it('shell metacharacters after the wrapper defeat wrapper detection', () => {
  for (const tail of ['; npx vitest run b', ' | cat', ' $(id)', '\nnpx vitest run b']) {
    const command = `node '${SHARD_RUN_SCRIPT}' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run 'a b.test.mjs'` + tail;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } }).shardWrapper).toBeUndefined();
  }
  const quoted = `node '${SHARD_RUN_SCRIPT}' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run 'a;b.test.mjs'`;
  expect(phaseAdmissionPlan({ command: quoted, decision: { remote: true } }).shardWrapper).toBe(true);
});
it('a lookalike wrapper elsewhere does not bypass admission', () => {
  const command = "node '/tmp/verify-shard-run.mjs' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run a";
  expect(phaseAdmissionPlan({ command, decision: { remote: false } }).shardWrapper).toBeUndefined();
});
it('ordinary local and remote plans stay unchanged', () => {
  expect(phaseAdmissionPlan({ command: 'npx vitest run a', decision: { remote: false } })).toEqual({ command: 'npx vitest run a', takeLocalSlot: true, setHeld: true });
  expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: 1, ranOn: { location: 'remote', failureLocation: 'remote' } })).toBe(true);
});

it.each([
  ['remote admission deferral', {}, true],
  ['remote failure with details', { failureDetails: { summary: 'remote failure' } }, true],
  ['mixed remote failure', { ranOn: { location: 'mixed', failureLocation: 'remote' } }, true],
  ['shard unsettled', { plan: { takeLocalSlot: false, shardWrapper: true } }, false],
  ['shard failure with details', { plan: { takeLocalSlot: false, shardWrapper: true }, failureDetails: { summary: 'shard failure' } }, false],
  ['local plan', { plan: { takeLocalSlot: true } }, false],
  ['local fallback', { ranOn: { location: 'local', failureLocation: 'local' } }, false],
  ['mixed local failure', { ranOn: { location: 'mixed', failureLocation: 'local' } }, false],
  ['unknown location', { ranOn: { location: 'unknown' } }, false],
  ['remote successful prefix', { ranOn: { location: 'remote' } }, false],
  ['signal', { signal: 'SIGTERM' }, false],
  ['watchdog timeout', { timedOut: true }, false],
])('exit 75 confirmation respects ownership and evidence: %s', (_name, overrides, expected) => {
  expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: 75,
    ranOn: { location: 'remote', failureLocation: 'remote' }, ...overrides })).toBe(expected);
});

// Run the production phase orchestration with injected child IO and admission, without Git writes.
it.each([false, true].flatMap(phaseAdmission => [false, true].flatMap(remoteFailure => [
  { phaseAdmission, remoteFailure, localExit: 0, localFailure: false, status: 'green' },
  { phaseAdmission, remoteFailure, localExit: 1, localFailure: true, status: 'red' },
  { phaseAdmission, remoteFailure, localExit: 75, localFailure: true, status: 'red' },
  { phaseAdmission, remoteFailure, localExit: 75, localFailure: false, status: 'infrastructure-failure' },
])))('remote exit 75 confirms once and retains the local verdict: phase=$phaseAdmission, remoteFailure=$remoteFailure, localExit=$localExit, localFailure=$localFailure', async ({ phaseAdmission, remoteFailure, localExit, localFailure, status }) => {
  const source = readFileSync(resolve('scripts/verify-lane.mjs'), 'utf8');
  const start = source.indexOf('async function timedRunGate(');
  const end = source.indexOf('// runVitestOnBase', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const remoteDetails = remoteFailure
    ? { tests: [{ file: 'remote.test.mjs', name: 'remote failure' }], summary: 'remote failure', truncated: false } : undefined;
  const localDetails = localFailure
    ? { tests: [{ file: 'local.test.mjs', name: 'local failure' }], summary: 'local failure', truncated: false } : undefined;
  const runGate = vi.fn().mockResolvedValueOnce({ exitCode: 75, remoteAttempt: true,
    ranOn: { location: 'remote', failureLocation: 'remote' }, failureDetails: remoteDetails })
    .mockResolvedValue({ exitCode: localExit, failureDetails: localDetails, ranOn: { location: 'local' } });
  const acquireAdmission = vi.fn(async () => ({ ok: true }));
  const context = {
    phaseAdmission, firstPhaseAdmission: { remote: true }, admission: { remote: true }, currentAdmission: null,
    phaseAdmissionPlan, shouldConfirmRemoteRed, remoteInfrastructureFailure, mergeRunLocation,
    runGate, acquireAdmission, recordOutcome: vi.fn(), buildPhaseOutcome: value => value,
    ranOnPhases: {}, phaseMs: {}, remoteUnconfirmed: false, phaseTimeout: null, vitestAdmittedLocally: false,
    resolvedGate: null, slotHeartbeat: null, setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn(),
    heartbeatOwnedSlot: vi.fn(), releaseOwnedSlot: vi.fn(), ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1,
    REPO: process.cwd(), SLOT_HEARTBEAT_MS: 1000, PHASE_TIMEOUT_MS: 10000, MARKER_NONCE_SUFFIX: '', performance,
    process: { stderr: { write: vi.fn() } },
  };
  const timedRunGate = runInNewContext(`${source.slice(start, end)}; timedRunGate`, context);
  const result = await timedRunGate('standardsMs', 'npm run check:standards');
  expect(runGate).toHaveBeenCalledTimes(2);
  expect(runGate).toHaveBeenNthCalledWith(1, 'npm run check:standards', undefined, { forgeDispatch: true });
  expect(runGate).toHaveBeenNthCalledWith(2, 'npm run check:standards', undefined);
  expect(acquireAdmission).toHaveBeenCalledTimes(1);
  expect(acquireAdmission).toHaveBeenCalledWith('standards', 'npm run check:standards', { forceLocal: true });
  expect(context.releaseOwnedSlot).toHaveBeenCalledTimes(1);
  expect(result.exitCode).toBe(localExit);
  expect(result.failureDetails).toBe(localDetails);
  expect(result.ranOn).toEqual({ location: 'local', remoteRedConfirmedLocally: true });
  expect(context.ranOnPhases.standards).toEqual(result.ranOn);
  expect(context.recordOutcome).toHaveBeenCalledWith('standards', expect.objectContaining({ exitCode: localExit, failureDetails: localDetails }));
  const infrastructure = verificationInfrastructureFailure(result);
  const marker = verifyFinishBody({}, { ...result, infrastructure });
  expect(marker.status).toBe(status);
  if (status === 'red') expect(marker.failureDetails.summary).toBe('local failure');
  if (status === 'infrastructure-failure') expect(marker.infrastructure.reason).toBe('verify-unsettled');
});
