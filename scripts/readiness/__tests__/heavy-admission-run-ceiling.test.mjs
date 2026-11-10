// The run ceiling (--run-ceiling-ms) starts at slot grant, not at wrapper launch: queue wait never counts against it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnderAdmission, admittedArgv, heldSlots } from '../heavy-admission.mjs';

const T0 = Date.parse('2026-09-03T12:00:00.000Z');
let lockRoot;
beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'heavy-run-ceiling-')); });
afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

describe('runUnderAdmission — run ceiling counted from slot grant', () => {
  it('applies runCeilingMs as the exec timeout only after the slot is held, and reports 124 on ETIMEDOUT', async () => {
    const seen = [];
    const exec = (_c, o) => { seen.push({ timeout: o.timeout, held: heldSlots({ lockRoot, cap: 1 }).length }); throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); };
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'A', command: 'x', runCeilingMs: 4321, exec, log: () => {}, now: () => T0, sleep: async () => {} });
    expect(seen).toEqual([{ timeout: 4321, held: 1 }]);
    expect(r.exitCode).toBe(124);
    expect(heldSlots({ lockRoot, cap: 1 })).toHaveLength(0);
  });
  it('the default exec kills the whole process group at the ceiling (no orphan), and a bypassed run is bounded too', async () => {
    const pidFile = join(lockRoot, 'pid');
    const started = Date.now();
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'G', command: `sleep 30 & echo $! > ${pidFile}; wait`, runCeilingMs: 400, log: () => {}, now: () => T0, sleep: async () => {} });
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
    const b = await runUnderAdmission({ lockRoot, cap: 1, owner: 'H', command: 'sleep 30', bypass: 'no-pool', runCeilingMs: 300, log: () => {} });
    expect(b.exitCode).toBe(124);
    const ok = await runUnderAdmission({ lockRoot, cap: 1, owner: 'I', command: 'exit 3', runCeilingMs: 5000, log: () => {}, now: () => T0, sleep: async () => {} });
    expect(ok.exitCode).toBe(3);
  });
  it('no runCeilingMs means no exec timeout; admittedArgv carries the flag only when asked', async () => {
    const seen = [];
    await runUnderAdmission({ lockRoot, cap: 1, owner: 'B', command: 'x', exec: (_c, o) => seen.push(o.timeout), now: () => T0, sleep: async () => {} });
    expect(seen).toEqual([undefined]);
    expect(admittedArgv('npx', ['v']).args.join(' ')).not.toContain('run-ceiling');
    expect(admittedArgv('npx', ['v'], { runCeilingMs: 900 }).args.slice(1, 4)).toEqual(['run', '--run-ceiling-ms=900', '--']);
  });
});
