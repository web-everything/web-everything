// A red-team status owned by a FOREIGN host name (the Mac's hostname can change after a crash) can never be probed
// locally, so it stayed "running" forever. It counts as dead once its record has not been rewritten for the stale window.
// A fresh record on a foreign host stays live; an unreadable timestamp holds (never kills). Mirrors the daemon-jobs rule.
export const foreignHostStaleMs = (env = process.env) => /^\d+$/.test(env.WE_RED_TEAM_FOREIGN_HOST_STALE_MS ?? '')
  && Number.isSafeInteger(Number(env.WE_RED_TEAM_FOREIGN_HOST_STALE_MS)) ? Number(env.WE_RED_TEAM_FOREIGN_HOST_STALE_MS) : 1_800_000;

export function foreignHostDead(status, { host, statusAt, now = Date.now(), env = process.env } = {}) {
  if (!status?.host || status.host === host) return false;
  if (!Number.isFinite(statusAt) || statusAt <= 0 || !Number.isFinite(now)) return false;
  return now - statusAt > foreignHostStaleMs(env);
}
