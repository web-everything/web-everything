/** @file scripts/lib/__tests__/daemon-rebuild-early-timing.test.mjs — Real rebuild timing producer with injected phases. */
import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as locks from '../daemon-clone-lock.mjs';
import * as prepare from '../daemon-rebuild/prepare.mjs';
import * as smoke from '../daemon-rebuild/smoke.mjs';
import * as slots from '../daemon-smoke-slots.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { buildRebuildJobResult } from '../daemon-rebuild/rebuild-job.mjs';
afterEach(() => vi.restoreAllMocks());

it('records reader drain and smoke-slot waits from distinct phases in the job result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'early-timing-'));
  let clock = 1000;
  try {
    vi.spyOn(locks, 'withWriteLock').mockImplementation(async (root, fn) => { clock += 30; return { ok: true, value: await fn() }; });
    vi.spyOn(prepare, 'prepareRebuild').mockImplementation(async () => {
      clock += 200; // planning is neither reader wait nor smoke-slot wait
      return { plan: { finalSha: 'target' }, prevHead: 'head', lease: { token: 'lease' }, alerts: [] };
    });
    const release = vi.fn();
    vi.spyOn(slots, 'acquireSmokeSlot').mockImplementation(async () => { clock += 700; return { acquired: true, release }; });
    vi.spyOn(smoke, 'smokeAndAdopt').mockImplementation(async () => { clock += 900; return { moved: false, readyRecorded: true }; });
    const r = await rebuildClone({ root, env: { WE_DAEMON_STATE_DIR: join(root, 'state') },
      now: () => clock, versions: null, asJob: false, readyOnly: true, skipCheck: null,
      spawnerOwners: () => [], log: { error() {} }, emitEvent: async () => {},
      run: () => ({ status: 0, stdout: '', stderr: '' }) });
    const result = buildRebuildJobResult({ launchedBy: 'early', waitInFlightTickMs: 50 }, r, null);
    expect(result).toMatchObject({ launchedBy: 'early', readyRecorded: true, waitInFlightTickMs: 80, waitSmokeSlotMs: 700 });
    expect(release).toHaveBeenCalledOnce();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
