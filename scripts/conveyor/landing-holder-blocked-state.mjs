/** Advisory per waiter/holder clocks. Lost history delays escalation; it never releases a hold. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createLandingHolderBlockedState({ repo, env = process.env, io = fs, log = console.error } = {}) {
  const path = env.WE_LANDING_HOLDER_BLOCKED_STATE
    || join(homedir(), '.claude', 'conveyor', `landing-holder-blocked-${String(repo).replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  return {
    path,
    read() {
      try {
        const data = JSON.parse(io.readFileSync(path, 'utf8'));
        if (!data || Array.isArray(data) || typeof data !== 'object'
          || Object.entries(data).some(([key, since]) => !/^[1-9]\d*:[1-9]\d*$/.test(key)
            || typeof since !== 'string' || !Number.isFinite(Date.parse(since)))) {
          throw new Error('invalid pair clocks');
        }
        return new Map(Object.entries(data));
      } catch {
        log('landing-holder-blocked-state: history missing or unreadable; restarting escalation clocks, retaining holds');
        return new Map();
      }
    },
    write(landingHolds) {
      const data = Object.fromEntries(landingHolds.map(({ pr, holder, since }) => [`${pr}:${holder}`, since]));
      io.mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        io.writeFileSync(temp, JSON.stringify(data) + '\n', { mode: 0o600 });
        io.renameSync(temp, path);
      } finally {
        try { io.unlinkSync(temp); } catch { /* rename consumed it, or no temporary file was created */ }
      }
    },
  };
}
