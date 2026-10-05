import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('marks, upserts, reads and clears wakes, ignoring stale entries', async () => {
  const { markOverlayConflictWake, readOverlayConflictWakes, clearOverlayConflictWake } = await import('../overlay-conflict-wake.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'we-overlay-wake-'));
  dirs.push(dir);
  const env = { WE_DAEMON_STATE_DIR: dir };
  const nowMs = Date.now();
  const entry = { pr: 42, ref: 'lane/fix', files: ['a.mjs'], at: new Date(nowMs).toISOString(), clone: '/clone' };
  expect(readOverlayConflictWakes(env)).toEqual(new Map());
  markOverlayConflictWake(env, entry);
  markOverlayConflictWake(env, { ...entry, files: ['b.mjs'] });
  markOverlayConflictWake(env, { ...entry, pr: 43, at: new Date(nowMs - 7 * 3600_000).toISOString() });
  expect(readOverlayConflictWakes(env, { nowMs })).toEqual(new Map([[42, { ...entry, files: ['b.mjs'] }]]));
  expect(readOverlayConflictWakes(env, { nowMs, maxAgeMs: 8 * 3600_000 }).size).toBe(2);
  clearOverlayConflictWake(env, 42);
  expect(readOverlayConflictWakes(env, { nowMs }).size).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'overlay-conflict-wake.json'), 'utf8'))['42']).toBeUndefined();
  writeFileSync(join(dir, 'overlay-conflict-wake.json'), '{broken');
  expect(readOverlayConflictWakes(env)).toEqual(new Map());
  writeFileSync(join(dir, 'overlay-conflict-wake.json'), JSON.stringify({ 42: { pr: 42, at: { toString: null } } }));
  expect(readOverlayConflictWakes(env)).toEqual(new Map());
});

it('keeps the first mark time while the same overlay stays unresolved (bounded urgency)', async () => {
  const { markOverlayConflictWake, readOverlayConflictWakes } = await import('../overlay-conflict-wake.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'we-overlay-wake-'));
  dirs.push(dir);
  const env = { WE_DAEMON_STATE_DIR: dir };
  const nowMs = Date.now();
  const first = new Date(nowMs - 7 * 3600_000).toISOString();
  markOverlayConflictWake(env, { pr: 7, ref: 'lane/x', files: [], at: first, clone: '/c' });
  markOverlayConflictWake(env, { pr: 7, ref: 'lane/x', files: [], at: new Date(nowMs).toISOString(), clone: '/c' });
  expect(readOverlayConflictWakes(env, { nowMs }).size).toBe(0);
  markOverlayConflictWake(env, { pr: 7, ref: 'lane/y', files: [], at: new Date(nowMs).toISOString(), clone: '/c' });
  expect(readOverlayConflictWakes(env, { nowMs }).get(7).ref).toBe('lane/y');
});
