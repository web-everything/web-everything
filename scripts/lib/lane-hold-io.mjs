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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { laneHoldVerdict, laneHoldNeedsWorkState, resolveLaneHoldSettings, LANE_HOLD_CLOCK_SKEW_MS } from './lane-lease.mjs';
import { readVerifyMarker, VERIFY_FILENAME } from './lane-verify.mjs';
import { laneHead, laneStateSnapshot } from './lane-history.mjs';
import { laneGitHardeningEnv } from './lane-git-hardening.mjs';
import {
  readAwaitVerifyRecord, listStoredAwaitVerify, awaitVerifyStoreDir, resolveAwaitVerifyPath,
  clearAwaitVerifyRecord, clearStoredAwaitVerify,
} from '../conveyor/await-verify.mjs';

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The time a hold is judged by. A record's own time wins when it is a real time no further ahead than clock skew;
 * a missing, unparseable or future-dated one falls back to the record file's mtime (`fallbackMs`) — so a malformed
 * record keeps its protection, and still ages out, instead of silently holding nothing or holding forever.
 */
export function trustedAtMs(at, { fallbackMs = null, nowMs = Date.now() } = {}) {
  return Number.isFinite(at) && at <= nowMs + LANE_HOLD_CLOCK_SKEW_MS ? at : fallbackMs;
}

const VERIFY_STATES = { running: 'running', green: 'passed', red: 'failed', 'infrastructure-failure': 'failed' };

/** Map a raw verify record to the rule's plain shape; null when there is none. A status nobody writes reads as
 *  unreadable (held while the lane holds unpushed work), never as a finished-and-failed verify. */
export function verifyFactFromRecord(record, { markerMtimeMs = null, nowMs = Date.now() } = {}) {
  if (!record) return null;
  if (record.corrupt) return { state: 'unreadable', revision: null, atMs: markerMtimeMs };
  const state = Object.hasOwn(VERIFY_STATES, record.status) ? VERIFY_STATES[record.status] : 'unreadable';
  const at = Date.parse(record.status === 'running' ? record.startedAt : (record.finishedAt ?? record.startedAt));
  return { state, revision: typeof record.sha === 'string' ? record.sha : null, atMs: trustedAtMs(at, { fallbackMs: markerMtimeMs, nowMs }) };
}

/** mtime of `path`, or `nowMs` when it cannot be read (an unknown age reads as fresh: fail closed). */
const mtimeOr = (path, nowMs) => { try { return statSync(path).mtimeMs; } catch { return nowMs; } };

/** Await-verify records that name this lane: the lane-local one, plus every shared-store record bound to it. */
export function awaitFactsForLane(dir, { storeDir = awaitVerifyStoreDir(), list = listStoredAwaitVerify, readLocal = readAwaitVerifyRecord, nowMs = Date.now(), mtimeOf = mtimeOr } = {}) {
  const out = [];
  const push = (record, path) => {
    if (!record || record.v !== 1) return;
    const at = trustedAtMs(Date.parse(record.requestedAt), { fallbackMs: path ? mtimeOf(path, nowMs) : nowMs, nowMs });
    out.push({ requestedAtMs: at });
  };
  const localPath = resolveAwaitVerifyPath(dir);
  const local = readLocal(dir);
  if (local) push(local, localPath);
  else if (localPath) {
    // The reader answers null for a missing file AND for one it cannot parse. A file that is there but unreadable
    // is a parked fixer's record we cannot read: hold by its mtime rather than read it as "nothing here".
    const present = mtimeOf(localPath, null);
    if (present !== null) out.push({ requestedAtMs: trustedAtMs(present, { fallbackMs: nowMs, nowMs }) });
  }
  const lane = realOr(dir);
  for (const { key, record } of list({ dir: storeDir })) {
    if (typeof record?.lane === 'string' && realOr(record.lane) === lane) push(record, join(storeDir, `${key}.json`));
  }
  return out;
}

/**
 * The holder of a lane has released it and nothing is left to lose: the parked-fixer records IT wrote for this lane
 * are dead, and would otherwise refuse every acquire, trim and reclaim of the lane for the whole hold window.
 * Clears only records written by `holders` (the released lease's session / minted holder slug / worker session),
 * so a record another fixer parked on this lane is never touched. Best-effort; returns what it cleared.
 * The caller must NOT call this while the lane still holds unpushed work: the await-verify pass pushes the
 * verified sha from the record, and without the record that push never happens.
 */
export function clearLaneAwaitRecords(dir, { holders = [], storeDir = awaitVerifyStoreDir(), list = listStoredAwaitVerify, readLocal = readAwaitVerifyRecord } = {}) {
  const cleared = [];
  const mine = new Set(holders.filter((h) => typeof h === 'string' && h));
  const isMine = (record) => [record?.who, record?.sessionId].some((id) => typeof id === 'string' && mine.has(id));
  try {
    if (isMine(readLocal(dir)) && clearAwaitVerifyRecord(dir).cleared) cleared.push('lane-local');
    const lane = realOr(dir);
    for (const { key, record } of list({ dir: storeDir })) {
      if (typeof record?.lane === 'string' && realOr(record.lane) === lane && isMine(record) && clearStoredAwaitVerify(key, { dir: storeDir }).cleared) cleared.push(key);
    }
  } catch { /* advisory: a failed clear leaves the hold to expire on its own */ }
  return cleared;
}

