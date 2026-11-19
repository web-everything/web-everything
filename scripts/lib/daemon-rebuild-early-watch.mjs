/** @file scripts/lib/daemon-rebuild-early-watch.mjs — Bounded event signal reader and between-tick scheduler.
 * Missing, corrupt or oversized event evidence defers to the ordinary tick-start rebuild.
 * No fetch or adoption runs here. Each poll reads at most 256 KiB; old history is skipped at boot.
 */
import { openSync, closeSync, fstatSync, readSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { daemonEventsPath } from './daemon-events.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { decideEarlyLaunch } from './daemon-rebuild-early-launch.mjs';

export function resolveEarlyLaunch({ entries = [], env = process.env, log = () => {}, tool } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(new URL('./daemon-rebuild-settings.json', import.meta.url), 'utf8')).earlyLaunch; } catch { tool = {}; }
  }
  const envValues = {};
  if (env.WE_DAEMON_REBUILD_EARLY_LAUNCH !== undefined) envValues.enabled = env.WE_DAEMON_REBUILD_EARLY_LAUNCH === '1';
  if (env.WE_DAEMON_REBUILD_EARLY_DEBOUNCE_MS !== undefined) envValues.debounceMs = Number(env.WE_DAEMON_REBUILD_EARLY_DEBOUNCE_MS);
  const r = cascadePolicy('earlyLaunch', tool, { env, log, envValues,
    standard: { enabled: false, entries: [], debounceMs: 60_000 },
    valid: { enabled: (v) => typeof v === 'boolean', entries: Array.isArray,
      debounceMs: (v) => Number.isFinite(v) && v >= 0 } });
  const listed = entries.some((e) => r.value.entries?.includes(basename(String(e))));
  const enabled = envValues.enabled === false ? false : r.value.enabled === true || listed;
  log(`daemon-self-sync: earlyLaunch.enabled=${enabled} (source ${r.sources.enabled}; entries ${r.sources.entries}); debounceMs=${r.value.debounceMs} (source ${r.sources.debounceMs})`);
  return { enabled, debounceMs: r.value.debounceMs };
}

export function createMainMoveReader({ env = process.env, path = daemonEventsPath({ env }), now = Date.now } = {}) {
  let offset = 0, identity = null;
  try { const s = statSync(path); offset = s.size; identity = `${s.dev}:${s.ino}`; } catch { /* start when created */ }
  return () => {
    let fd;
    try {
      fd = openSync(path, 'r');
      const s = fstatSync(fd), id = `${s.dev}:${s.ino}`;
      if (id !== identity || s.size < offset) { offset = 0; identity = id; }
      if (s.size - offset > 256 * 1024) { offset = s.size; throw new Error('event backlog exceeds 256 KiB'); }
      const buf = Buffer.alloc(s.size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      const text = buf.subarray(0, n).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return null;
      offset += Buffer.byteLength(text.slice(0, end + 1));
      let moved = false;
      for (const line of text.slice(0, end).split('\n')) {
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.kind === 'pr-merged' && (e.repo === 'web-everything' || repoKeyForSlug(e.repo) === 'we')) moved = true;
      }
      return moved ? now() : null;
    } finally { if (fd !== undefined) closeSync(fd); }
  };
}

/** Polling may observe signals during a tick; launching waits until the tick has released all locks. */
export function createEarlyLaunchWatcher({ settings, readSignal, inFlight, launch, now = Date.now,
  schedule = setInterval, cancel = clearInterval, log = () => {} }) {
  let polling = false;
  let active = 0, pending = null, movedAt = null, lastLaunch = null, waitingAt = null, tickWaitMs = 0;
  const poll = async () => {
    if (!settings.enabled || pending || polling) return;
    polling = true;
    try {
      const signal = await readSignal();
      if (Number.isFinite(signal)) movedAt = signal;
      if (movedAt === null) return;
      const d = decideEarlyLaunch({ ...settings, mainMovedAtMs: movedAt, lastLaunchAtMs: lastLaunch,
        jobInFlightForTarget: await inFlight(), nowMs: now() });
      if (!d.launch) return;
      if (active) { waitingAt ??= now(); return; }
      lastLaunch = now();
      // Set pending synchronously before yielding, so tick entry can always join it.
      const waitInFlightTickMs = tickWaitMs;
      tickWaitMs = 0;
      pending = Promise.resolve().then(() => launch({ launchOnly: true, launchedBy: 'early',
        waitInFlightTickMs }));
      waitingAt = null;
      await pending;
    } catch (e) {
      waitingAt = null; tickWaitMs = 0;
      movedAt = null; // incomplete evidence cannot authorize a later launch
      try { log(`daemon-self-sync: early rebuild deferred to tick-start (${String(e?.message ?? e).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160)})`); } catch { /* logging is best effort */ }
    }
    finally { pending = null; polling = false; }
  };
  const timer = settings.enabled ? schedule(poll, 1000) : null;
  timer?.unref?.();
  return { poll, stop: () => { if (timer) cancel(timer); },
    async tick(fn) {
      active += 1;
      try { if (pending) await pending.catch(() => {}); return await fn(); }
      finally {
        active -= 1;
        if (!active && waitingAt !== null) { tickWaitMs += Math.max(0, now() - waitingAt); waitingAt = null; }
      }
    } };
}
