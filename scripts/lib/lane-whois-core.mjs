/**
 * @file scripts/lib/lane-whois-core.mjs
 * @description The PURE decision core behind `scripts/lane-whois.mjs` (#3383). Everything here takes plain
 * data in and returns plain data out - no fs, no git, no `gh`, no clock read - so the classification (the part
 * worth getting right and keeping right) is unit-tested directly, mirroring this repo's existing PURE-core /
 * IO-shell split (`lane-lease.mjs`, `conveyor/lease-reaper.mjs`).
 */

/** Card-id shapes this repo actually uses: a plain number, or an `x`-prefixed 5-7 char slug (mirrors
 * `conveyor/lease-reaper.mjs`'s dispatcher-session grammar and `backlog/*.md` filenames). */
const CARD_ID_RE = /\b(\d{3,5}|x[a-z0-9]{5,7})\b/gi;

/**
 * PURE: guess which backlog card(s) a lane is (or was) working, from whatever local evidence is on hand -
 * changed/untracked file paths under `backlog/`, the HEAD commit subject, and the branch name. Best-effort:
 * over-inclusive is fine (a wrong guess is filtered out downstream by "does this card even exist on main"),
 * under-inclusive would silently blind a lane's whois to its own card.
 * @param {{ paths?: string[], commitSubject?: string, branch?: string }} evidence
 * @returns {string[]} unique card ids, in the order first seen.
 */
export function guessCardIds({ paths = [], commitSubject = '', branch = '' } = {}) {
  const found = [];
  const seen = new Set();
  const add = (id) => { const key = id.toLowerCase(); if (!seen.has(key)) { seen.add(key); found.push(id); } };
  for (const p of paths) {
    const m = /^backlog\/(\d{3,5}|x[a-z0-9]{5,7})-/i.exec(p);
    if (m) add(m[1]);
  }
  for (const text of [commitSubject, branch]) {
    if (!text) continue;
    for (const m of text.matchAll(CARD_ID_RE)) add(m[1]);
  }
  return found;
}

/** Terminal (won't-change-again) PR states, matched case-insensitively against `gh`'s own vocabulary. */
const TERMINAL_PR_STATES = new Set(['merged', 'closed']);

/**
 * PURE: is a lease's holder presumed alive right now? A live lease (unexpired TTL) is a WEAKER signal than an
 * actually-listed live agent session - this just answers the TTL question; `lane-whois.mjs` layers the
 * `claude agents --json` cross-check on top for the stronger "owner alive -> ask" signal.
 */
export function holderPresumedAlive(lease, isLeaseStaleFn, nowMs, ttlMs) {
  return !!lease && !isLeaseStaleFn(lease, nowMs, ttlMs);
}

/**
 * PURE: the four-way verdict #3383 asks for - `in-use | finished-reclaimable | finished-needs-review |
 * unknown-work` - and WHY, from purely already-computed facts.
 *
 * RECLAIM RULE (mirrors the RECLAIM section of #3383's own brief verbatim): a lane is reclaimable only when
 * its card is resolved AND/OR its PR is MERGED/CLOSED (either signal suffices when both exist; whichever
 * signal actually exists must hold), AND every uncommitted/ahead change is PROVABLY present in main or on a
 * remote branch. A lane with NO uncommitted/ahead content at all has nothing to lose, so it is trivially
 * reclaimable regardless of card/PR state - resetting it destroys nothing.
 *
 * @param {object} p
 * @param {boolean} p.holderAlive - a live (unexpired) lease, or a `claude agents --json` hit for its owner.
 * @param {number} p.uncommittedCount - tracked-modified + untracked file count.
 * @param {number} p.aheadCount - local commits not on `origin/<branch>`.
 * @param {string[]} p.cardStatuses - `status` frontmatter field for every guessed card found on main (only the
 *   ones that actually resolved as a real card - a guessed id with no matching file is simply absent here).
 * @param {string[]} p.prStates - `state` for every PR found associated with this lane (`OPEN`/`MERGED`/`CLOSED`,
 *   case-insensitive).
 * @param {boolean} p.preserved - every uncommitted/ahead change is provably present in main or on a remote
 *   branch (vacuously true when there is no such content at all).
 * @returns {{ verdict: 'in-use'|'finished-reclaimable'|'finished-needs-review'|'unknown-work', reason: string }}
 */
export function classifyLaneVerdict({
  holderAlive, uncommittedCount = 0, aheadCount = 0, cardStatuses = [], prStates = [], preserved = true,
}) {
  if (holderAlive) return { verdict: 'in-use', reason: 'lease is live (holder presumed alive)' };

  const hasContent = uncommittedCount > 0 || aheadCount > 0;
  if (!hasContent) {
    return { verdict: 'finished-reclaimable', reason: 'no lease, no uncommitted/ahead content - nothing to lose' };
  }

  const cardsKnown = cardStatuses.length > 0;
  const prsKnown = prStates.length > 0;
  const cardsResolved = cardsKnown && cardStatuses.every((s) => s === 'resolved');
  const prsTerminal = prsKnown && prStates.every((s) => TERMINAL_PR_STATES.has(String(s).toLowerCase()));
  const doneSignal = cardsResolved || prsTerminal;

  if (doneSignal && preserved) {
    return {
      verdict: 'finished-reclaimable',
      reason: `${cardsResolved ? 'card(s) resolved' : 'PR(s) merged/closed'} and every change is provably preserved`,
    };
  }
  if (doneSignal) {
    return {
      verdict: 'finished-needs-review',
      reason: `${cardsResolved ? 'card(s) resolved' : 'PR(s) merged/closed'} but NOT every change is provably preserved - never auto-reclaim`,
    };
  }
  return {
    verdict: 'unknown-work',
    reason: cardsKnown || prsKnown
      ? 'card/PR found but still open - unclear if this lane duplicates live work'
      : 'no card or PR evidence at all for this content - needs a human look',
  };
}
