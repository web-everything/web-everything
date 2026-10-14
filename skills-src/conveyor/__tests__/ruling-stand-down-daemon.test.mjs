import { expect, it, vi } from 'vitest';
import { runTickAllRepos } from '../reconcile-fix-dispatch-daemon.mjs';
import rulingHoldBreak from '../../../scripts/conveyor/soak/breaks/ruling-answers-unrelated-or-stale-stand-down.mjs';
it('replays unrelated rulings, fresh same-head blocks and failed writes through the real daemon tick', async () => {
  expect(rulingHoldBreak.judge(await rulingHoldBreak.run())).toEqual([]);
});
it('runs the injected ruling half even with auth paused, forwarding results', async () => {
  const empty = () => ({ dispatched: [], refusals: [], reconcileRefusals: [] });
  const rulingStandDownTick = vi.fn(() => ({ setting: 'on', settingSource: 'file',
    rows: [{ repo: 'web-everything/web-everything', pr: 7, action: 'resolve', standDownId: 'sd' }] }));
  const result = await runTickAllRepos({ repos: ['web-everything/web-everything'], fixTick: empty, ciHealTick: empty,
    hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty, notesTick: empty,
    awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }), supersedeTick: () => ({ rows: [] }),
    rulingStandDownTick, authGateOverride: () => ({ paused: true, reason: 'test' }) });
  expect(rulingStandDownTick).toHaveBeenCalledOnce();
  expect(rulingStandDownTick.mock.calls[0][0]).toMatchObject({ repo: 'web-everything/web-everything', setting: 'on' });
  expect(result.rulingStandDown.rows).toHaveLength(1);
  expect(result.dispatched).toContainEqual(expect.objectContaining({ pr: 7, action: 'resolve' }));
});
it('logs the setting source and each held or resolved row', async () => {
  const { buildCliDaemonEffects } = await import('../reconcile-fix-dispatch-daemon.mjs');
  const error = vi.fn();
  buildCliDaemonEffects({ owner: 'test', log: { error } }).onTick({ rulingStandDown: {
    setting: 'on', settingSource: 'env', rows: [{ repo: 'o/r', pr: 7, action: 'held', standDownId: 'sd' }],
  } });
  expect(error).toHaveBeenCalledWith('ruling-resolves-stand-down: setting=on (source: env)');
  expect(error).toHaveBeenCalledWith('ruling-resolves-stand-down: o/r#7 held stand-down=sd');
});
