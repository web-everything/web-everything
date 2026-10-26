import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../daemon-rebuild/prepare.mjs', () => ({ prepareRebuild: vi.fn() }));
vi.mock('../daemon-rebuild/smoke.mjs', () => ({ smokeAndAdopt: vi.fn() }));

import { appendDaemonEvent } from '../daemon-events.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';

let scratch;
beforeEach(() => {
  vi.resetAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'we-event-rejections-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('daemon event asynchronous failure isolation', () => {
  it('appendDaemonEvent returns false when storage rejects asynchronously', async () => {
    const appendFile = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    await expect(appendDaemonEvent({ kind: 'rebuild-failed', detail: { reason: 'held' } }, {
      env: { WE_DAEMON_EVENTS: join(scratch, 'events.jsonl') }, appendFile,
    })).resolves.toBe(false);
    expect(appendFile).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('rebuildClone preserves its result when emitEvent rejects (moved=%s)', async (moved) => {
    const head = 'b'.repeat(40);
    const result = moved
      ? { moved: true, adopted: true, head, alerts: [], extra: { retained: true } }
      : { moved: false, reason: 'smoke-rejected', alerts: [], extra: { retained: true } };
    prepareRebuild.mockReturnValue({
      terminal: false, plan: { finalSha: head }, prevHead: 'a'.repeat(40),
      lease: { token: 'rejection-test' }, overlays: [], alerts: [],
    });
    smokeAndAdopt.mockResolvedValue(result);
    const emitEvent = vi.fn().mockRejectedValue(new Error('event sink unavailable'));
    await expect(rebuildClone({
      root: scratch,
      env: {
        WE_DAEMON_STATE_DIR: join(scratch, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
        WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
      },
      versions: null, asJob: false, skipCheck: null,
      lockOpts: { waitMs: 20, pollMs: 1 },
      run: vi.fn(() => { throw new Error('unexpected git'); }),
      runSmoke: vi.fn(() => { throw new Error('unexpected live smoke'); }),
      prState: vi.fn(() => { throw new Error('unexpected PR read'); }),
      emitEvent,
    })).resolves.toBe(result);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0][0]).toMatchObject({
      kind: moved ? 'rebuild-adopted' : 'rebuild-failed',
      detail: moved ? { sha: head } : { reason: 'smoke-rejected' },
    });
  });
});
