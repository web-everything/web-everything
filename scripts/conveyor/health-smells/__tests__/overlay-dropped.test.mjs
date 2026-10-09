/**
 * @file scripts/conveyor/health-smells/__tests__/overlay-dropped.test.mjs
 * @description Held item 168 — the PURE `overlay-dropped` smell: a registered overlay the daemon rebuild left out of
 *   the clone's HEAD. Replays the live capture of 2026-10-09 01:07 ET (fixture: lane/main-red-owner, PR #4527,
 *   conflict-dropped on scripts/dispatch-settings.json while six other overlays applied) plus synthetic edges.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import overlayDropped, { droppedOverlays, resolveOverlayDroppedSettings, OVERLAY_DROPPED_BUILT_IN } from '../overlay-dropped.mjs';
import { MINUTE } from '../../health-watch-core.mjs';
import { LEGACY_ONLY_READERS } from '../../../lib/settings-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const live = JSON.parse(readFileSync(join(HERE, 'fixtures/overlay-dropped-2026-10-09.json'), 'utf8'));
const asProbe = (clone) => ({
  ...clone,
  alerts: clone.alerts.map((a) => ({ ...a, at: Date.parse(a.at) })),
  rebuild: { adopted: { ...clone.rebuild.adopted, at: Date.parse(clone.rebuild.adopted.at) } },
});
const NOW = Date.parse(live.now);

describe('overlay-dropped — live replay 2026-10-09', () => {
  const rows = overlayDropped.evaluate({ selfSync: [asProbe(live.clone)] }, { now: NOW });

  it('breaches for exactly the dropped overlay, naming the PR and the conflicting file', () => {
    expect(rows.map((r) => r.subject)).toEqual(['overlay:fde6cfdae10394e1:lane/main-red-owner']);
    const r = rows[0];
    expect(r.breach).toBe(true);
    expect(r.measure).toMatchObject({ ref: 'lane/main-red-owner', pr: 4527, files: ['scripts/dispatch-settings.json'], settingsOnly: true });
    expect(r.summary).toMatch(/PR #4527/);
    expect(r.summary).toMatch(/scripts\/dispatch-settings\.json/);
    expect(r.recommendation).toMatch(/scripts\/settings\/<feature>\.json/);
  });

  it('never tells a maintainer to move keys whose reader still reads only the legacy file', () => {
    const { recommendation } = rows[0];
    expect(recommendation).toMatch(/rebase/);
    expect(recommendation).toMatch(/do not move/i);
    for (const reader of LEGACY_ONLY_READERS) expect(recommendation).toContain(reader);
    expect(recommendation).toMatch(/readSettings\(\)/);
  });

  it('a conflict in a feature settings file (not the legacy one) just says rebase', () => {
    const c = {
      cloneKey: 'k', rebuild: { adopted: { applied: [], head: 'h' } },
      alerts: [
        { at: NOW - MINUTE, kind: 'overlay-conflict-unresolved', detail: { ref: 'lane/f', pr: 3, files: ['scripts/settings/x.json'] } },
        { at: NOW - MINUTE, kind: 'overlay-conflict-dropped', detail: { ref: 'lane/f' } },
      ],
    };
    const [r] = overlayDropped.evaluate({ selfSync: [c] }, { now: NOW });
    expect(r.measure.settingsOnly).toBe(true);
    expect(r.recommendation).toMatch(/rebase/);
    expect(r.recommendation).not.toContain(LEGACY_ONLY_READERS[0]);
  });

  it('never flags an applied overlay or one the rebuild unregistered (merged)', () => {
    const subjects = rows.map((r) => r.subject).join(' ');
    expect(subjects).not.toMatch(/fixd-supersede-verdict|priority-class-s1/);
  });

  it('clears once the adopted build applies it again', () => {
    const c = asProbe(live.clone);
    c.rebuild.adopted.applied = [...c.rebuild.adopted.applied, { ref: 'lane/main-red-owner', pr: 4527, sha: 'x' }];
    expect(overlayDropped.evaluate({ selfSync: [c] }, { now: NOW })).toEqual([]);
  });
});

describe('overlay-dropped — rule edges', () => {
  const T = Date.parse('2026-10-09T05:00:00Z');
  const clone = (alerts, applied = []) => ({ cloneKey: 'k', alerts, rebuild: { adopted: { applied, head: 'h' } } });

  it('a stale drop (no rebuild re-logged it within freshMs) is not a breach — it was unregistered by hand', () => {
    const c = clone([{ at: T - 60 * MINUTE, kind: 'overlay-conflict-dropped', detail: { ref: 'lane/a', reason: 'conflict' } }]);
    expect(droppedOverlays(c, { now: T, freshMs: 30 * MINUTE })).toEqual([]);
  });

  it('a drop older than its auto-drop (merged/closed) is not a breach', () => {
    const c = clone([
      { at: T - 2 * MINUTE, kind: 'overlay-conflict-dropped', detail: { ref: 'lane/a' } },
      { at: T - MINUTE, kind: 'overlay-auto-dropped', detail: { ref: 'lane/a', reason: 'pr-merged' } },
    ]);
    expect(droppedOverlays(c, { now: T, freshMs: 30 * MINUTE })).toEqual([]);
  });

  it('a code conflict is not settings-only and tells the PR to rebase', () => {
    const c = clone([
      { at: T - MINUTE, kind: 'overlay-conflict-unresolved', detail: { ref: 'lane/b', pr: 7, sha: 's', files: ['scripts/a.mjs', 'scripts/dispatch-settings.json'] } },
      { at: T - MINUTE, kind: 'overlay-conflict-dropped', detail: { ref: 'lane/b' } },
    ]);
    const [r] = overlayDropped.evaluate({ selfSync: [c] }, { now: T });
    expect(r.measure.settingsOnly).toBe(false);
    expect(r.recommendation).toMatch(/PR #7\) must rebase onto main/);
  });

  it('a pinned overlay skipped for a conflict counts as dropped too', () => {
    const c = clone([{ at: T - MINUTE, kind: 'pinned-overlay-conflict-skipped', detail: { ref: 'lane/p', pr: 9 } }]);
    expect(droppedOverlays(c, { now: T, freshMs: 30 * MINUTE }).map((d) => d.ref)).toEqual(['lane/p']);
  });

  it('settings: freshMinutes from the declared file, built-in on junk', () => {
    expect(resolveOverlayDroppedSettings({ overlayDropped: { freshMinutes: 45 } }).freshMinutes).toBe(45);
    expect(resolveOverlayDroppedSettings({ overlayDropped: { freshMinutes: 'x' } }).freshMinutes).toBe(OVERLAY_DROPPED_BUILT_IN.freshMinutes);
    expect(resolveOverlayDroppedSettings(null).freshMinutes).toBe(30);
    expect(overlayDropped.freshMs).toBe(30 * MINUTE);
  });

  it('settings: the module reads the merged settings at load (a non-default window is honoured)', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/settings-files.mjs', async (orig) => ({
      ...(await orig()),
      readSettings: () => ({ overlayDropped: { freshMinutes: 77 } }),
    }));
    try {
      const mod = await import('../overlay-dropped.mjs');
      expect(mod.default.freshMs).toBe(77 * MINUTE);
      // behaviour around that configured cutoff: a drop 60 min old is still fresh under 77, stale under the 30 default
      const c = { cloneKey: 'k', rebuild: { adopted: { applied: [], head: 'h' } },
        alerts: [{ at: NOW - 60 * MINUTE, kind: 'overlay-conflict-dropped', detail: { ref: 'lane/w' } }] };
      expect(mod.default.evaluate({ selfSync: [c] }, { now: NOW })).toHaveLength(1);
      expect(overlayDropped.evaluate({ selfSync: [c] }, { now: NOW })).toHaveLength(0);
    } finally {
      vi.doUnmock('../../../lib/settings-files.mjs');
      vi.resetModules();
    }
  });

  it('settings: an unreadable settings reader falls back to the built-in window', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/settings-files.mjs', async (orig) => ({
      ...(await orig()),
      readSettings: () => { throw new Error('boom'); },
    }));
    try {
      const mod = await import('../overlay-dropped.mjs');
      expect(mod.default.freshMs).toBe(30 * MINUTE);
    } finally {
      vi.doUnmock('../../../lib/settings-files.mjs');
      vi.resetModules();
    }
  });
});
