/**
 * @file lane-hold-io.mjs — the IO half of the lane hold rule (`laneHoldVerdict`, we:scripts/lib/lane-lease.mjs;
 * card #xbdixjc). Reads one lane's plain facts — the await-verify
 * records that name it, its verify record, its current commit and (only when the rule needs it) whether it holds
 * unpushed work — and asks the pure rule. Every path that releases, resets, removes or reclaims a lane calls
 * {@link checkLaneHold}: `we:scripts/lane-pool.mjs` (release, acquire, trim, reclaim, refresh, the acquire-time
 * reaper) and `we:scripts/conveyor/lease-reaper.mjs`. Reads only; never throws.
 */
import { statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * @param {{action:string, byHolder?:boolean, nowMs?:number, unpushed?:boolean|null, settings?:object, env?:object, storeDir?:string, remoteHas?:(dir:string, revision:string)=>boolean}} opts
 * @returns {{allowed:boolean, hold:string|null, reason:string, facts:object}}
 */
export function checkLaneHold(dir, { action, byHolder = false, nowMs = Date.now(), unpushed, settings, env = process.env, storeDir, remoteHas = liveRemoteHasRevision } = {}) {
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
  const verdict = laneHoldVerdict(facts, resolved);
  if (verdict.hold !== 'verified-unpushed') return { ...verdict, facts };
  // The lane's own remote-tracking refs can be stale: the fix daemon pushes the verified sha to a URL or a PR ref
  // and the lane never fetches (lanes 8, 11, 18 on 2026-10-08 21:25Z were held although their heads were on
  // origin). Ask the live remote before calling verified work unpushed — only when nothing real is uncommitted.
  try {
    const workDirty = laneStateSnapshot(dir).workDirty;
    if (workDirty === 0 && facts.revision && remoteHas(dir, facts.revision)) {
      const pushed = { ...facts, unpushed: false, headOnRemote: true };
      return { ...laneHoldVerdict(pushed, resolved), facts: pushed };
    }
  } catch { /* the hold stands */ }
  return { ...verdict, facts };
}

/** Is `revision` the tip of a branch or PR head ref on the live `origin`? One bounded call; false on any error. */
export function liveRemoteHasRevision(dir, revision) {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/*', 'refs/pull/*/head'], {
      cwd: dir, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return out.split('\n').some((line) => line.split(/\s+/)[0] === revision);
  } catch { return false; }
}

/** The journal fields a refusal records (no raw paths). */
export function laneHoldJournalFields(verdict) {
  return { hold: verdict.hold, holdReason: verdict.reason, awaitsLive: verdict.facts?.awaits?.length || undefined,
    verifyState: verdict.facts?.verify?.state };
}
