/**
 * @file scripts/lib/daemon-generation-barrier.mjs — BLUE-GREEN-SWAP S1.2 v2: single-writer handover by ORDERED EXIT.
 *
 * Invariant (I): a new daemon generation performs its first effect only after the supervising gate has
 * confirmed (ESRCH) that the old generation's whole process group is gone. Two generations never act at once,
 * because the old one no longer exists. No fence, no lease field, no mutex (a concurrent fence cannot be made
 * atomic against GitHub, which cannot refuse a stale writer).
 *
 * Pure except for the injected group probe. The gate (S1.1) and blue's exit (S1.4) call these; S1.2 adds no
 * call site. Spec: flow/daemon-profile FLOW-DMN-009..016, 045..050; Standards G2 (YES, on conditions): the
 * ESRCH proof is tied to a start identity recorded at spawn, an unclean blue costs a settle bound plus a
 * reconcile read, and new-session spawns are refused (clause ids FLOW-DMN-051+ pending in daemon-profile v0.1.4).
 */

export const GROUP_PROBE_MS = 100;
export const GROUP_DEATH_TIMEOUT_MS = 30_000;
export const HANDOVER_EXIT_CODE = 77;
/** Default settle bound after an unclean blue: at least blue's `gh` request timeout (S1.4 passes the real one). */
export const DEFAULT_GH_REQUEST_TIMEOUT_MS = 120_000;

/** The only spawns allowed to start a new session/process group; neither can merge. */
export const MERGE_CAPABLE_SPAWN_ALLOWLIST = Object.freeze(['osascript', 'deps-job']);

/**
 * Wait for the whole group to be gone. `'dead'` only on ESRCH AND a matching spawn identity; anything else that
 * is not a plain "still alive until timeout" is `'unknown'` (no promotion). `identity` is the leader's start
 * identity recorded at spawn (pid start time or a spawn nonce); `probeIdentity(pgid)` returns the identity now
 * on that pgid's leader pid, or null when it is gone. A different identity means the pgid was reused: unknown.
 * @returns {Promise<'dead'|'alive'|'unknown'>}
 */
export async function awaitGroupDeath({ pgid, identity = null, probeIdentity = () => null, killGroup, sleep, probeMs = GROUP_PROBE_MS, timeoutMs = GROUP_DEATH_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1 || typeof killGroup !== 'function' || typeof sleep !== 'function') return 'unknown';
  if (identity == null || identity === '') return 'unknown'; // no recorded start identity: the proof cannot be tied to our spawn
  for (let waited = 0; ; waited += probeMs) {
    let now;
    try { now = probeIdentity(pgid); } catch { return 'unknown'; }
    if (now != null && now !== identity) return 'unknown'; // pgid reused by another process
    try { killGroup(pgid, 0); } catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown'; }
    if (waited >= timeoutMs) return 'alive';
    await sleep(probeMs);
  }
}

/**
 * Settle decision for the first act of a new generation. A clean blue (exit 77 AND nothing in flight) needs no
 * wait. Otherwise a request blue sent may still land at the store: green waits until `lastSendAt + bound`
 * (bound >= blue's gh request timeout) and its first act is a reconcile read. Unknown send time waits the full
 * bound from now. Pure.
 * @returns {{waitMs:number, reconcileFirst:boolean, clean:boolean}}
 */
export function settleDecision({ exitCode, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs = DEFAULT_GH_REQUEST_TIMEOUT_MS, settleMs = 0 } = {}) {
  const clean = exitCode === HANDOVER_EXIT_CODE && inFlight === 0;
  if (clean) return { waitMs: 0, reconcileFirst: false, clean: true };
  const bound = Math.max(Number.isFinite(settleMs) ? settleMs : 0, Number.isFinite(ghRequestTimeoutMs) ? ghRequestTimeoutMs : DEFAULT_GH_REQUEST_TIMEOUT_MS);
  const anchor = Number.isFinite(lastSendAt) && Number.isFinite(nowMs) ? lastSendAt : nowMs;
  const waitMs = Number.isFinite(anchor) && Number.isFinite(nowMs) ? Math.max(0, anchor + bound - nowMs) : bound;
  return { waitMs, reconcileFirst: true, clean: false };
}

/**
 * Promote the candidate only when every condition holds; anything absent or unknown refuses.
 * A promotion after an unclean blue still carries the settle decision (wait + reconcile read first).
 */
export function decidePromotion({ exitCode, groupDeath, recordWritten, candidate, expectedDigest, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs, settleMs } = {}) {
  if (groupDeath !== 'dead') return { promote: false, reason: groupDeath === 'alive' ? 'group-alive' : 'group-death-unknown' };
  if (recordWritten !== true) return { promote: false, reason: 'record-not-written' };
  if (!candidate || !Number.isInteger(candidate.pid) || candidate.alive !== true) return { promote: false, reason: 'candidate-dead' };
  if (candidate.ready !== true) return { promote: false, reason: 'candidate-not-ready' };
  if (!expectedDigest || candidate.codeDigest !== expectedDigest) return { promote: false, reason: 'digest-mismatch' };
  if (!Number.isInteger(inFlight) || inFlight < 0) return { promote: false, reason: 'in-flight-unknown' };
  if (exitCode == null) return { promote: false, reason: 'exit-code-unknown' };
  const settle = settleDecision({ exitCode, inFlight, lastSendAt, nowMs, ghRequestTimeoutMs, settleMs });
  if (settle.clean) return { promote: true, to: candidate, waitMs: 0, reconcileFirst: false };
  // Not a clean handover (killed, crashed, not 77, or work in flight): the group is dead, but green settles first.
  return { promote: true, to: candidate, waitMs: settle.waitMs, reconcileFirst: true, unclean: true };
}

/** Blue's pass-boundary check (S1.4 calls it). A refusal means blue keeps passing. */
export function mayHandOver({ holdingLease, paused, currentChild, eoeIdle, sourcesStopped } = {}) {
  if (holdingLease !== true) return { ok: false, reason: 'lease-not-held' };
  if (paused === true) return { ok: false, reason: 'paused' };
  if (currentChild != null) return { ok: false, reason: 'child-running' };
  if (eoeIdle !== true) return { ok: false, reason: 'eoe-busy' };
  if (sourcesStopped !== true) return { ok: false, reason: 'sources-live' };
  return { ok: true };
}

const NEW_SESSION_RE = /detached\s*:\s*(?:true|!0)|\bsetsid\b|start_new_session|new[-_ ]session|setpgid|\bsetsid\(/g;

/**
 * Scan source text for spawns that leave the gate's process group (detached, setsid, new session). Each hit
 * must sit within its allowlisted context (the 300 chars around it name an allowlisted command).
 * @returns {{line:number, text:string}[]} violations
 */
export function scanNewSessionSpawns(source, allowlist = MERGE_CAPABLE_SPAWN_ALLOWLIST) {
  const out = [];
  const text = String(source ?? '');
  for (const m of text.matchAll(NEW_SESSION_RE)) {
    const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
    if (allowlist.some((name) => around.includes(name))) continue;
    out.push({ line: text.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
}
