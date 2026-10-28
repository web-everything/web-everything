import { beforeAll, expect, it, vi } from 'vitest';
import recoveredCi from '../soak/breaks/recovered-ci-auto-answer-boundaries.mjs';
import { resolveFixSettings } from '../fix-takeover.mjs';

// A missed injection must fail instead of reaching GitHub or a local agent process.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  execFileSync: vi.fn(() => { throw new Error('unexpected external effect'); }),
  spawnSync: vi.fn(() => { throw new Error('unexpected external effect'); }),
}));

let report;
// Cold-loading the real daemon graph can exceed a test's five-second budget.
beforeAll(async () => { report = await recoveredCi.run(); }, 30_000);

it('real daemon auto-answers recovered same-head CI by policy, honors off and explicit overrides', () => {
  expect(report.daemonWrites).toEqual({
    standard: ['cursor', 'reserve', 'post', 'cursor', 'reserve', 'post'],
    disabled: [],
    enabled: ['cursor', 'reserve', 'post', 'cursor', 'reserve', 'post'],
    'explicit-off': [],
    'explicit-on': ['cursor', 'reserve', 'post', 'cursor', 'reserve', 'post'],
  });
  expect(recoveredCi.judge(report)).toEqual([]);
});

it('keeps legacy status failures and a new failed attempt from releasing the hold', () => {
  expect(report.legacyStatusWrites).toEqual(['cursor']);
  expect(report.failedRerunRace).toEqual({ checkReads: 2, writes: ['cursor'] });
});

it.each([
  ['standard', {}, {}, {}, true, 'standard'],
  ['platform off', { standDownAutoProceed: false }, {}, {}, false, 'platform'],
  ['tool on', { standDownAutoProceed: false }, { standDownAutoProceed: true }, {}, true, 'tool'],
  ['tool off', {}, { standDownAutoProceed: false }, {}, false, 'tool'],
  ['env off', {}, { standDownAutoProceed: true }, { WE_FIX_STAND_DOWN_AUTO_PROCEED: 'off' }, false, 'env'],
  ['env on', {}, { standDownAutoProceed: false }, { WE_FIX_STAND_DOWN_AUTO_PROCEED: 'true' }, true, 'env'],
  ['malformed platform', { standDownAutoProceed: 'true' }, {}, {}, false, 'platform'],
  ['malformed tool', {}, { standDownAutoProceed: {} }, {}, false, 'tool'],
  ['malformed env', {}, {}, { WE_FIX_STAND_DOWN_AUTO_PROCEED: 'typo' }, false, 'env'],
])('R123 policy cascade: %s', (_name, platform, fix, env, expected, source) => {
  const settings = resolveFixSettings({ platform, env, read: () => JSON.stringify({ fix }) });
  expect(settings.standDownAutoProceed).toBe(expected);
  expect(settings.sources.standDownAutoProceed).toBe(source);
});

it('unreadable or malformed tool settings retain the operator hold', () => {
  for (const read of [() => '{', () => '{"fix":false}', () => { throw new Error('unreadable'); }]) {
    expect(resolveFixSettings({ platform: {}, env: {}, read })).toMatchObject({
      standDownAutoProceed: false, sources: { standDownAutoProceed: 'tool' },
    });
  }
});
