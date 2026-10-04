/**
 * @file deliver-item-settle.test.mjs — #4349. `settleDispatchEffect` is the ONE thing a finished delivery
 * wrapper was missing: a way to tell the run store its own `conveyor.dispatch-delivery-agent` effect is done.
 * These tests drive the function directly against a real `createFileRunStore` over a throwaway temp dir (never
 * the repo's own `.operations/runs/`) — no mocking of `run-store.mjs`/`effect-executor.mjs`, since the whole
 * point is that this is the SAME `resolveInFlight` seam every other caller already trusts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settleDispatchEffect } from '../deliver-item-settle.mjs';
import { createFileRunStore, newRunRecord } from '../run-store.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/** A minimal, schema-valid run record parked on one `in-flight` `build` dispatch effect — the exact shape
 *  `applyPendingEffects` leaves behind before a sink ever reports back (see `effect-executor.mjs`). */
function inFlightRun(id) {
  const run = newRunRecord({ id, op: 'dispatch-lane' });
  return {
    ...run,
    pending: { kind: 'effect', step: 'dispatch', stepIndex: 0 },
    effects: [{
      key: 'dispatch:0:0', type: 'conveyor.dispatch-delivery-agent', stepIndex: 0, index: 0, status: 'in-flight',
      handle: 'pid:99999', expectedBy: new Date(Date.now() + 90 * 60_000).toISOString(),
      payload: { num: '9001', launchKind: 'build' }, result: null, error: null,
    }],
  };
}

