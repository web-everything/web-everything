import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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

/** Keep verdict progress across marker replacement. Read/write failures propagate: callers must hold reclaim.
 * One small atomic file per lane/session/claim; retries with a different SHA still count as progress.
 */
export function rememberVerifyVerdict({ gitDir, sessionId, claimedAt, marker, stateDir }) {
  const id = createHash('sha256').update(JSON.stringify([gitDir, sessionId, claimedAt])).digest('hex');
  const file = join(stateDir, `last-verdict-${id}.json`);
  let last = null;
  try {
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    if (evidence?.v !== 1 || !Number.isFinite(evidence.finishedAtMs)) throw new Error('unknown verdict progress evidence');
    last = evidence.finishedAtMs;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (marker?.status === 'green' || marker?.status === 'red') {
    const finished = Date.parse(marker.finishedAt ?? '');
    if (Number.isFinite(finished) && (last === null || finished > last)) {
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, finishedAtMs: finished })}\n`);
      renameSync(tmp, file);
      last = finished;
    }
  }
  return last;
}
