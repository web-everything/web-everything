import { readLiveCwds, pidsWithCwdIn } from './lane-salvage.mjs';

export function journalLiveProcessRefusal(dir, livePids, journal) {
  if (!livePids?.length) return false;
  journal(dir, { action: 'reclaim-refused-live-process', livePids,
    reason: `live process cwd inside lane (pids: ${livePids.join(', ')})` });
  return true;
}

export function staleTakeoverHasLiveProcesses(dir, { readCwds = readLiveCwds, journal = () => {} } = {}) {
  let cwds;
  try { cwds = readCwds(); } catch { cwds = null; }
  if (cwds == null) {
    journal(dir, { action: 'reclaim-refused-live-process',
      reason: 'live process cwd probe unreadable (lsof); restore the probe before retrying takeover' });
    return true;
  }
  return journalLiveProcessRefusal(dir, pidsWithCwdIn(cwds, dir), journal);
}
