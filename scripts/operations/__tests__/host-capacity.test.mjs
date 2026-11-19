/** R258: macOS load can misrepresent capacity; the declared report only computes injected evidence. */
import { it, expect } from 'vitest';
import { hostCapacityOperation, finishHostCapacity } from '../host-capacity.mjs';
it('declares a read-only operation and supports JSON passthrough', () => {
  const declaration = hostCapacityOperation({ collect: () => ({}) });
  expect(declaration.name).toBe('host-capacity');
  expect(declaration.steps.every(({ step }) => step.kind === 'compute')).toBe(true);
  expect(declaration.steps[0].step.fn()).toEqual({});
  expect(declaration.verdictFrom).toBe('read');
  expect(() => hostCapacityOperation()).toThrow('collect reader');
  expect(finishHostCapacity({ run: { verdict: {} }, code: 0, lines: ['json'], json: true })).toEqual({ code: 0, lines: ['json'] });
});

it('renders measured evidence in plain mode', () => {
  const verdict = { reason: 'CPU idle 38%; memory free 51%', mac: { cores: 12, busyCores: 7.44, loadAverage: [50], swapUsedMb: 10, compressorPages: 20 }, forge: { reachable: false }, headroom: { forge: 'unknown' }, admitNewWorkers: true };
  const result = finishHostCapacity({ run: { verdict }, code: 0, lines: [] });
  expect(result.lines[0]).toContain('reference only');
  expect(result.lines[0]).toContain('Admit new workers: true');
});
