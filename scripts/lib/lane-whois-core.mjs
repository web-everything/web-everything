import { isTerminalStatus } from './backlog-status.cjs';
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
 * PURE: does a card id appear, as a whole token (never a bare substring of a longer number/slug), in `text`?
 * Shared by {@link prsMatchingCard} below — one regex construction, not re-derived per call site.
 */
function idAppearsIn(id, text) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text || '');
}

/**
 * PURE, speed follow-up (#3383's own perf note): `lane-whois.mjs` used to call `gh pr list --search <id>` ONCE
 * PER DISTINCT CARD ID (a network round-trip apiece — the dominant cost measured live against the real ~68-lane
 * WE pool, alongside the unbounded ref/commit fallbacks {@link aheadCommitsPreserved-adjacent code} in
 * `lane-whois.mjs` itself bounds). This is the in-process replacement: given the WHOLE repo's PR list (fetched
 * ONCE per run — `lane-whois.mjs#fetchAllPrs`), find every PR that mentions `cardId` as a whole token in its
 * title, head branch name, or body — the same three surfaces a card id realistically shows up in (a `WE #NNNN:`
 * title, a `lane/NNNN-*`/`lane/xSLUG-*` branch, or a body cross-reference). A card id embedded in a LONGER
 * number or slug (`"420"` inside `"4200"`) never matches — the same false-positive `gh --search`'s own
 * relevance ranking would also reject.
 * @param {Array<{number:number, state:string, title?:string, headRefName?:string, body?:string}>} prs
 * @param {string} cardId
 * @returns {Array<{number:number, state:string}>}
 */
export function prsMatchingCard(prs, cardId) {
  return (Array.isArray(prs) ? prs : [])
    .filter((pr) => pr && idAppearsIn(cardId, `${pr.title || ''} ${pr.headRefName || ''} ${pr.body || ''}`))
    .map((pr) => ({ number: pr.number, state: pr.state }));
}

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
  const cardsResolved = cardsKnown && cardStatuses.every((s) => isTerminalStatus(s));
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

/**
 * #4139 — PURE: does a lane's `keep` marker still apply to its CURRENT state? `lane-pool.mjs keep --lane=N`
 * records an operator's "I looked at this, leave it" call alongside a FINGERPRINT of the lane's content at
 * that moment (its HEAD sha, sorted dirty paths, sorted ahead-commit shas) — never a bare boolean — so the
 * decision is scoped to the exact content it was made about. The moment that content changes (a fresh
 * `acquire` resets the lane and it picks up new work, a new commit lands, a file changes), the OLD marker no
 * longer describes what is on disk, and this returns `false` so `we:scripts/lane-whois.mjs`'s report — and
 * downstream, `we:scripts/operations/operator-queue.mjs#laneReclaimQueue`'s "needs your decision" filter —
 * resurfaces the lane instead of trusting a stale call forever. This is the ONE place that comparison is made
 * (never re-derived at either call site), mirroring this file's own "PURE decision core, unit-tested with no
 * fs/git" convention.
 * @param {{fingerprint?: {headSha?: string, dirtyPaths?: string[], aheadShas?: string[]}}|null|undefined} marker
 *   the marker read from disk (`JSON.parse`d `.git/.lane-keep`), or `null`/`undefined` when none exists.
 * @param {{headSha: string, dirtyPaths: string[], aheadShas: string[]}} fingerprint the lane's CURRENT state,
 *   computed fresh by the caller (never trust a caller's stale copy — same discipline as
 *   {@link classifyLaneVerdict}'s own `preserved` re-derivation elsewhere in this codebase).
 * @returns {boolean}
 */
export function keepMarkerApplies(marker, fingerprint) {
  if (!marker || typeof marker !== 'object' || !marker.fingerprint || typeof marker.fingerprint !== 'object') return false;
  const sameArray = (a, b) => (
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  );
  const m = marker.fingerprint;
  return m.headSha === fingerprint.headSha
    && sameArray(m.dirtyPaths, fingerprint.dirtyPaths)
    && sameArray(m.aheadShas, fingerprint.aheadShas);
}

