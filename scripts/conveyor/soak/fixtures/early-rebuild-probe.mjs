/** @file scripts/conveyor/soak/fixtures/early-rebuild-probe.mjs — Hermetic between-tick main-move probe. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';

export async function probeEarlyRebuild(wrap = withSelfSync, enabled = true, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'early-rebuild-'));
  let clock = 100, signal = null, poll = null, held = false;
  const launches = [];
  let ticks = 0;
  try {
    const daemon = wrap({ tickOnce: () => { ticks += 1; return 'ticked'; } }, {
      root, env: { WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_STATE_DIR: join(root, 'state'), ...options.env },
      entries: ['health-watch.mjs'], earlyLaunch: { enabled, debounceMs: 60 }, rebuildAsJob: Object.hasOwn(options, 'rebuildAsJob') ? options.rebuildAsJob : true,
      earlyLaunchIo: { readSignal: () => { const s = signal; signal = null; return s; }, inFlight: () => false,
        schedule: (fn) => { poll = fn; return { unref() {} }; } },
      now: () => clock, readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
      background: null, versions: null, cloneIdentity: () => 'clone', maxAdoptWaitTicks: 2,
      onRestart: () => { throw new Error('unexpected adoption'); }, log: { error() {} },
      acquireRead: () => { held = true; return { ok: true }; }, releaseRead: () => { held = false; },
      rebuild: async (o) => { launches.push({ ...o, held, ticks }); return { moved: false, reason: 'rebuild-job-started' }; },
    });
    await daemon.tickOnce();
    const tickStart = launches.shift();
    signal = clock = 200;
    // Timer callback is intentionally awaitable in the fixture. Real timers ignore its promise.
    await poll?.();
    clock = 261;
    await poll?.();
    return { launches, ticks, tickStart };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
