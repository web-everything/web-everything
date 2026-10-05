/**
 * @file scripts/conveyor/hiccup-classify.mjs
 * @description The classifier core for auto-filed delivery hiccups (#3421, follow-up build story from the
 *   #3422 ruling). PURE — no I/O, no fs, no child_process. Given the tick core's own already-computed state
 *   (scripts/conveyor/tick-core.mjs) or a dispatched agent's final return text, decides BLOCKING vs
 *   NON-BLOCKING per #3422's ruling:
 *     - BLOCKING: the tick did not proceed for an item — a live guard suppressed its dispatch (the #3416
 *       case, {@link classifySuppressedBuilds}), or a dispatched agent punted to free-form prose instead of
 *       one of the brief's predefined structured one-line returns (the #3412 case,
 *       {@link classifyAgentReturn}). Both are gated behind explicit human approval before their proposed
 *       fix lands or queues — see scripts/conveyor/hiccup-sink.mjs (the mechanical sink) and
 *       scripts/conveyor/learnings-harvest.mjs (the approval-pending gate at harvest time).
 *     - NON-BLOCKING: delivery succeeded but surfaced something worth improving. This is the EXISTING
 *       learnings-drop.mjs shape (a friction/doc-gap/etc. entry with no `blocking` field) — unchanged by
 *       this file, filed straight through with no gate.
 *
 *   Also carries the MISSING-OPERATION confidence/blacklist axis pinned by #3421's 2026-08-31 addendum (the
 *   #3405-ratified halt-and-surface path): {@link assessMissingOperationConfidence} makes the
 *   self-clears/batches/escalate call for a missing-operation finding against five named criteria plus a
 *   standing blacklist, independent of the guard-suppression / free-form-response classification above.
 */

// ── dispatch hiccups (Done-when #1) ────────────────────────────────────────────────────────────────────

// The delivery-agent brief's own predefined one-line return shapes (delivery-agent-brief.md step 10 /
// fix-agent-brief.md / the readiness pre-check's `not-ready` line): `#<num> → <verdict> (...)`. A return
// matching NONE of these is free-form prose — the #3412 shape this classifier exists to catch mechanically.
export const KNOWN_RETURN_PATTERNS = [
  /→\s*PR\s*#\d+/i,
  /→\s*not-ready\b/i,
  /→\s*blocked-on-(?:infra|permission)\b/i,
  /→\s*escalated\b/i,
  /→\s*gate-red\b/i,
];

/** isStructuredReturn(text) → true when `text` matches one of the brief's known one-line return shapes. */
export function isStructuredReturn(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return KNOWN_RETURN_PATTERNS.some((re) => re.test(text));
}

/**
 * classifySuppressedBuilds(suppressedBuilds) → blocking hiccup records, one per tick-core
 * `decisions.suppressedBuilds` entry (`{num, lane, by}` — the live in-flight dispatch guard held this
 * launch, #3416's own case). Pure, derived DIRECTLY off tick-core's own already-computed output — this
 * classifier invents no new guard logic, it only reads the existing `filterLaunches` verdict.
 * @param {Array<{num:*, lane:*, by:string}>} suppressedBuilds
 * @returns {Array<{kind:'guard-suppression', blocking:true, num:*, lane:*, by:string, area:string, proposedFix:string}>}
 */
export function classifySuppressedBuilds(suppressedBuilds) {
  return (Array.isArray(suppressedBuilds) ? suppressedBuilds : [])
    .filter((s) => s && s.num != null)
    .map((s) => ({
      kind: 'guard-suppression',
      blocking: true,
      num: s.num,
      lane: s.lane,
      by: s.by,
      area: 'conveyor dispatch guard',
      proposedFix: `Confirm the live ${s.by === 'lane' ? 'lane' : 'item'} guard holding #${s.num}'s dispatch is still legitimate; if stale, its own TTL should retire it on a later tick.`,
    }));
}

/**
 * classifyAgentReturn({ num, text }) → a blocking hiccup record when `text` (a dispatched delivery/fix/prepare
 * agent's final one-line return, as read by the judgment layer driving the dispatch — the mechanical runner
 * itself spawns no agents and never sees this) matches NONE of {@link KNOWN_RETURN_PATTERNS} — the #3412
 * shape: a real dispatch happened but the agent punted to free-form prose instead of a predefined structured
 * response. Returns `null` when `text` IS a recognized structured shape, or is empty/absent (nothing to
 * classify yet).
 * @returns {{kind:'free-form-response', blocking:true, num:*, area:string, proposedFix:string}|null}
 */
export function classifyAgentReturn({ num, text } = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  if (isStructuredReturn(text)) return null;
  return {
    kind: 'free-form-response',
    blocking: true,
    num,
    area: 'conveyor dispatch agent return',
    proposedFix: `Re-dispatch #${num != null ? num : '?'} with the brief's structured-return requirement reiterated, or fix the brief if the expected return shape itself is ambiguous for this case.`,
  };
}

// ── missing-operation confidence / blacklist axis (#3421 addendum, 2026-08-31) ────────────────────────────

// The named criteria the addendum pins: "security risk, data-leak risk, performance, blast-radius/
// reversibility, and baseline correctness." A criteria map carries a boolean per key — true = flagged.
export const CONFIDENCE_CRITERIA = ['securityRisk', 'dataLeakRisk', 'performance', 'blastRadius', 'baselineCorrectness'];

// Pre-production, light default (per the addendum: "a short list, a loose bar, tightened later once there's
// real usage to tune against"). Case-insensitive substring match against the proposed operation's call text.
// Configurable — this is only the shipped default, not a hardcoded ceiling (the addendum's own point).
export const DEFAULT_OPERATION_BLACKLIST = [
  'rm -rf', 'git push --force', 'git reset --hard', 'drop table', 'drop database', 'sudo ', 'curl | sh', 'chmod 777',
];

/** isBlacklistedOperation(call, blacklist) → true when `call` contains any blacklist entry (case-insensitive). */
export function isBlacklistedOperation(call, blacklist = DEFAULT_OPERATION_BLACKLIST) {
  if (typeof call !== 'string' || !call.trim()) return false;
  const lower = call.toLowerCase();
  return (Array.isArray(blacklist) ? blacklist : []).some((b) => typeof b === 'string' && b && lower.includes(b.toLowerCase()));
}

/**
 * assessMissingOperationConfidence({ call, criteria, blacklist }) → the self-clear/batch/escalate call for a
 * #3405-ratified missing-operation finding, per the #3421 addendum: "every built operation still gets an
 * agent review, always — the confidence call decides whether a HUMAN also has to look at it." The blacklist
 * axis is checked FIRST and independently of confidence — a blacklisted call always escalates even with an
 * otherwise-clean criteria map, matching the addendum's "independent of the confidence call" framing.
 * @param {{ call?:string, criteria?:Record<string,boolean>, blacklist?:string[] }} input
 * @returns {{ selfClears:boolean, batched:boolean, escalate:boolean, reason:string }}
 */
export function assessMissingOperationConfidence({ call, criteria = {}, blacklist = DEFAULT_OPERATION_BLACKLIST } = {}) {
  if (isBlacklistedOperation(call, blacklist)) {
    return { selfClears: false, batched: false, escalate: true, reason: 'blacklisted-call' };
  }
  const flagged = CONFIDENCE_CRITERIA.find((k) => criteria && criteria[k] === true);
  if (flagged) {
    return { selfClears: false, batched: true, escalate: false, reason: `flagged-criterion:${flagged}` };
  }
  return { selfClears: true, batched: false, escalate: false, reason: 'clean' };
}
