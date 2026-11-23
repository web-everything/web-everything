import { afterEach, expect, it, vi } from 'vitest';

const scenario = '../../conveyor/soak/breaks/mq-log-escape-sequences-readable.mjs';

afterEach(() => { vi.doUnmock('vitest'); vi.doUnmock(scenario); vi.resetModules(); });

it('a regressed soak reader registers a failing plain test instead of an expected failure', async () => {
  const registered = [];
  const test = (_title, callback) => registered.push({ callback, expectedFailure: false });
  test.fails = (_title, callback) => registered.push({ callback, expectedFailure: true });
  vi.doMock('vitest', () => ({ describe: (_title, callback) => callback(), it: test, expect }));
  vi.doMock(scenario, () => ({ default: {
    id: 'fixture', title: 'regressed reader', card: 'DRAIN-LOG-ESCAPE', fixedBy: { sha: 'fixture', where: 'fixture' },
    fixPresent: () => false, run: async () => ({ violations: ['broken reader'] }), judge: report => report.violations,
  } }));
  await import('../../conveyor/soak/breaks/mq-log-escape-sequences-readable.soak.test.mjs');
  expect(registered.length).toBeGreaterThan(0);
  expect(registered.every(test => !test.expectedFailure)).toBe(true);
  const results = await Promise.allSettled(registered.map(test => Promise.resolve().then(test.callback)));
  expect(results.some(result => result.status === 'rejected')).toBe(true);
});
