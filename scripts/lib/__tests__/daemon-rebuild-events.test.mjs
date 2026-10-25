import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Exercise the real rebuildClone IO shell with controlled phase outcomes. Git,
// remote PR reads and live smoke are deliberately outside this event contract.
vi.mock('../daemon-rebuild/prepare.mjs', () => ({ prepareRebuild: vi.fn() }));
vi.mock('../daemon-rebuild/smoke.mjs', () => ({ smokeAndAdopt: vi.fn() }));

import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';

const sha = 'b'.repeat(40);
const prevHead = 'a'.repeat(40);
let scratch;
let options;

beforeEach(() => {
  vi.resetAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'we-rebuild-events-'));
  const root = join(scratch, 'review-daemon');
  mkdirSync(root);
  options = {
    root,
    env: {
      WE_DAEMON_STATE_DIR: join(scratch, 'state'),
      WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
      WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
      WE_DAEMON_EVENTS: join(scratch, 'events.jsonl'),
    },
    versions: null, asJob: false, skipCheck: null,
    lockOpts: { waitMs: 20, pollMs: 1 },
    log: { error: vi.fn(), log: vi.fn() },
    // Any accidental real Git, smoke or PR read fails the fixture.
    run: vi.fn(() => { throw new Error('unexpected git'); }),
    runSmoke: vi.fn(() => { throw new Error('unexpected live smoke'); }),
    prState: vi.fn(() => { throw new Error('unexpected PR read'); }),
    emitEvent: vi.fn(),
  };
  prepareRebuild.mockReturnValue({
    terminal: false, plan: { finalSha: sha }, prevHead,
    lease: { token: 'events-test' }, overlays: [], alerts: [],
  });
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function terminal(result) {
  prepareRebuild.mockReturnValue({ terminal: true, result, alerts: [] });
}

function expectEvent(kind, detail) {
  expect(options.emitEvent).toHaveBeenCalledTimes(1);
  expect(options.emitEvent.mock.calls[0][0]).toEqual(expect.objectContaining({
    kind, daemon: basename(options.root), detail,
  }));
}

describe('rebuildClone coordination events', () => {
  it('emits rebuild-adopted once with the adopted SHA after a new-head swap', async () => {
    const result = { moved: true, adopted: true, head: sha, prevHead, plan: { finalSha: sha }, alerts: [] };
    smokeAndAdopt.mockResolvedValue(result);
    expect(await rebuildClone(options)).toEqual(result);
    expectEvent('rebuild-adopted', { sha });
  });

  it('also emits once for a ready candidate adopted during prepare', async () => {
    const result = { moved: true, adopted: true, reason: 'ready-adopted', head: sha };
    terminal(result);
    expect(await rebuildClone(options)).toEqual({ ...result, alerts: [] });
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expectEvent('rebuild-adopted', { sha });
  });

  it.each(['quarantined', 'established-overlay-conflict', 'still-rejected'])(
    'emits rebuild-failed once for a prepare refusal: %s', async (reason) => {
      terminal({ moved: false, reason });
      expect(await rebuildClone(options)).toEqual({ moved: false, reason, alerts: [] });
      expect(smokeAndAdopt).not.toHaveBeenCalled();
      expectEvent('rebuild-failed', { reason });
    },
  );

  it.each(['smoke-threw', 'dispatch-smoke-failed', 'smoke-reused-env-failed'])(
    'emits rebuild-failed once for a smoke refusal: %s', async (reason) => {
      const result = { moved: false, reason, plan: { finalSha: sha }, alerts: [] };
      smokeAndAdopt.mockResolvedValue(result);
      expect(await rebuildClone(options)).toEqual(result);
      expectEvent('rebuild-failed', { reason });
    },
  );

  it.each(['up-to-date', 'ready-pending', 'needs-build', 'no-op', 'already-adopted'])(
    'emits nothing for a no-op result: %s', async (reason) => {
      terminal({ moved: false, reason });
      expect(await rebuildClone(options)).toEqual({ moved: false, reason, alerts: [] });
      expect(options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it('emits nothing when adopt-only returns needs-build', async () => {
    expect(await rebuildClone({ ...options, adoptOnly: true })).toMatchObject({ moved: false, reason: 'needs-build' });
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expect(options.emitEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])('a throwing emitter preserves the complete result (moved=%s)', async (moved) => {
    const result = moved
      ? { moved: true, adopted: true, head: sha, prevHead, alerts: [] }
      : { moved: false, reason: 'dispatch-smoke-failed', alerts: [] };
    smokeAndAdopt.mockResolvedValue(result);
    options.emitEvent.mockImplementation(() => { throw new Error('event sink unavailable'); });
    expect(await rebuildClone(options)).toEqual(result);
    expect(options.emitEvent).toHaveBeenCalledTimes(1);
  });
});
