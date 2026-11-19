import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLanesRoot, readHeavyTmpRoot, readVolumeSettings } from '../lanes-volume-settings.mjs';
import { defaultPoolRoot, guardedPoolRoot } from '../lane-pool-paths.mjs';
import { isPoolLaneRealpath, daemonCloneRoots } from '../daemon-clone-registry.mjs';
import { createRunTmpRoot } from '../test-tmp-root.mjs';
import { runUnderAdmission } from '../../readiness/heavy-admission.mjs';
const roots = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'volume-settings-')); roots.push(root); return root; };
const empty = { env: {}, prefs: {}, tool: {}, log: () => {} };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('unset paths preserve workspace and os temp defaults', () => {
  expect(defaultPoolRoot('/workspace/web-everything', {}, empty)).toBe('/workspace/.lanes');
  expect(defaultPoolRoot('/workspace/.lanes/web-everything/lane-9', {}, empty)).toBe('/workspace/.lanes');
  expect(readLanesRoot(empty)).toBe('');
  expect(readHeavyTmpRoot(empty)).toBe(tmpdir());
});
it('resolves platform, tool, env in order and logs provenance', () => {
  const log = vi.fn();
  const options = { ...empty, prefs: { lanes: { root: '/platform' } }, tool: { lanes: { root: '/tool' } }, log };
  expect(readLanesRoot(options)).toBe('/tool');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('(tool)'));
  expect(readLanesRoot({ ...options, tool: {} })).toBe('/platform');
  expect(defaultPoolRoot('/workspace/repo', { LANE_POOL_ROOT: '~/external', HOME: '/home/user' }, options)).toBe('/home/user/external');
  expect(defaultPoolRoot('/workspace/repo', {}, options)).toBe('/tool');
  expect(() => readVolumeSettings({ ...empty, prefs: { lanes: { root: 'relative' } } })).toThrow();
});
it('creates configured temp storage and per-user vitest run parent', () => {
  const root = join(scratch(), 'new');
  const baseTmp = readHeavyTmpRoot({ ...empty, prefs: { heavy: { tmpRoot: root } } });
  expect(existsSync(root)).toBe(true);
  const run = createRunTmpRoot({ baseTmp, uid: 42, pid: 7 });
  expect(run).toContain('/we-vitest-42/7-');
});
it('unusable temp storage falls back and warns once on stderr', () => {
  const file = join(scratch(), 'file'); writeFileSync(file, 'x');
  const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const options = { env: {}, prefs: { heavy: { tmpRoot: file } }, tool: {} };
  expect(readHeavyTmpRoot(options)).toBe(tmpdir());
  expect(readHeavyTmpRoot(options)).toBe(tmpdir());
  expect(warn.mock.calls.filter(([s]) => String(s).includes('heavy.tmpRoot unavailable'))).toHaveLength(1);
  warn.mockRestore();
});
it('external pools preserve lane and daemon guards and seed locations', () => {
  const pool = scratch(); const env = { LANE_POOL_ROOT: pool };
  expect(isPoolLaneRealpath(join(pool, 'repo', 'lane-1'), '/workspace', env)).toBe(true);
  expect(isPoolLaneRealpath(join(pool, 'we-drain-daemon', 'code'), '/workspace', env)).toBe(false);
  expect(isPoolLaneRealpath(`${pool}-other/repo/lane-1`, '/workspace', env)).toBe(false);
  expect(daemonCloneRoots('/workspace', { env })).toContain(join(pool, 'we-drain-daemon', 'code'));
  expect(() => guardedPoolRoot('/workspace/repo', { VITEST: '1' })).toThrow(/refusing/);
});
it('heavy-run exports TMPDIR TMP TEMP only with an explicit setting', async () => {
  const exec = vi.fn(); const root = scratch();
  await runUnderAdmission({ bypass: 'held', env: { WE_HEAVY_TMP_ROOT: root }, command: 'echo ok', exec });
  expect(exec.mock.calls[0][1].env).toMatchObject({ TMPDIR: root, TMP: root, TEMP: root });
  exec.mockClear();
  await runUnderAdmission({ bypass: 'held', env: {}, command: 'echo ok', exec });
  expect(exec.mock.calls[0][1].env).toEqual({});
});
