// A red-team status owned by a FOREIGN host name (the Mac's hostname can change after a crash) can never be probed
// locally, so it stayed "running" forever. It counts as dead once its record has not been rewritten for the stale window.
// A fresh record on a foreign host stays live; an unreadable timestamp holds (never kills). Mirrors the daemon-jobs rule.
// The host-name change comes from a crash, so only a record that has not been touched for the window is dead. The setting
// has a 10 minute floor so a zero or tiny value can never turn this into an immediate kill.
export const FOREIGN_HOST_STALE_FLOOR_MS = 600_000;
export const foreignHostStaleMs = (env = process.env) => {
  const raw = env.WE_RED_TEAM_FOREIGN_HOST_STALE_MS ?? '';
  const n = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 1_800_000;
  return Math.max(n, FOREIGN_HOST_STALE_FLOOR_MS);
};

export function foreignHostDead(status, { host, statusAt, now = Date.now(), env = process.env } = {}) {
  if (!status?.host || status.host === host) return false;
  if (!Number.isFinite(statusAt) || statusAt <= 0 || !Number.isFinite(now)) return false;
  return now - statusAt > foreignHostStaleMs(env);
}

// The one stale-owner decision, shared by the evidence reader and the recovery planner so they cannot disagree. A foreign
// record is dead only when it is stale, in this pid namespace (or one that was never recorded), and its pid is not alive
// here with the recorded birth time. An unreadable birth time keeps the pid live (unknown is never a kill).
export function foreignStaleOwnerDead(status, { host, namespace, statusAt, now = Date.now(), env = process.env, isAlive, readPidStart } = {}) {
  if (!foreignHostDead(status, { host, statusAt, now, env })) return false;
  if (status.pidNamespace != null && status.pidNamespace !== namespace) return false;
  return !localPidLive(status, { isAlive, readPidStart });
}

// True while the recorded pid is alive here with the recorded birth time. An unreadable birth time keeps it live; a probe
// that throws propagates so the caller holds the record.
export function localPidLive(status, { isAlive, readPidStart }) {
  return Boolean(isAlive(status.pid)) && (!status.pidStart || (readPidStart(status.pid) ?? status.pidStart) === status.pidStart);
}
