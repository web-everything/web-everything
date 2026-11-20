// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { SHARD_RUN_SCRIPT, localPhaseReason, localPhaseBypassDetail, phaseAdmissionPlan, phaseRunLocation, shouldConfirmRemoteRed, remoteInfrastructureFailure } from '../lib/verify-remote-routing.mjs';
import { shellQuote, isShardWrapperCommand } from '../lib/verify-lane-gate.mjs';
import { runLaneGate } from '../conveyor/verify-dispatch.mjs';

const source = readFileSync(new URL('../verify-lane.mjs', import.meta.url), 'utf8');
const admissionStart = source.indexOf('async function acquireAdmission(');
const admissionEnd = source.indexOf('const admission = await acquireAdmission(', admissionStart);
const selectedTests = "npx vitest run 'a test.mjs' b.test.mjs --testTimeout=15000 --hookTimeout=30000";
const shardCommand = `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`;
const unsupportedShardCommand = `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- echo unexpected`;
const commandShapes = [
  ['npm', 'npm run test:unit -- a.test.mjs'],
  ['vitest', selectedTests],
  ['related', 'npx vitest related scripts/a.mjs --run --passWithNoTests'],
  ['chain', 'npx vitest run a.test.mjs && npx vitest run b.test.mjs'],
  ['standards', 'npm run check:standards -- --files=scripts/a.mjs'],
  ['admission wrapper', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs'],
  ['shard wrapper', shardCommand, selectedTests],
  ['whole gate with shard wrapper', `${shardCommand} && npm run check:standards`, `${selectedTests} && npm run check:standards`],
  ['shard wrapper from quoted requester checkout', `node ${shellQuote("/tmp/requester's -- npx vitest run checkout/scripts/lib/verify-shard-run.mjs")} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`, selectedTests],
  ['scan', "VERIFY_SCAN_FILES='scripts/a.mjs' npx vitest run scripts/scan.test.mjs"],
  ['empty selection', "echo 'verify-lane: no remaining changed file'"],
  ['unsupported shard command refuses local execution', unsupportedShardCommand],
];

function parseCli(context, local, childArgs) {
  const start = source.indexOf('const flags = {}');
  const end = source.indexOf('// #2833 finding 5', start);
  expect(end).toBeGreaterThan(start);
  context.process.argv = ['node', ...(childArgs ?? ['verify-lane.mjs', ...(local ? ['--local'] : [])])];
  context.process.cwd = () => process.cwd();
  Object.assign(context, { resolve, join, homedir });
  runInNewContext(`${source.slice(start, end)}; Object.assign(globalThis, { FORCE_LOCAL, flags, REPO });`, context);
}

describe('verify-lane --local', () => {
  it.each([false, true])('request marker preserves parsed --local through daemon dispatch to the executing CLI (local=%s)', async local => {
    const startLine = source.split('\n').find(line => line.startsWith("if (MODE !== 'run') writeMarker("));
    const context = {
      MODE: 'request', process: { env: {} }, verifyStartBody: value => value,
      headSha: 'head', GATE: selectedTests, currentTreeHash: 'tree', writeMarker: vi.fn(),
    };
    parseCli(context, local);
    runInNewContext(startLine, context);
    const marker = context.writeMarker.mock.calls[0][0];
    const spawnGate = vi.fn(async () => ({ pid: 123 }));
    await runLaneGate({
      pool: 'fixture', lane: 1, dir: process.cwd(), headSha: 'head', marker,
      runId: 'request-local-policy', spawnGate, log: () => {}, logPath: 'unused',
      gateCeiling: { ms: 1000, mode: 'fixture', source: 'fixture', factor: 1 },
    });
    expect(spawnGate).toHaveBeenCalledTimes(1);
    const [args] = spawnGate.mock.calls[0];
    expect(args).toContain(`--gate=${selectedTests}`);
    expect(args).toContain('--run-id=request-local-policy');
    const child = { process: { env: {} } };
    parseCli(child, false, args);
    expect(child.FORCE_LOCAL).toBe(local);
    expect(child.flags.gate).toBe(selectedTests);
  });

  it.each([false, true])('takes local slots for every phase and bypasses remote policy (phaseAdmission=%s)', async phaseAdmission => {
    expect(admissionStart).toBeGreaterThan(-1);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    const context = {
      FORCE_LOCAL: true, phaseAdmission, localPhaseReason, phaseAdmissionPlan,
      decidePhaseRemote: vi.fn(async () => ({ remote: true })),
      acquireSlotBlocking: vi.fn(async () => ({ ok: true, slot: 0, waitedMs: 0 })),
      phaseAdmissionKind: () => ({ kind: 'files' }), classifyCommandKind: () => 'selected',
      recordLocalSlotFallback: vi.fn(), admissionPhases: {}, laneMatch: null,
      GATE: 'npm run test:unit', resolvedGate: { decision: {} },
      ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, ADMISSION_TIMEOUT_MS: 1000,
      REPO: process.cwd(), process: { env: {}, stderr: { write: vi.fn() } },
    };
    const acquireAdmission = runInNewContext(`${source.slice(admissionStart, admissionEnd)}; acquireAdmission`, context);
    const commands = [
      ['vitest', 'npm run test:unit'],
      ['scan', 'npx vitest run scripts/scan.test.mjs'],
      ['scan', 'npx vitest run scripts/guard.test.mjs'],
      ['standards', 'npm run check:standards'],
      ['vitest', `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a.test.mjs b.test.mjs`],
      ['vitest', 'npx vitest related scripts/a.mjs --run --passWithNoTests'],
      ['vitest', 'npx vitest run a.test.mjs && npx vitest run b.test.mjs'],
      ['vitest', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs'],
    ];
    for (const [phase, command] of commands) {
      const admission = await acquireAdmission(phase, command);
      expect(admission).toMatchObject({ ok: true });
      expect(admission.remote).not.toBe(true);
    }
    expect(context.decidePhaseRemote).not.toHaveBeenCalled();
    expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback.mock.calls.every(([entry]) => entry.reason === 'local-flag')).toBe(true);
    expect(context.process.stderr.write.mock.calls.every(([line]) => line.includes('local admission (local-flag)'))).toBe(true);
  });

  it.each([false, true])('records local metadata only with the parsed CLI flag in start and terminal markers (local=%s)', local => {
    const startLine = source.split('\n').find(line => line.startsWith("if (MODE !== 'run') writeMarker("));
    const finishLine = source.split('\n').find(line => line.startsWith('writeMarker({ ...finished,'));
    expect(startLine).toBeTypeOf('string');
    expect(finishLine).toBeTypeOf('string');
    const writeMarker = vi.fn();
    const context = {
      MODE: 'verify', writeMarker, process: { env: {} },
      verifyStartBody: value => value, headSha: 'head', GATE: 'gate', currentTreeHash: 'tree', flags: {},
      finished: { status: 'green' }, overallRunLocation: () => ({ location: 'local' }), ranOnPhases: {},
      resolvedGate: null, redCauseFields: {}, phases: {}, revertRed: null,
    };
    parseCli(context, local);
    runInNewContext(startLine, context);
    runInNewContext(finishLine, context);
    expect(writeMarker).toHaveBeenCalledTimes(2);
    for (const [marker] of writeMarker.mock.calls) {
      if (local) expect(marker.local).toBe(true);
      else expect(marker).not.toHaveProperty('local');
    }
    writeMarker.mockClear();
    context.MODE = 'run';
    runInNewContext(startLine, context);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it.each(commandShapes)('CLI --local preserves suites and bypasses Forge while default routing remains unchanged: %s', async (_shape, command, localCommand = command) => {
    for (const local of [false, true]) {
      const spawn = vi.fn(() => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      });
      const context = {
        process: { env: { WE_FORGE_GATE_DISPATCH: '1' }, stderr: { write: vi.fn() }, pid: 123 },
        phaseAdmission: true, localPhaseReason, localPhaseBypassDetail, phaseAdmissionPlan, phaseRunLocation,
        isShardWrapperCommand,
        shouldConfirmRemoteRed, remoteInfrastructureFailure,
        decidePhaseRemote: vi.fn(async () => ({ remote: true, reason: 'test-remote-policy' })),
        acquireSlotBlocking: vi.fn(async () => ({ ok: true, slot: 0, waitedMs: 0 })),
        recordLocalSlotFallback: vi.fn(), phaseAdmissionKind: () => ({ kind: 'files' }),
        classifyCommandKind: () => 'selected', admissionPhases: {}, laneMatch: null,
        GATE: command, resolvedGate: { decision: {} }, ADMISSION_TIMEOUT_MS: 1000,
        ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, ADMISSION_HELD_ENV: 'WE_HEAVY_ADMISSION_HELD',
        mkdtempSync, rmSync, join, tmpdir, spawn,
        createFailureCollector: () => ({ push() {}, finish: () => null }),
        createOutputTail: () => ({ push() {}, finish: () => [] }),
        randomBytes: () => Buffer.from('fixture'), Buffer, MAX_TIMEOUT_LOG_BYTES: 1000,
        GATE_PHASE_MARKER_ENV: 'WE_VERIFY_GATE_PHASE_123',
        readRemoteReport: () => [], recordOutcome: vi.fn(), buildPhaseOutcome: value => value,
        ranOnPhases: {}, phaseMs: {}, remoteUnconfirmed: false, phaseTimeout: null,
        slotHeartbeat: null, setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn(),
        clearTimeout, heartbeatOwnedSlot: vi.fn(), releaseOwnedSlot: vi.fn(),
        SLOT_HEARTBEAT_MS: 1000, PHASE_TIMEOUT_MS: 10000, MARKER_NONCE_SUFFIX: '', performance,
      };
      parseCli(context, local);
      const acquireAdmission = runInNewContext(`${source.slice(admissionStart, admissionEnd)}; acquireAdmission`, context);
      context.admission = await acquireAdmission('vitest', command);
      context.firstPhaseAdmission = context.admission;
      context.acquireAdmission = acquireAdmission;
      const runStart = source.indexOf('async function runGate(');
      const runEnd = source.indexOf('// #5141', runStart);
      const timedStart = source.indexOf('async function timedRunGate(');
      const timedEnd = source.indexOf('// runVitestOnBase', timedStart);
      expect(runEnd).toBeGreaterThan(runStart);
      expect(timedEnd).toBeGreaterThan(timedStart);
      context.runGate = vi.fn(runInNewContext(`${source.slice(runStart, runEnd)}; runGate`, context));
      const timedRunGate = runInNewContext(`${source.slice(timedStart, timedEnd)}; timedRunGate`, context);
      if (local && command === unsupportedShardCommand) {
        await expect(timedRunGate('vitestMs', command)).rejects.toThrow('--local requires a selected Vitest command');
        expect(spawn).not.toHaveBeenCalled();
        expect(context.releaseOwnedSlot).toHaveBeenCalledTimes(1);
        continue;
      }
      const result = await timedRunGate('vitestMs', command);
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [executed, args, options] = spawn.mock.calls[0];
      if (local) {
        expect(context.admission.ok).toBe(true);
        expect(context.admission.remote).not.toBe(true);
        expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(1);
        expect(context.decidePhaseRemote).not.toHaveBeenCalled();
        expect(executed).toBe(localCommand);
        expect(context.runGate).toHaveBeenNthCalledWith(1, localCommand, undefined, { forgeDispatch: false });
        expect(args).toEqual([]);
        expect(options.env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
        expect(options.env.WE_HEAVY_ADMISSION_HELD).toBe('1');
        expect(result.remoteAttempt).toBe(false);
        expect(result.ranOn.location).toBe('local');
        // Also defend the execution boundary against a stale remote admission or confirmation request.
        await context.runGate('node', ['fixture.mjs'], { forgeDispatch: true });
        expect(spawn.mock.calls[1][2].env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
      } else {
        const plan = phaseAdmissionPlan({ command, decision: { remote: true }, cwd: process.cwd() });
        expect(executed).toBe(plan.command);
        expect(result.remoteAttempt).toBe(!plan.takeLocalSlot);
        expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(plan.takeLocalSlot ? 1 : 0);
        expect(context.decidePhaseRemote).toHaveBeenCalledTimes(plan.takeLocalSlot ? 0 : 1);
        if (plan.takeLocalSlot) expect(options.env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
        else expect(options.env.WE_FORGE_GATE_DISPATCH).toBe('1');
      }
    }
  });
});
