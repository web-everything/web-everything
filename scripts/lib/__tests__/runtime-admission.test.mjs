import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideRuntimeAdmission, assertRuntimeAdmitted, withRuntimeAdmission } from '../runtime-admission.mjs';
import { readBuildPrioritySettings } from '../build-queue.mjs';
import { routeHeldItems } from '../../conveyor/build-dispatch-hold-router.mjs';

const only = ids => ({ mode: 'only', only: true, ids });
it.each([
  [{ num: 12 }, only(['12']), true],
  [{ num: 13 }, only(['12']), false],
  [{ num: 13 }, only([]), false],
  [{ num: 13 }, { mode: 'lift', ids: [] }, true],
  [{ num: 13 }, {}, true],
  [{ num: 12 }, { held: true, mode: 'lift', ids: ['12'] }, false],
  [{ num: 12, bornAs: 'xabcdef0' }, only(['xabcdef0']), true],
  [{ num: 12, bornAs: 'xBAD' }, only(['xBAD']), false],
  [{ num: 12, id: 'xabcdef0-title' }, only(['xabcdef0']), true],
  [{ num: 12, id: '13-title' }, only(['13']), false],
  [{ num: 12, id: 'xBAD-title' }, only(['xBAD']), false],
  ...['13', 13, '#13', 'xabc'].map(bornAs => [{ num: 12, bornAs }, only([String(bornAs)]), false]),
])('pure admission for %j with %j is %s', (card, settings, admitted) => {
  for (const kind of ['build', 'prepare', 'route', 'resume']) expect(decideRuntimeAdmission(card, kind, settings).admitted).toBe(admitted);
});
it('held or unreadable settings fail closed with a repairable reason', () => {
  expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings: () => { throw new Error('EACCES'); } }))
    .toEqual({ admitted: false, reason: 'runtime-malformed' });
  expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings: () => undefined }).admitted).toBe(false);
});
it('fresh file reads see only → held → lift and environment never widens the runtime list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-admission-'));
  const runtimePath = join(dir, 'priority.json');
  const write = mode => writeFileSync(runtimePath, JSON.stringify({ ids: ['12'], mode, at: new Date().toISOString(), setBy: 'test', ttlHours: 24 }));
  const readSettings = () => readBuildPrioritySettings({ runtimePath, env: { WE_BUILD_PRIORITY: '12,13' } });
  try {
    write('only');
    expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings }).admitted).toBe(true);
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(false);
    writeFileSync(runtimePath, '{');
    expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings }).reason).toBe('runtime-malformed');
    write('lift');
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(true);
    rmSync(runtimePath);
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each([only([]), { held: true }])('hold routing admits no work or reservations with %j', async settings => {
  const spawnLand = vi.fn(), reserveRoute = vi.fn(), recordFinding = vi.fn();
  const result = await routeHeldItems({ plan: ['already-done', 'out-of-scope', 'other'].map(route => ({ num: '12', route })),
    readSettings: () => settings, spawnLand, reserveRoute, recordFinding });
  expect(result.every(r => r.action === 'runtime-refused')).toBe(true);
  expect(spawnLand).not.toHaveBeenCalled();
  expect(reserveRoute).not.toHaveBeenCalled();
  expect(recordFinding).not.toHaveBeenCalled();
});
it('records unique refusals on the row and logs once per tick', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await withRuntimeAdmission(() => only([]), async () => {
      assertRuntimeAdmitted({ num: 12 }, 'build');
      assertRuntimeAdmitted({ num: 12 }, 'build');
      assertRuntimeAdmitted({ num: 12 }, 'prepare');
      return {};
    });
    expect(result.runtimeRefused).toEqual([{ num: '12', kind: 'build', reason: 'runtime-only' }, { num: '12', kind: 'prepare', reason: 'runtime-only' }]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});
