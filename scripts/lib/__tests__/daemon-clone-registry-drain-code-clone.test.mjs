/**
 * Live 2026-10-09: the drain's overlay list lives on its CODE clone (`.lanes/we-drain-daemon/code`, the daemon's
 * `weCodeClone`), but the seed only named `lane-1`. Every overlay CLI call (`list`, `add`) then classified the code
 * clone's record as "a pool lane" and dropped it (events: stale-record-dropped at 14:26, 14:46, 15:50 ET), so the
 * list could never hold more than the one overlay just added (#4624 vanished each time another was added).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DAEMON_CLONE_SEED, classifyOverlayRecord } from '../daemon-clone-registry.mjs';

describe('the WE drain code clone is a daemon clone', () => {
  it('is seeded beside lane-1', () => {
    expect(DAEMON_CLONE_SEED).toContain(join('.lanes', 'we-drain-daemon', 'code'));
  });
  it('its overlay record stays live (never dropped as a pool lane)', () => {
    const ws = '/nonexistent-ws';
    const rec = { clone: join(ws, '.lanes', 'we-drain-daemon', 'code'), overlays: [{ ref: 'lane/red-main-contain', pr: 4624 }] };
    expect(classifyOverlayRecord(rec, ws)).toEqual({ live: true });
    // an ordinary pool lane still is never a daemon clone
    expect(classifyOverlayRecord({ clone: join(ws, '.lanes', 'web-everything', 'lane-7'), overlays: [{ ref: 'x' }] }, ws).live).toBe(false);
  });
});
