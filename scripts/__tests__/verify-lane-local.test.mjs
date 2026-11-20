// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { localPhaseReason, phaseAdmissionPlan } from '../lib/verify-remote-routing.mjs';

const source = readFileSync(new URL('../verify-lane.mjs', import.meta.url), 'utf8');
const admissionStart = source.indexOf('async function acquireAdmission(');
const admissionEnd = source.indexOf('const admission = await acquireAdmission(', admissionStart);

describe('verify-lane --local', () => {
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
    ];
    for (const [phase, command] of commands) {
      const admission = await acquireAdmission(phase, command);
      expect(admission).toMatchObject({ ok: true });
      expect(admission.remote).not.toBe(true);
      // This is the same plan used by timedRunGate to choose Forge dispatch.
      expect(phaseAdmissionPlan({ command, cwd: process.cwd(), decision: { remote: admission.remote === true } }))
        .toEqual({ command, takeLocalSlot: true, setHeld: true });
    }
    expect(context.decidePhaseRemote).not.toHaveBeenCalled();
    expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback.mock.calls.every(([entry]) => entry.reason === 'local-flag')).toBe(true);
    expect(context.process.stderr.write.mock.calls.every(([line]) => line.includes('local admission (local-flag)'))).toBe(true);
  });

  it.each([false, true])('records local metadata only with the flag in start and terminal markers (local=%s)', FORCE_LOCAL => {
    const startLine = source.split('\n').find(line => line.startsWith("if (MODE !== 'run') writeMarker("));
    const finishLine = source.split('\n').find(line => line.startsWith('writeMarker({ ...finished,'));
    expect(startLine).toBeTypeOf('string');
    expect(finishLine).toBeTypeOf('string');
    const writeMarker = vi.fn();
    const context = {
      FORCE_LOCAL, MODE: 'verify', writeMarker,
      verifyStartBody: value => value, headSha: 'head', GATE: 'gate', currentTreeHash: 'tree', flags: {},
      finished: { status: 'green' }, overallRunLocation: () => ({ location: 'local' }), ranOnPhases: {},
      resolvedGate: null, redCauseFields: {}, phases: {}, revertRed: null,
    };
    runInNewContext(startLine, context);
    runInNewContext(finishLine, context);
    expect(writeMarker).toHaveBeenCalledTimes(2);
    for (const [marker] of writeMarker.mock.calls) {
      if (FORCE_LOCAL) expect(marker.local).toBe(true);
      else expect(marker).not.toHaveProperty('local');
    }
    writeMarker.mockClear();
    context.MODE = 'run';
    runInNewContext(startLine, context);
    expect(writeMarker).not.toHaveBeenCalled();
  });
});
