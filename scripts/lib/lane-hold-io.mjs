/**
 * @file lane-hold-io.mjs — the IO half of the lane hold rule (`laneHoldVerdict`, we:scripts/lib/lane-lease.mjs;
 * card #xbdixjc). Reads one lane's plain facts — the await-verify
 * records that name it, its verify record, its current commit and (only when the rule needs it) whether it holds
 * unpushed work — and asks the pure rule. Every path that releases, resets, removes or reclaims a lane calls
 * {@link checkLaneHold}: `we:scripts/lane-pool.mjs` (release, acquire, trim, reclaim, refresh, the acquire-time
 * reaper) and `we:scripts/conveyor/lease-reaper.mjs`. Reads only; never throws.
 */
import { statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { laneHoldVerdict, laneHoldNeedsWorkState, resolveLaneHoldSettings } from './lane-lease.mjs';
import { readVerifyMarker, VERIFY_FILENAME } from './lane-verify.mjs';
import { laneHead, laneStateSnapshot } from './lane-history.mjs';
import { readAwaitVerifyRecord, listStoredAwaitVerify, awaitVerifyStoreDir } from '../conveyor/await-verify.mjs';

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Map a raw verify record to the rule's plain shape; null when there is none. */
export function verifyFactFromRecord(record, { markerMtimeMs = null } = {}) {
  if (!record) return null;
  if (record.corrupt) return { state: 'unreadable', revision: null, atMs: markerMtimeMs };
  const state = record.status === 'running' ? 'running' : record.status === 'green' ? 'passed' : 'failed';
  const at = Date.parse(state === 'running' ? record.startedAt : (record.finishedAt ?? record.startedAt));
  return { state, revision: typeof record.sha === 'string' ? record.sha : null, atMs: Number.isFinite(at) ? at : markerMtimeMs };
}

/** Await-verify records that name this lane: the lane-local one, plus every shared-store record bound to it. */
export function awaitFactsForLane(dir, { storeDir = awaitVerifyStoreDir(), list = listStoredAwaitVerify, readLocal = readAwaitVerifyRecord } = {}) {
  const out = [];
  const push = (record) => {
    const at = Date.parse(record?.requestedAt);
    if (record && record.v === 1 && Number.isFinite(at)) out.push({ requestedAtMs: at });
  };
  push(readLocal(dir));
  const lane = realOr(dir);
  for (const { record } of list({ dir: storeDir })) {
    if (typeof record?.lane === 'string' && realOr(record.lane) === lane) push(record);
  }
  return out;
}

/**
 * Gather the facts and decide. `unpushed` may be passed when the caller already knows it; otherwise it is read
 * (git) only when the rule needs it. Fails closed: any read error leaves a fact unknown, which the rule treats
 * as a hold wherever it matters.
 * @param {string} dir lane directory
 * @param {{action:string, byHolder?:boolean, nowMs?:number, unpushed?:boolean|null, settings?:object, env?:object, storeDir?:string}} opts
 * @returns {{allowed:boolean, hold:string|null, reason:string, facts:object}}
 */
export function checkLaneHold(dir, { action, byHolder = false, nowMs = Date.now(), unpushed, settings, env = process.env, storeDir } = {}) {
  const resolved = settings ?? resolveLaneHoldSettings({ env });
  const facts = { action, byHolder, nowMs, awaits: [], verify: null, revision: null, unpushed: unpushed ?? null };
  try {
    facts.awaits = awaitFactsForLane(dir, storeDir ? { storeDir } : {});
    const gitDir = join(dir, '.git');
    const record = readVerifyMarker(gitDir);
    let mtime = null;
    if (record?.corrupt) { try { mtime = statSync(join(gitDir, VERIFY_FILENAME)).mtimeMs; } catch { mtime = nowMs; } }
    facts.verify = verifyFactFromRecord(record, { markerMtimeMs: mtime });
    facts.revision = laneHead(dir);
    if (typeof unpushed !== 'boolean' && laneHoldNeedsWorkState(facts, resolved)) facts.unpushed = laneStateSnapshot(dir).unpushed;
  } catch {
    // A failed read must never read as "nothing here": hold unless the rule is off.
    if (resolved.mode !== 'off') return { allowed: false, hold: 'work-state-unknown', reason: 'lane-hold: lane facts unreadable — never act blind', facts };
  }
  return { ...laneHoldVerdict(facts, resolved), facts };
}

/** The journal fields a refusal records (no raw paths). */
export function laneHoldJournalFields(verdict) {
  return { hold: verdict.hold, holdReason: verdict.reason, awaitsLive: verdict.facts?.awaits?.length || undefined,
    verifyState: verdict.facts?.verify?.state };
}
