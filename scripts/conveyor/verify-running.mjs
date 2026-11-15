/** Shared lane verify-running checks for the watchdog and reclaim consumer. */
import { execFileSync } from 'node:child_process';
import { readVerifyMarker, isVerifyAbandoned } from '../lib/lane-verify.mjs';

const lower = (s) => String(s ?? '').toLowerCase();

/** Fresh running marker, independent of SHA (the watchdog measures progress across heads). */
export function isFreshVerifyRunning(marker, nowMs) {
  return marker?.status === 'running' && !isVerifyAbandoned(marker, nowMs);
}

/** True while the lane's verify marker is `running` and fresh for exactly the record's sha. Any read problem is false
 *  (the reclaim then proceeds, as it did before this guard existed). */
export function defaultVerifyRunningFor(record, { exec = execFileSync, readMarker = readVerifyMarker, nowMs = Date.now() } = {}) {
  try {
    if (!record?.lane || !record?.sha) return false;
    const gitDir = String(exec('git', ['-C', record.lane, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 10_000 })).trim();
    const marker = readMarker(gitDir);
    // Fresh only: a `running` marker past the verify TTL is abandoned (the writer is gone), so it holds nothing.
    return marker?.status === 'running' && lower(marker.sha) === lower(record.sha) && !isVerifyAbandoned(marker, nowMs);
  } catch { return false; }
}
