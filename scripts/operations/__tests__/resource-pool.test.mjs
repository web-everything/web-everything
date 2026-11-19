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
  expect(finishResourcePool({ run: { verdict: report }, code: 0, lines: ['json'], json: true }).lines).toEqual(['json']);
  expect(finishResourcePool({ run: { verdict: report }, code: 0 }).lines).toEqual([text]);
});