describe('settleDispatchEffect', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deliver-item-settle-'));
    store = createFileRunStore(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('Done-when 1 — settles an in-flight effect to `applied` with the wrapper\'s own outcome', () => {
    store.write(inFlightRun('dispatch-lane-abc'));
    const out = settleDispatchEffect(
      { runId: 'dispatch-lane-abc', key: 'dispatch:0:0', status: 'applied', result: { outcome: 'not-ready', reason: 'blockedBy 1 re-opened' } },
      { store },
    );
    expect(out).toEqual({ settled: true });
    const after = store.read('dispatch-lane-abc');
    const entry = after.effects.find((e) => e.key === 'dispatch:0:0');
    expect(entry.status).toBe('applied');
    expect(entry.result).toEqual({ outcome: 'not-ready', reason: 'blockedBy 1 re-opened' });
  });

  it('settles to `failed` with the caught error, for the wrapper-threw path', () => {
    store.write(inFlightRun('dispatch-lane-threw'));
    settleDispatchEffect({ runId: 'dispatch-lane-threw', key: 'dispatch:0:0', status: 'failed', error: 'acquire refused' }, { store });
    const entry = store.read('dispatch-lane-threw').effects[0];
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('acquire refused');
  });

  it('is a clean no-op when `runId`/`key` are absent (an older caller, a test, a hand-run CLI invocation)', () => {
    expect(settleDispatchEffect({ status: 'applied' }, { store })).toEqual({ settled: false, reason: 'no-run-id-or-key' });
    expect(settleDispatchEffect({ runId: 'x', status: 'applied' }, { store })).toEqual({ settled: false, reason: 'no-run-id-or-key' });
  });

  it('is a clean no-op when the run does not exist — never invents a record', () => {
    const out = settleDispatchEffect({ runId: 'dispatch-lane-nope', key: 'dispatch:0:0', status: 'applied' }, { store });
    expect(out).toEqual({ settled: false, reason: 'run-not-found' });
  });

  it('NEVER RE-SETTLES an already-applied entry (a second wrapper turn, or the waker having already resolved it)', () => {
    store.write(inFlightRun('dispatch-lane-twice'));
    settleDispatchEffect({ runId: 'dispatch-lane-twice', key: 'dispatch:0:0', status: 'applied', result: { outcome: 'not-ready' } }, { store });
    const second = settleDispatchEffect({ runId: 'dispatch-lane-twice', key: 'dispatch:0:0', status: 'failed', error: 'should never land' }, { store });
    expect(second).toEqual({ settled: false, reason: 'already-applied' });
    // the FIRST outcome is what stands — a later, different call never overwrites a settled fact.
    expect(store.read('dispatch-lane-twice').effects[0].result).toEqual({ outcome: 'not-ready' });
  });

  it('is a clean no-op for an unknown effect key on an otherwise real run', () => {
    store.write(inFlightRun('dispatch-lane-badkey'));
    const out = settleDispatchEffect({ runId: 'dispatch-lane-badkey', key: 'nope', status: 'applied' }, { store });
    expect(out).toEqual({ settled: false, reason: 'no-such-effect-key' });
  });

  // The kill test below only ever proves "a killed process writes nothing further" — true of any process,
  // whether or not it ever calls `settleDispatchEffect` at all. Paired here with a POSITIVE CONTROL: a second
  // child that runs to completion and DOES import + call the real function, so a break in it (a bad import, a
  // thrown error, a wrong write) fails THIS test, not just the kill one. The kill test itself now also imports
  // the real module before hanging, so a genuinely broken import throws at startup and the child never even
  // reaches "seeded" — turning a silent false-pass into a visible failure.
  const CHILD_PROCESS_TEST_TIMEOUT_MS = 60_000;
  const runStoreModule = pathToFileURL(join(REPO_ROOT, 'scripts', 'operations', 'run-store.mjs')).href;
  const settleModule = pathToFileURL(join(REPO_ROOT, 'scripts', 'operations', 'deliver-item-settle.mjs')).href;

  it('POSITIVE CONTROL for Done-when 2, below — a child that runs the REAL settleDispatchEffect to completion '
    + 'settles the run to `applied`; this is what would fail if that function were deleted or broken, which '
    + 'the kill test by itself structurally cannot detect', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'deliver-item-settle-control-runs-'));
    const scriptDir = mkdtempSync(join(tmpdir(), 'deliver-item-settle-control-script-'));
    const scriptPath = join(scriptDir, 'seed-and-settle.mjs');
    writeFileSync(scriptPath, [
      `import { createFileRunStore, newRunRecord } from ${JSON.stringify(runStoreModule)};`,
      `import { settleDispatchEffect } from ${JSON.stringify(settleModule)};`,
      'const store = createFileRunStore(process.argv[2]);',
      'const run = { ...newRunRecord({ id: "dispatch-lane-control", op: "dispatch-lane" }), pending: { kind: "effect", step: "dispatch", stepIndex: 0 },',
      '  effects: [{ key: "dispatch:0:0", type: "conveyor.dispatch-delivery-agent", stepIndex: 0, index: 0, status: "in-flight",',
      '    handle: "pid:1", expectedBy: new Date(Date.now() + 90 * 60000).toISOString(), payload: { num: "9001", launchKind: "build" }, result: null, error: null }] };',
      'store.write(run);',
      // The REAL call this whole file exists to test — never stubbed, never skipped.
      'settleDispatchEffect({ runId: "dispatch-lane-control", key: "dispatch:0:0", status: "applied", result: { outcome: "not-ready", reason: "control" } }, { store });',
      'process.stdout.write("settled\\n");',
    ].join('\n'));

    const child = spawn(process.execPath, [scriptPath, runsDir], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolvePromise, rejectPromise) => {
      child.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`control child exited ${code}`))));
      child.on('error', rejectPromise);
    });

    const store = createFileRunStore(runsDir);
    const entry = store.read('dispatch-lane-control').effects[0];
    expect(entry.status).toBe('applied');
    expect(entry.result).toEqual({ outcome: 'not-ready', reason: 'control' });

    rmSync(runsDir, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  }, CHILD_PROCESS_TEST_TIMEOUT_MS);

  // Done-when 2 — a wrapper KILLED before it ever reaches a settle call must leave the effect untouched
  // (fail-closed for a genuinely unknown outcome, per #3073). The child imports the REAL `settleDispatchEffect`
  // (so a broken import fails loudly, before "seeded" is ever printed) but never calls it, then blocks (an
  // unresolved promise). This test SIGKILLs it mid-block and asserts the on-disk record is byte-for-byte
  // unchanged. Paired with the positive control above — that test is what actually proves the settle path
  // works; this one proves a kill before it runs leaves no trace.
  it('Done-when 2 — a hard kill before the process reaches settleDispatchEffect leaves the run record '
    + 'untouched (still in-flight)', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'deliver-item-settle-kill-runs-'));
    const scriptDir = mkdtempSync(join(tmpdir(), 'deliver-item-settle-kill-script-'));
    const scriptPath = join(scriptDir, 'seed-and-hang.mjs');
    writeFileSync(scriptPath, [
      `import { createFileRunStore, newRunRecord } from ${JSON.stringify(runStoreModule)};`,
      // Imported (never called) — a deleted/renamed export throws HERE, before "seeded" is ever printed, so
      // the `await seeded` below hangs and the test fails loudly instead of silently passing regardless.
      `import { settleDispatchEffect } from ${JSON.stringify(settleModule)};`,
      'void settleDispatchEffect;',
      'const store = createFileRunStore(process.argv[2]);',
      'const run = { ...newRunRecord({ id: "dispatch-lane-killed", op: "dispatch-lane" }), pending: { kind: "effect", step: "dispatch", stepIndex: 0 },',
      '  effects: [{ key: "dispatch:0:0", type: "conveyor.dispatch-delivery-agent", stepIndex: 0, index: 0, status: "in-flight",',
      '    handle: "pid:1", expectedBy: new Date(Date.now() + 90 * 60000).toISOString(), payload: { num: "9001", launchKind: "build" }, result: null, error: null }] };',
      'store.write(run);',
      'process.stdout.write("seeded\\n");',
      // Block forever, exactly as an in-progress build would — this process is killed before it ever CALLS
      // `settleDispatchEffect`, which is the whole point of the assertion below: nothing downstream of this
      // line ever runs.
      'await new Promise(() => {});',
    ].join('\n'));

    const child = spawn(process.execPath, [scriptPath, runsDir], { stdio: ['ignore', 'pipe', 'inherit'] });
    const seeded = new Promise((resolvePromise, rejectPromise) => {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += String(chunk);
        if (buf.includes('seeded')) resolvePromise();
      });
      child.on('error', rejectPromise);
      // A child that dies before "seeded" (broken import) must fail HERE with its exit code, not sit until the
      // test-level timeout reports a bare "timed out".
      child.on('exit', (code) => rejectPromise(new Error(`kill-test child exited ${code} before printing "seeded"`)));
    });
    await seeded;
    const rawBeforeKill = readFileSync(join(runsDir, 'dispatch-lane-killed.json'), 'utf8');
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.on('exit', resolvePromise));

    const rawAfterKill = readFileSync(join(runsDir, 'dispatch-lane-killed.json'), 'utf8');
    expect(rawAfterKill).toBe(rawBeforeKill);
    const store = createFileRunStore(runsDir);
    expect(store.read('dispatch-lane-killed').effects[0].status).toBe('in-flight');

    rmSync(runsDir, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
    // Flake fix (PR #3833's required `test` timed out here at the 5000ms default, twice, on a loaded CI runner):
    // the 5 s budget covers a COLD child `node` startup + importing run-store/deliver-item-settle, which is
    // load-dependent. The assertions are unchanged; only the wait for the child to be ready is made generous.
  }, CHILD_PROCESS_TEST_TIMEOUT_MS);
});