/**
 * Gather the facts and decide. `unpushed` may be passed when the caller already knows it; otherwise it is read
 * (git) only when the rule needs it. Fails closed: any read error leaves a fact unknown, which the rule treats
 * as a hold wherever it matters.
 * @param {string} dir lane directory
 * @param {{action:string, byHolder?:boolean, nowMs?:number, unpushed?:boolean|null, settings?:object, env?:object, storeDir?:string, remoteHas?:(dir:string, revision:string)=>boolean, awaitFacts?:typeof awaitFactsForLane}} opts
 * @returns {{allowed:boolean, hold:string|null, reason:string, facts:object}}
 */
export function checkLaneHold(dir, { action, byHolder = false, nowMs = Date.now(), unpushed, settings, env = process.env, storeDir, remoteHas = liveRemoteHasRevision, awaitFacts = awaitFactsForLane } = {}) {
  const resolved = settings ?? resolveLaneHoldSettings({ env });
  const facts = { action, byHolder, nowMs, awaits: [], verify: null, revision: null, unpushed: unpushed ?? null };
  try {
    facts.awaits = awaitFacts(dir, { ...(storeDir ? { storeDir } : {}), nowMs });
    const gitDir = join(dir, '.git');
    const record = readVerifyMarker(gitDir);
    // The marker's mtime stands in for any time the record cannot supply (corrupt, missing, unparseable, future).
    facts.verify = verifyFactFromRecord(record, { markerMtimeMs: record ? mtimeOr(join(gitDir, VERIFY_FILENAME), nowMs) : null, nowMs });
    facts.revision = laneHead(dir);
    if (typeof unpushed !== 'boolean' && laneHoldNeedsWorkState(facts, resolved)) facts.unpushed = laneStateSnapshot(dir).unpushed;
  } catch {
    // A failed read must never read as "nothing here": hold unless the rule is off. The one exception is the
    // holder's own release — the rule allows it whatever the facts say, so a broken read must not stop it.
    if (resolved.mode !== 'off' && !(byHolder === true && action === 'release')) return { allowed: false, hold: 'work-state-unknown', reason: 'lane-hold: lane facts unreadable — never act blind', facts };
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

// Transports a lane's origin may use. `ext::<cmd>` runs a command and is the one a lane URL must never reach.
const LIVE_REMOTE_PROTOCOLS = 'file:git:http:https:ssh';

/**
 * The lane's `remote.origin.url`, read as DATA (`config --file` runs nothing) in a neutral cwd. A lane's `.git/config`
 * is agent-writable, so the URL is only ever a string to hand on: null when it is missing, shaped like an option, or
 * the lane is not a plain clone. A relative local path is resolved against the lane.
 */
function laneOriginUrl(dir) {
  const gitDir = join(dir, '.git');
  if (!statSync(gitDir).isDirectory()) return null;
  const url = execFileSync('git', ['config', '--file', join(gitDir, 'config'), '--get', 'remote.origin.url'], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: laneGitHardeningEnv(process.env),
  }).trim();
  if (!url || url.startsWith('-') || /[\0\n\r]/.test(url)) return null;
  return /^[a-z][a-z0-9+.-]*:|^[^/]+:/i.test(url) ? url : resolve(dir, url);
}

/**
 * Is `revision` the tip of a branch or PR head ref on the live `origin`? One bounded call; false on any error.
 *
 * The call runs in a NEUTRAL directory against the URL read from the lane, never inside the lane: git loads the cwd
 * repo's config, and a lane's own `.git/config` can name programs it then runs with the daemon's credentials
 * (`core.sshCommand`, `core.gitProxy`, `credential.helper`, `remote.origin.uploadpack`, `protocol.ext.allow`…). Pinning
 * a few keys would leave the rest (we:scripts/lib/lane-git-hardening.mjs); loading no lane config closes the class.
 */
export function liveRemoteHasRevision(dir, revision) {
  try {
    const url = laneOriginUrl(dir);
    if (!url) return false;
    const out = execFileSync('git', ['ls-remote', '--', url, 'refs/heads/*', 'refs/pull/*/head'], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: laneGitHardeningEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: LIVE_REMOTE_PROTOCOLS }),
    });
    return out.split('\n').some((line) => line.split(/\s+/)[0] === revision);
  } catch { return false; }
}

/** The journal fields a refusal records (no raw paths). */
export function laneHoldJournalFields(verdict) {
  return { hold: verdict.hold, holdReason: verdict.reason, awaitsLive: verdict.facts?.awaits?.length || undefined,
    verifyState: verdict.facts?.verify?.state };
}
