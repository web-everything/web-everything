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
  // Acquire previously took stale leases without any lsof probe, including hermetic mode.
  // Preserve that fail-open behavior on unreadable lsof; explicit reclaim remains fail-closed.
  return journalLiveProcessRefusal(dir, cwds === null ? [] : pidsWithCwdIn(cwds, dir), journal);
}
