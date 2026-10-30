/** Best-effort coordination events shared by daemon processes.
 * PR watcher kinds: pr-merged, pr-ready-not-merging, pr-looping, pr-no-progress, ci-job-overdue.
 * Clone maintenance kind: clone-maintenance; detail = { clone, bytesBefore, bytesAfter,
 * freed, durationMs, skipped?, reason? }. Unavailable byte measurements are null.
 * This shared writer deliberately accepts open event kinds. */
import { appendFile as appendFileDefault, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { handoffHome } from '../operations/handoff-home.mjs';

export function daemonEventsPath({ env = process.env, home } = {}) {
  const override = env?.WE_DAEMON_EVENTS;
  return typeof override === 'string' && override.trim()
    ? resolve(override)
    : join(handoffHome({ home }), 'daemon-events.jsonl');
}

/** Append one complete JSON line; unavailable storage never interrupts a daemon. */
export async function appendDaemonEvent(event, {
  env = process.env, home, now = () => new Date(), appendFile = appendFileDefault,
} = {}) {
  try {
    const { kind, repo = 'web-everything', pr, daemon, detail } = event;
    const line = `${JSON.stringify({ at: now().toISOString(), kind, repo, pr, daemon, detail })}\n`;
    const path = daemonEventsPath({ env, home });
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line);
    return true;
  } catch {
    return false;
  }
}
