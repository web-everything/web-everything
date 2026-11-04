/**
 * R555: pluggable source-writer exclusion + eligibility rules for `.operations/runs` archive retention.
 * Plugs into archiveRetention({ withSourceWriterExclusion }). Run records are written by writeJsonAtomic
 * (temp `<name>.<pid>.<uuid>.tmp` + same-fs rename), so a record is "still being written" when a live pid owns a
 * temp sibling or a `<name>.lock` sidecar. Anything unreadable fails CLOSED: the callback is not invoked.
 * The archiver re-stats (dev/ino/size/mtime/ctime) immediately before unlink, which covers an atomic replacement.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isRunRecordTerminal } from '../operations/run-store.mjs';

export const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const TMP = /^(.+)\.(\d+)\.[^.]+\.[^.]+\.tmp$/;
// writeJsonAtomic: `<name>.<pid>.<Date.now()>.<random>.tmp` (plus the run-store `<dest>.<pid>.<uuid>.tmp` form).

/** @returns {(path:string, critical:()=>Promise<void>)=>Promise<void>} */
export function createRunsWriterExclusion({ isPidAlive = pidAlive, list = readdir, read = readFile, } = {}) {
  // Fresh listing on EVERY call (no cache): a writer that started a moment ago must be seen.
  async function livePids(dir) {
    const map = new Map();
    for (const name of await list(dir)) {
      const m = TMP.exec(name);
      if (m) { const pids = map.get(m[1]) ?? []; pids.push(Number(m[2])); map.set(m[1], pids); }
    }
    return map;
  }
  return async (path, critical) => {
    try {
      const name = basename(path);
      if ((await livePids(dirname(path))).get(name)?.some(isPidAlive)) return;
      try {
        const pid = Number(String(await read(join(dirname(path), `${name}.lock`), 'utf8')).trim());
        if (!Number.isSafeInteger(pid) || pid <= 0 || isPidAlive(pid)) return; // unreadable or live: skip
      } catch (e) { if (e.code !== 'ENOENT') return; }
    } catch { return; } // fail closed
    await critical();
  };
}

/**
 * Harvested from the parked lane/runs-retention eligibility rules (R549/R555): only a readable, terminal record
 * may leave; unfinished or resumable review runs and PR evidence stay local. Unreadable = NOT eligible.
 */
export function runRecordEligible(text) {
  let record;
  try { record = JSON.parse(text); } catch { return false; }
  if (!isRunRecordTerminal(record)) return false;
  // Fail closed on unknown shapes: every effect must carry a status known to be final.
  if (!record.effects.every(e => e && typeof e === 'object' && ['declared', 'applied', 'failed'].includes(e.status))) return false;
  if (record.op === 'review-pr') {
    if (record.resumeOf && !record.stepTimings?.some(t => t?.step === 'advise' && t.finishedAt)) return false;
    for (const v of [record.verdict, record.findings?.referralVerdict, record.resumeOf?.verdict]) {
      if (v && (v.verdict === 'needs-human' || (Array.isArray(v.pendingReferrals) && v.pendingReferrals.length > 0))) return false;
    }
  }
  return !record.effects.some(e => e?.result?.pr);
}
