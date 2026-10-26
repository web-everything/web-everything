/** Best-effort coordination events shared by daemon processes. */
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
