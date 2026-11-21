/** @file scripts/lib/__tests__/daemon-rebuild-early-timing.test.mjs — Real rebuild timing producer with injected phases. */
import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as locks from '../daemon-clone-lock.mjs';
import * as prepare from '../daemon-rebuild/prepare.mjs';
import * as smoke from '../daemon-rebuild/smoke.mjs';
import * as slots from '../daemon-smoke-slots.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { buildRebuildJobResult, parseRebuildChildOutput } from '../daemon-rebuild/rebuild-job.mjs';
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
    expect(r).toEqual({ moved: false, readyRecorded: true });
    expect(r.timing).toEqual({ waitInFlightTickMs: 30, waitSmokeSlotMs: 700 });
    expect(JSON.parse(JSON.stringify(r))).toEqual({ moved: false, readyRecorded: true });
    const result = buildRebuildJobResult({ launchedBy: 'early', waitInFlightTickMs: 50 }, r, null);
    expect(result).toMatchObject({ launchedBy: 'early', readyRecorded: true, waitInFlightTickMs: 80, waitSmokeSlotMs: 700 });
    expect(release).toHaveBeenCalledOnce();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('preserves both phase waits through the actual CLI JSON boundary into the job result', () => {
  const root = mkdtempSync(join(tmpdir(), 'early-timing-cli-'));
  try {
    // A ready-only build on another branch stops before fetch or smoke, with both waits recorded.
    execFileSync('git', ['init', '-q', '-b', 'timing-fixture', root], { timeout: 5000, maxBuffer: 65536 });
    const stdout = execFileSync(process.execPath, [
      resolve('scripts/lib/daemon-rebuild.mjs'),
      `--clone=${root}`, '--ready-only', '--json',
    ], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WE_DAEMON_STATE_DIR: join(root, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
        WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_DAEMON_AUTO_REBASE: '0', WE_OVERLAY_STALE: '0' },
    });
    const childResult = parseRebuildChildOutput(stdout);
    expect(childResult).toMatchObject({ mutation: 'wrong-branch-heal',
      timing: { waitInFlightTickMs: expect.any(Number), waitSmokeSlotMs: 0 } });
    expect(childResult.timing.waitInFlightTickMs).toBeGreaterThanOrEqual(0);
    const result = buildRebuildJobResult({ launchedBy: 'early', waitInFlightTickMs: 50 }, childResult, null);
    expect(result).toMatchObject({ launchedBy: 'early',
      waitInFlightTickMs: 50 + childResult.timing.waitInFlightTickMs, waitSmokeSlotMs: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