/**
 * #4344 — PURE: is a `finished-reclaimable` lane genuinely ALREADY CLEAN — nothing a `reclaim` would actually
 * change? `classifyLaneVerdict` above calls a lane `finished-reclaimable` the instant it has zero uncommitted/
 * ahead content ("nothing to lose"), with no check that the checkout is actually SITTING at the pool branch's
 * current tip on the right branch. That verdict is still correct as far as it goes — resetting such a lane
 * destroys nothing — but a periodic sweep that reclaims it ANYWAY every single pass (the exact bug this
 * function exists to let a caller avoid) burns a real git-reset process tree for genuinely nothing, every 120s,
 * across every already-idle lane in the pool.
 *
 * NARROWER than "finished-reclaimable": a lane can be clean-relative-to-HEAD (no uncommitted files, no local
 * commits ahead of `origin/<branch>`) yet still be BEHIND the tip — checked out at an old commit because
 * nothing has fast-forwarded it since `origin/<branch>` last moved — or sitting on a stray branch entirely.
 * `reclaim` still does real, useful work on either of those (its `git reset --hard origin/<branch>` actually
 * MOVES `HEAD`), so this must return `false` for them; only an EXACT head-sha match against the pool branch's
 * own current tip, on the expected branch, counts as "already clean" here. `expectedBranch` is optional (a
 * caller that only ever runs one branch pool can omit it) — omitting it just skips the branch-name check
 * rather than failing it.
 *
 * NOT A NEW STALENESS RISK (#4344): `branchTipSha` is
 * this lane's own LOCALLY-known `origin/<branch>` (no fetch of its own — see its call site in `lane-whois.mjs`).
 * That sounds like it could regress a lane whose local tracking ref is stale (real `origin/<branch>` has moved,
 * but this clone hasn't fetched). It does not: `we:scripts/lane-pool.mjs#cmdReclaim` — the ONLY thing that used
 * to run on this exact candidate set — itself resets to `origin/<branch>` with NO fetch of its own either (read
 * its body; there is no `git fetch` anywhere in `cmdReclaim`). So for a lane already sitting at ITS OWN clone's
 * locally-known tip, calling `reclaim` was ALREADY a no-op `git reset --hard` to the identical commit it is
 * already on — this predicate only removes the wasted process tree for that no-op, it changes no resulting git
 * state versus before #4344. Neither this fix nor `reclaim` refreshes a lane's knowledge of `origin/<branch>` —
 * that stays owned by `we:scripts/lane-pool.mjs#cmdRefresh` / an explicit fetch elsewhere, exactly as before.
 * FAILS CLOSED on malformed/missing input, on EVERY field (#4344 review): a count that is not exactly zero (`null`, non-numeric, negative), a missing
 * sha, or (at `reclaimFinishedLanes`'s call site in `we:scripts/conveyor/lane-pool-health-watch.mjs` — see that
 * function) a missing `expectedBranch`
 * all read as "not already clean" (falls through to a real reclaim), never as "assume clean". Omitting a count
 * is deliberately NOT the same as passing `0` — a caller that forgets to supply it must never silently pass.
 * @param {object} p
 * @param {number} [p.uncommittedCount] - must be exactly `0` to pass; anything else (omitted, `null`, `NaN`, a
 *   string, a negative or fractional number) fails closed.
 * @param {number} [p.aheadCount] - same requirement as `uncommittedCount`.
 * @param {number} [p.trackedModified] - optional component of `uncommittedCount`; when this or `untracked` is
 *   supplied, BOTH must be exactly `0` (so components cancelling to a `0` sum fail closed).
 * @param {number} [p.untracked] - see `trackedModified`.
 * @param {string|null} [p.headSha] - this lane's current `HEAD` sha.
 * @param {string|null} [p.branchTipSha] - the pool branch's tip sha, as read from THIS lane's own clone (never
 *   a fresh fetch — the same locally-known ref `aheadCount` was already computed against).
 * @param {string|null} [p.branch] - this lane's current branch name (short form, e.g. `main`).
 * @param {string|null} [p.expectedBranch] - the pool's own branch name (short form); omitted skips this check
 *   (a deliberate opt-out for a caller that never cares about branch name — never use this to mean "unknown").
 * @returns {boolean}
 */
export function isLaneAlreadyClean({
  uncommittedCount = null, aheadCount = null, trackedModified, untracked, headSha = null, branchTipSha = null, branch = null,
  expectedBranch = null,
} = {}) {
  // Exactly zero, never "not positive": a negative (or fractional) count is corrupt input, not a clean lane.
  if (uncommittedCount !== 0 || aheadCount !== 0) return false;
  // Components, when either is supplied, must BOTH be exactly 0 — a `-2 + 2` sum of `0` must not read as clean.
  if ((trackedModified !== undefined || untracked !== undefined) && (trackedModified !== 0 || untracked !== 0)) return false;
  if (!headSha || !branchTipSha || headSha !== branchTipSha) return false;
  if (expectedBranch != null && branch !== expectedBranch) return false;
  return true;
}

/**
 * #4370 — PURE: render one lane's lifecycle-journal entries (oldest first, as `lib/lane-history.mjs#readLaneJournal`
 * returns them) as the `lane-whois --history <lane>` timeline — one line per event: when, what, WHO (actor name,
 * pid, parent pid, script, session), HEAD before→after, the dirty/ahead/unpushed state it found, and why. A
 * loud entry (a destructive action on unpushed work, or a refusal of one) is flagged `⚠`.
 * @param {Array<object>} entries
 * @param {{lane?: number|string}} [o]
 * @returns {string[]}
 */
export function formatLaneTimeline(entries, { lane } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const title = `lane-${lane ?? list[0]?.lane ?? '?'} lifecycle journal`;
  if (!list.length) return [`${title}: no events recorded`];
  const short = (sha) => (sha ? String(sha).slice(0, 9) : '?');
  const lines = [`${title} (${list.length} event${list.length === 1 ? '' : 's'}):`];
  for (const e of list) {
    const a = e.actor || {};
    const detail = [a.pid ? `pid ${a.pid}` : null, a.ppid ? `ppid ${a.ppid}` : null, a.script || null, a.session ? `session ${a.session}` : null]
      .filter(Boolean).join(', ');
    const actor = `${a.name || 'unknown'}${detail ? ` (${detail})` : ''}`;
    const head = e.headBefore || e.headAfter
      ? (e.headBefore && e.headAfter && e.headBefore !== e.headAfter ? `HEAD ${short(e.headBefore)}→${short(e.headAfter)}` : `HEAD ${short(e.headAfter || e.headBefore)}`)
      : null;
    const state = [
      Number.isFinite(e.dirtyBefore) ? `dirty ${e.dirtyBefore}` : null,
      Number.isFinite(e.aheadBefore) ? `ahead ${e.aheadBefore}` : null,
      typeof e.unpushed === 'boolean' ? `unpushed ${e.unpushed ? 'YES' : 'no'}` : null,
    ].filter(Boolean).join(' ');
    const parts = [e.ts || '?', `${e.loud ? '⚠ ' : ''}${e.action || '?'}`, `by ${actor}`, head, state || null].filter(Boolean);
    lines.push(`  ${parts.join('  ')}${e.reason ? `  — ${e.reason}` : ''}`);
  }
  return lines;
}
