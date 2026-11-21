// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { resourcePoolOperation, renderResourcePool, finishResourcePool, digestLine } from '../resource-pool.mjs';
it('requires a reader and declares a readout without admission effect steps', () => {
  expect(() => resourcePoolOperation()).toThrow(/collect/);
  expect(resourcePoolOperation({ collect: vi.fn() })).toBeTruthy();
});
it('renders mode, sources, holders and a digest; preserves JSON verdict digest', () => {
  const report = { mode: 'shadow', configuredMode: 'enforce', unknown: true, digest: digestLine({ unknown: true }),
    settings: { provenance: 'resourcePool mode=shadow (tool)' }, sources: [{ source: 'fix', ok: false, error: 'bad\nfile' }],
    summary: { 'studio.units': { held: 2, classes: { 1: 0, 2: 0, 3: 2, 4: 0 } } },
    holders: [{ resource: 'studio.units', class: 3, kind: 'fix', id: 'pr-1', size: 2, source: 'fix' }] };
  const text = renderResourcePool(report);
  for (const term of ['mode shadow', 'configured enforce', 'fix: UNKNOWN', 'pr-1', report.digest]) expect(text).toContain(term);
  expect(text).not.toContain('bad\nfile');
  expect(finishResourcePool()({ run: { verdict: report }, code: 0, lines: ['json'], json: true }).lines).toEqual(['json']);
  expect(finishResourcePool()({ run: { verdict: report }, code: 0 }).lines).toEqual([text]);
});

it('shadow rows are written only through the finish sink, including JSON runs', () => {
  const log = vi.fn();
  const report = { mode: 'shadow', rows: [{ kind: 'build' }] };
  const finish = finishResourcePool({ log });
  expect(log).not.toHaveBeenCalled();
  const args = { run: { verdict: report }, code: 0, lines: ['json'], json: true };
  expect(finish(args)).toEqual({ code: 0, lines: ['json'] });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(report.rows, { mode: 'shadow' });
  log.mockClear();
  finish({ ...args, run: { verdict: { ...report, mode: 'off' } } });
  finish({ ...args, run: {} });
  expect(log).not.toHaveBeenCalled();
  expect(() => finishResourcePool({ log: () => { throw Error('disk'); } })(args)).not.toThrow();
});
