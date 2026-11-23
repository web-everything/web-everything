import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './red-main-quarantine-soft-timeout.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { breakById } from './index.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('discovers the break and the fix is present on this tree (decided by behaviour)', () => {
  expect(breakById(b.id)).toBe(b);
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('replays run 45080540441 through shadow at 23:26Z and prints the expiring quarantine entry', async () => {
  const report = await b.run({});
  expect(b.judge(report)).toEqual([]);
  expect(report.plan.tests).toEqual(['scripts/conveyor/soak/daemon-soak.soak.test.mjs']);
  const printed = report.plan.outputs.find(o => o.type === 'quarantine');
  expect(printed).toMatchObject({ at: Date.parse('2026-11-22T23:26:00Z'), shadow: true,
    test: 'scripts/conveyor/soak/daemon-soak.soak.test.mjs',
    entry: { expiresAt: Date.parse('2026-11-23T05:26:00Z'), release: { passesUnderSoft: 3 },
      timeout: { run: 45080540441, outcomes: [{ class: 'soft', runnerLimitMs: 1020000 }] },
      note: expect.stringContaining('file-level skip') } });
  expect(report.plan.outputs.map(o => o.type)).toEqual(expect.arrayContaining(['quarantine', 'alert', 'fix-card']));
  expect(report.plan.fixPrSkips).toEqual([]);
});
