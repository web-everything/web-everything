/**
 * @file scripts/lib/daemon-generation-barrier.mjs — BLUE-GREEN-SWAP S1.2 v2: single-writer handover by ORDERED EXIT.
 *
 * `decidePromotion` refuses unless the caller passes group death 'dead' and escape evidence 'confirmed'.
 * S1 supplies no escape-evidence producer and makes no claim that blue's descendants stay in its process group.
 *
 * Pure except for the injected group probe. S1 adds no call site. The caller appends the handover record
 * before deciding, taking recordWritten from the real append result.
 * Contract: docs/agent/platform-decisions.md#generation-handover-no-source-scan.
 */

export const GROUP_PROBE_MS = 100;
export const GROUP_DEATH_TIMEOUT_MS = 30_000;
export const HANDOVER_EXIT_CODE = 77;
/** Default settle bound after an unclean blue: at least blue's `gh` request timeout (S1.4 passes the real one). */
export const DEFAULT_GH_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Wait for the whole group to be gone. `'dead'` only on ESRCH AND explicit absence of the recorded leader; anything else that
 * is not a plain "still alive until timeout" is `'unknown'` (no promotion). `identity` is the leader's start
 * identity recorded at spawn (pid start time or a spawn nonce); `probeIdentity(pgid)` returns the identity now
 * on that pgid's leader pid, or null when it is gone. A different identity means the pgid was reused: unknown.
 * @returns {Promise<'dead'|'alive'|'unknown'>}
 */
export async function awaitGroupDeath({ pgid, identity = null, probeIdentity = null, killGroup, sleep, probeMs = GROUP_PROBE_MS, timeoutMs = GROUP_DEATH_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1 || typeof killGroup !== 'function' || typeof sleep !== 'function') return 'unknown';
  if (typeof probeIdentity !== 'function') return 'unknown'; // the identity check is mandatory, never defaulted away
  if (!Number.isFinite(probeMs) || !(probeMs > 0) || !Number.isFinite(timeoutMs) || !(timeoutMs >= 0)) return 'unknown';
  if (identity == null || identity === '') return 'unknown'; // no recorded start identity: the proof cannot be tied to our spawn
  for (let waited = 0; ; waited += probeMs) {
    let now;
    try { now = probeIdentity(pgid); } catch { return 'unknown'; }
    if (now !== null && now !== identity) return 'unknown'; // reused pgid or missing identity evidence
    let denied = false;
    try { killGroup(pgid, 0); } catch (error) {
      // ESRCH for -pid does not prove a live pid leads a group. Only null means the leader is gone.
      if (error?.code === 'ESRCH') return now === null ? 'dead' : 'unknown';
      if (error?.code !== 'EPERM') return 'unknown';
      denied = true; // Darwin can report EPERM briefly while an exiting group becomes ESRCH.
    }
    if (waited >= timeoutMs) return denied ? 'unknown' : 'alive';
    await sleep(Math.min(probeMs, timeoutMs - waited));
  }
}

/**
 * Settle decision for the first act of a new generation. A clean blue (exit 77 AND nothing in flight) needs no
 * wait. Otherwise a request blue sent may still land at the store: green waits until `lastSendAt + bound`
 * (bound >= blue's gh request timeout) and its first act is a reconcile read. Unknown send time waits the full
 * bound from now. Pure arithmetic helper; promotion validates explicit bounds before calling it.
 * @returns {{waitMs:number, reconcileFirst:boolean, clean:boolean}}
 */
export function settleDecision({ exitCode, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs = DEFAULT_GH_REQUEST_TIMEOUT_MS, settleMs = 0 } = {}) {
  const clean = exitCode === HANDOVER_EXIT_CODE && inFlight === 0;
  if (clean) return { waitMs: 0, reconcileFirst: false, clean: true };
  // A zero, negative or non-finite timeout is never trusted: it falls back to the default bound.
  const bound = Math.max(Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0, Number.isFinite(ghRequestTimeoutMs) && ghRequestTimeoutMs > 0 ? ghRequestTimeoutMs : DEFAULT_GH_REQUEST_TIMEOUT_MS);
  const anchor = Number.isFinite(lastSendAt) && Number.isFinite(nowMs) ? lastSendAt : nowMs;
  const waitMs = Number.isFinite(anchor) && Number.isFinite(nowMs) ? Math.max(0, anchor + bound - nowMs) : bound;
  return { waitMs, reconcileFirst: true, clean: false };
}

/**
 * Promote the candidate only when every condition holds; anything absent or unknown refuses.
 * Required escapeEvidence must be 'confirmed' by an approved producer; S1 supplies none.
 * Both bounds must be explicit and finite, even for a clean blue; invalid bounds refuse, never default.
 * A promotion after an unclean blue still carries the settle decision (wait + reconcile read first).
 */
export function decidePromotion({ exitCode, groupDeath, escapeEvidence, recordWritten, candidate, expectedDigest, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs, settleMs } = {}) {
  if (groupDeath !== 'dead') return { promote: false, reason: groupDeath === 'alive' ? 'group-alive' : 'group-death-unknown' };
  if (escapeEvidence !== 'confirmed') return { promote: false, reason: 'escape-unconfirmed' };
  if (recordWritten !== true) return { promote: false, reason: 'record-not-written' };
  if (!candidate || !Number.isInteger(candidate.pid) || candidate.pid <= 1 || candidate.alive !== true) return { promote: false, reason: 'candidate-dead' };
  if (candidate.ready !== true) return { promote: false, reason: 'candidate-not-ready' };
  if (!expectedDigest || candidate.codeDigest !== expectedDigest) return { promote: false, reason: 'digest-mismatch' };
  if (!Number.isInteger(inFlight) || inFlight < 0) return { promote: false, reason: 'in-flight-unknown' };
  if (!Number.isInteger(exitCode)) return { promote: false, reason: 'exit-code-unknown' };
  if (!Number.isFinite(ghRequestTimeoutMs) || ghRequestTimeoutMs <= 0) return { promote: false, reason: 'request-timeout-invalid' };
  if (!Number.isFinite(settleMs) || settleMs < 0) return { promote: false, reason: 'settle-bound-invalid' };
  const settle = settleDecision({ exitCode, inFlight, lastSendAt, nowMs, ghRequestTimeoutMs, settleMs });
  if (settle.clean) return { promote: true, to: candidate, waitMs: 0, reconcileFirst: false };
  // Not a clean handover (killed, crashed, not 77, or work in flight): the group is dead, but green settles first.
  return { promote: true, to: candidate, waitMs: settle.waitMs, reconcileFirst: true, unclean: true };
}

/** Blue's pass-boundary check (S1.4 calls it). A refusal means blue keeps passing. */
export function mayHandOver({ holdingLease, paused, currentChild, eoeIdle, sourcesStopped } = {}) {
  if (holdingLease !== true) return { ok: false, reason: 'lease-not-held' };
  if (paused !== false) return { ok: false, reason: 'paused' }; // absent state is not "not paused"
  if (currentChild !== null) return { ok: false, reason: 'child-running' };
  if (eoeIdle !== true) return { ok: false, reason: 'eoe-busy' };
  if (sourcesStopped !== true) return { ok: false, reason: 'sources-live' };
  return { ok: true };
}
