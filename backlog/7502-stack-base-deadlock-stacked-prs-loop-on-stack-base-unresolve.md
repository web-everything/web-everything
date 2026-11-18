---
bornAs: x760s7r
kind: story
size: 8
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/scope-bloat.mjs", "we:scripts/conveyor/review-stack-base.mjs", "we:scripts/operations/needs-you-feed.mjs", "we:scripts/conveyor/health-smells/", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs", "we:scripts/conveyor/__tests__/review-stack-base.test.mjs", "we:scripts/conveyor/__tests__/scope-bloat.test.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs", "we:scripts/operations/__tests__/needs-you-suppress.test.mjs"]
dateOpened: "2026-10-29"
preparedDate: "2026-10-29"
preparedAgainstSha: "2293ce09c5ef2b8da44008552a3c17e020a13e14"
tags: []
---

# Stack-base deadlock: stacked PRs loop on stack-base-unresolved with no owner (#6044/#6043)

Stacked PRs #6044/#6043 loop on stack-base-unresolved with no owner: a transient trust miss sets the hold, a stacked accept writes only a reviewed-stack marker that verdictNeverLanded (we:scripts/conveyor/review-referral-hold.mjs:339) ignores, dispatchReviewRow (we:scripts/conveyor/reconcile-core.mjs:1584) runs refuseReferralHold before the scope-bloat fix, and we:scripts/operations/needs-you-feed.mjs:245 suppresses the same-head hold. Fix: honour reviewed-stack markers, order scope-bloat fix first, durable grace for stack-base-pending, needs-you only suppresses referral holds, add a cross-daemon-hold-cycle health smell.

## Design input

Source: the R222 Opus Plan design brief (2026-10-29 15:37 ET), distilled below.

Root causes:
- A transient trust miss (#6033's head moves about 8x a day, and headRefOid lags the ls-remote tip) sets stack-base-unresolved.
- A stacked accept writes only a reviewed-stack marker, but verdictNeverLanded ignores it. The same head is re-reviewed until the same-head hold locks.
- dispatchReviewRow runs refuseReferralHold BEFORE the scope-bloat fix dispatch, so no fixer is ever dispatched.
- needs-you-feed suppresses the same-head hold as "all findings ruled".
- The real blocker is #6033 (review:human + ci-red + advisory:changes).

Invariants: I1 one owned state per stacked PR. I2 no two holds wait on each other (each declares waitsOn). I3 a trusted reviewed-stack marker counts as a verdict. I4 a transient miss never re-routes; only a persistent cause past a time bound does.

Fix steps: A. verdictNeverLanded honours reviewed-stack markers. B. In dispatchReviewRow, for a same-head hold, the scope-bloat fix comes before refuseReferralHold (ruling holds stay first). C. Durable first-seen store with a 15-min grace (stack-base-pending); past the grace, by cause: stack-restack onto the bottom head, stack-retarget-main, needs-you stack-blocked-by-bottom, or stack-base-unresolvable (flapping over 60 min); all bounds via the settings cascade. D. needs-you-feed suppresses only referral holds. E. A cross-daemon-hold-cycle health smell (30 min).

13-test matrix: #6044 loop; #6043 mutual block; ruling hold still wins; trust race; flapping over 60 min; bottom review:human/CI red; real no-containment; bottom merged; refs unreadable short vs long; a 3-PR chain with a single needs-you at the root; same-head needs-you not suppressed; the hold-cycle smell at 31 vs 29 min; durable state across a restart.

## Premise check

Checked against main 17fa4537e1 (2026-10-29 ET). Not delivered; no commit names this card. The cited code is live and the loop is real:
- `verdictNeverLanded` (we:scripts/conveyor/review-referral-hold.mjs:339) clears only on a review:* label or a `reviewed-sha` marker on the head; it never reads a `reviewed-stack` marker.
- `dispatchReviewRow` (we:scripts/conveyor/reconcile-core.mjs:1580, the refusal call at :1584) calls `refuseReferralHold` (defined at :1437) before the `pr.scopeBloat` fix branch (:1585 onward), so a held PR never reaches `mode: 'scope-bloat-rebase'`.
- we:scripts/operations/needs-you-feed.mjs:235-245 (`gateRulingItems`) drops any `ruling-needed` item when `rulingNeeded` returns non-null, with no check that the hold is a referral hold.
- `stack-base-unresolved` is produced in we:scripts/conveyor/scope-bloat.mjs:256 (`laneBase && !stackBase`), from `readStackBase` in we:scripts/conveyor/review-stack-base.mjs; there is no durable record of how long it has been unresolved. No `stack-base-pending`, `waitsOn` or cross-daemon-hold-cycle exists in health-smells/.
Scope correction: scope is right as filed. Test files go under the matching `__tests__/` dirs (not extra scope).

## Design

State model (I1/I2): every stacked PR is in exactly one of `reviewable`, `stack-base-pending` (grace), `fix-owned`, `needs-you`. Every hold row carries `waitsOn` (a PR number or `operator`); a hold whose `waitsOn` chain returns to itself is a cycle (E).

A. In `verdictNeverLanded` (we:scripts/conveyor/review-referral-hold.mjs:339), after the `reviewed-sha` check, also return false when `liveStackMarkers(pr.comments)` (we:scripts/conveyor/review-stack-base.mjs:218, trusted comments only, so I3 holds and an untrusted author's marker never counts) has a marker for this PR whose `topHead` equals the live head. A marker consumed by a later verdict comment is already dropped by `liveStackMarkers`. If the comment read is incomplete (`readCompletePrComments` hit its page/`--limit` bound or errored), the review row neither credits a marker nor reads "no marker": it waits with the named reason `comments-unreadable`, dispatches no review and routes nowhere (handled in the reconcile row, test 1e; edge 2). A marker means "accept held", not "merged": `decideStackDispatch` returns `held` and the PR's owner is the bottom PR (its row declares `waitsOn: <bottom>`); what moves it on is the bottom landing (carry) or the bottom becoming the needs-you root (C), never a re-review of the same head.

B. In `dispatchReviewRow` (we:scripts/conveyor/reconcile-core.mjs:1580-1584), when `pr.referralHold` is a same-head hold and `pr.scopeBloat` carries a KNOWN cause (`stale` or a measured bloat, not `unknown`), run the scope-bloat fix branch first. Definitions: a same-head hold is `referralHold.head === headRefOid` with `referralHoldAutoResolve.outcome` of `resume` or `send-back` (nothing is owed by a person); a ruling hold is the same with the outcome absent or `stay` (a ruling is owed) and keeps the current order: refuse first. `scopeBloat.unknown` (the `stack-base-unresolved` case) never dispatches a fixer here; it goes through C. Extract the scope-bloat branch into a local helper and call it from every path that refuses on the hold: `dispatchReviewRow` and the second `refuseReferralHold` call site (we:scripts/conveyor/reconcile-core.mjs:2378), so no review-row path keeps the deadlock.

C. New durable store `we:stack-base-pending.json` beside the other conveyor state, written with `writeJsonAtomic` + `withFileLock` (we:scripts/lib/atomic-json-file.mjs), keyed per PR (`repo#pr`), not per head, because #6033's head moves about 8x a day; value `{firstSeenAt, lastUnresolvedAt, cause, head}`. Reconcile rows for stacked PRs also carry `waitsOn` (bottom PR number, or `operator`), which E reads. `readStackBase`/scope-bloat's `unknown({reason:'stack-base-unresolved'})` stays a no-op inside the grace (default 15 min, cascade key `stackBase.graceMinutes`); the PR is re-read next tick and the record is cleared only when the base has stayed resolved for a full grace (15 min), so flaps keep their history and count toward the 60-min bound (I4). Past the grace the cause decides, deterministically, in this precedence (first match wins, so exactly one route per PR): bottom merged or closed -> `stack-retarget-main`; then bottom blocked -> `stack-blocked-by-bottom`; then bottom head moved -> `stack-restack`; then refs unreadable -> `stack-base-unresolvable`. In detail: bottom head has moved and the top is not on it -> `stack-restack` fix onto the bottom head; bottom merged or closed -> `stack-retarget-main`; bottom is itself review:human / CI red / advisory:changes -> needs-you `stack-blocked-by-bottom` raised ONCE on the root of the chain (3-PR chain gives one item); refs unreadable (`stack-base-unresolved` persisting) -> after `stackBase.unresolvableMinutes` (default 60, counting flaps because the record is keyed by PR, not head, for the unresolved cause) -> `stack-base-unresolvable` needs-you. Unreadable refs inside the grace never route (fail closed = wait, with a named reason).

D. In `gateRulingItems` (we:scripts/operations/needs-you-feed.mjs:235), suppress only items whose reconcile reason is `review-referrals-pending` (add the reason to the item where the report fields are read, :76-79, so the gate needs no ledger read). Everything else, including a same-head hold, `stack-blocked-by-bottom` and `stack-base-unresolvable` items are kept.

E. New we:scripts/conveyor/health-smells/cross-daemon-hold-cycle.mjs (same shape as `we:fix-loop-no-push.mjs`: `scope: 'repo'`, `probes: ['prs']`, `openAfter`/`closeAfter`, `severity: 'high'`, `action: 'alert'`): builds the `waitsOn` graph from the hold rows and breaches when a cycle (including two PRs each waiting on the other) has stood for >= 30 min (cascade `stackBase.holdCycleMinutes`; 29 min quiet, 31 min breaches).

## MVP

Musts: A, B, C (grace store plus the four post-grace routes), D, E, with the 23 tests below. Cascade keys `stackBase.graceMinutes`, `stackBase.unresolvableMinutes`, `stackBase.holdCycleMinutes` join the settings cascade defaults the other conveyor bounds use (precedent: `cards.batchMaxMinutes`). Build order A, D, B, C, E, one commit each; E is separable if the size-8 build must split. OUT of scope (Follow-ups): unsticking #6033 itself (its review:human/CI-red is the real blocker and belongs to its own lane), auto-closing a stack, a UI for the pending store.

## Test plan

Each goes red on main today for the reason stated (tests 5-10 and 13-23 are red because the new store/route/smell exports or configurable bounds do not exist yet; 1e and 3a-3c are red on today's behaviour; 1b-1d, 1f, 3d and 3e are deliberate guards, green before and after; tests 1, 2, 4, 11 and 12 state their red reason inline); files in the matching `__tests__/` dirs.
1. #6044 loop: head with a trusted reviewed-stack marker and a stale review attempt; `verdictNeverLanded` is false (red: true today, so the head is re-reviewed). Marker eligibility (A), each case in we:scripts/conveyor/__tests__/review-referral-hold.test.mjs:
   - 1a. trusted marker whose `topHead` equals the live head -> false (the case above);
   - 1b. trusted marker for an older `topHead` (the head has moved) -> still true;
   - 1c. marker consumed by a later verdict comment (`liveStackMarkers` drops it) -> true again;
   - 1d. marker authored by an untrusted author -> true (see also test 4);
   - 1e. (in we:scripts/conveyor/__tests__/reconcile-core.test.mjs, a row-level check) incomplete comment read (`readCompletePrComments` hit the page/`--limit` bound, or errored) -> the row neither credits a marker nor reads "no marker": it waits with the named reason `comments-unreadable`, dispatches no review and routes nowhere (fail closed; red: today the partial list is treated as complete).
   - 1f. `foreign repo or PR marker is ignored` in we:scripts/conveyor/__tests__/review-referral-hold.test.mjs: deterministic table of trusted, unconsumed markers with the SAME live `topHead`, varying only repository and PR identity (foreign repo/same PR, same repo/foreign PR, both foreign). With no other verdict evidence, each leaves `verdictNeverLanded` true; a same-repo/same-PR/same-head positive control returns false (1a). The foreign-repo case must retain the same PR number, so head-only and PR-plus-head matching both fail this matrix.
2. #6043 mutual block: #6044 and #6043 hold on each other; the reconcile rows now carry `waitsOn` (C) and the planner emits exactly one owned state with an acyclic chain (red: no `waitsOn` exists and both refuse, nobody owns).
3. Ruling hold still wins: a hold with an owed operator ruling plus scopeBloat refuses `review-referrals-pending` and dispatches no fixer (guards B; green before and after, red if B reorders blindly). Hold bypass and routing outcomes (B), each asserted at BOTH call sites, `dispatchReviewRow` (:1584) and the second `refuseReferralHold` site (:2378), in we:scripts/conveyor/__tests__/reconcile-core.test.mjs:
   - 3a. same-head hold, `referralHoldAutoResolve.outcome` `resume`, known cause `stale` -> `mode: 'scope-bloat-rebase'` fixer dispatched, no `review-referrals-pending` refusal (red: refused today);
   - 3b. same-head hold, outcome `send-back`, measured bloat -> the same fixer dispatched;
   - 3c. same-head hold with `scopeBloat.unknown` (`stack-base-unresolved`) -> no fixer; the row waits as `stack-base-pending` (C);
   - 3d. ruling hold (outcome absent or `stay`) with a known cause -> refuses first, no fixer (the guard above, now per call site);
   - 3e. `referralHold.head` differs from `headRefOid` (head moved) -> not a same-head hold; current order unchanged (refuse first).
4. Trust race: an untrusted-author marker does not count (A), and a trust miss for 5 min stays pending with no route (red: re-routes at once).
5. Flapping over 60 min: unresolved/resolved flaps (each resolved span under the 15-min clear) keep the record's first-seen; past 60 min emits `stack-base-unresolvable` once.
6. Bottom review:human / CI red / advisory:changes past the grace: one `stack-blocked-by-bottom` needs-you, no restack. One case per cause (6a review:human, 6b CI red, 6c advisory:changes), and 6d: the same three inside the grace route nothing.
7. Real no-containment: top not containing bottom head past the grace -> `stack-restack` fix.
8. Bottom merged (8a) or closed unmerged (8b) -> `stack-retarget-main`.
9. Refs unreadable: 10 min -> wait with reason; 61 min -> unresolvable (fail closed both ways).
10. 3-PR chain: one needs-you at the root, none on the middle or top.
11. `non-referral stack items survive ruling suppression` in we:scripts/operations/__tests__/needs-you-suppress.test.mjs: table-driven `gateRulingItems` test with complete live evidence, crossing both ledger outcomes (`rulingNeeded` non-null and null) with otherwise identical `ruling-needed` items whose reconcile reasons are `review-referrals-pending`, the existing same-head reason, `stack-blocked-by-bottom` and `stack-base-unresolvable`. With `rulingNeeded` non-null, both stack items and the same-head item remain unchanged, as does the referral awaiting its ruling. With `rulingNeeded` null (all findings ruled), suppress only `review-referrals-pending` and retain each non-referral item (red: today's gate drops these too). Assert exact kept items in a mixed batch for both outcomes, so suppressing the referral cannot hide either stack action. Keep the same-head regression assertion; it does not substitute for the two stack rows.
12. Hold-cycle smell: cycle aged 29 min no breach, 31 min breach; no cycle no breach.
13. Durable state: write the store, reload in a fresh process/module, the first-seen survives; a torn/corrupt file fails closed (grace restarts, never routes early).
14. Post-grace precedence: bottom both moved and merged -> `stack-retarget-main` (merged wins over restack); bottom moved while it is also review:human -> `stack-blocked-by-bottom`; each pair resolves to exactly one route, never two fixes.
15. Retention (C): resolved for 14 min then unresolved again keeps `firstSeenAt`; resolved for a full 15 min clears the record and a later unresolved span starts a fresh clock.
16. Lifecycle: the record is deleted when the PR closes or merges, and a deleted record does not resurrect on the next tick.
17. Shared state and skew: two writers race on first-seen, the earlier `firstSeenAt` wins (compare-and-set under `withFileLock`); a future `firstSeenAt` counts as zero elapsed.
18. Head moves: a new head resets pending for a head-dependent cause (`stack-restack`; the record is still keyed per PR) but not for `stack-base-unresolved`, so a head that moves 8x a day cannot dodge the 60-min bound.
19. Untrusted text: a PR title or branch name with a newline, backtick or leading `--` reaching `why` or the needs-you text is folded by `foldUntrusted` and stays inert.
20. `pending identities remain isolated and aliases converge` in we:scripts/conveyor/__tests__/review-stack-base.test.mjs: use a temporary shared store and an injected clock, with the same head oid for `(repo A, PR 42)`, `(repo B, PR 42)`, `(repo A, PR 43)` and `(repo B, PR 43)`. Start each unresolved span at a distinct timestamp; reload the store and assert four independent `firstSeenAt` values. Advancing or clearing one identity must leave the other three records unchanged; at the first identity's unresolved timeout, only that identity is eligible and later-started identities still wait. Resolve a fixture card's hash and NNN spellings through the production card resolver to the SAME repo/PR, then write through one spelling and re-read/update through the other: exactly one pending record, the original `firstSeenAt` retained, one timeout/escalation rather than duplicate actions. Exercise both alias orders and reload between operations; distinct cards/PRs must remain separate. This complements head-move test 18, not a reset of its per-PR unresolved clock.

21. `configured grace controls routing` in we:scripts/conveyor/__tests__/reconcile-core.test.mjs and we:scripts/conveyor/__tests__/scope-bloat.test.mjs, with retention assertions in we:scripts/conveyor/__tests__/review-stack-base.test.mjs: deterministic parameterized cases set `stackBase.graceMinutes` to 7 and 22 through the production settings cascade, using an injected clock and fresh store per case. For a readable, moved, unblocked bottom, at `firstSeenAt + configuredGrace - 1 ms` assert pending/no fixer, and at exactly `firstSeenAt + configuredGrace` assert one `stack-restack` dispatch. Separately resolve a pending base: at `resolvedSince + configuredGrace - 1 ms` the record remains and a renewed miss preserves `firstSeenAt`; in a fresh case, at exactly `resolvedSince + configuredGrace` it clears and a later miss starts a new clock. Thus both routing and retention follow the override rather than hardcoded 15 minutes.
22. `configured unresolved timeout controls escalation` in we:scripts/conveyor/__tests__/review-stack-base.test.mjs and we:scripts/conveyor/__tests__/reconcile-core.test.mjs: parameterize `stackBase.unresolvableMinutes` as 37 and 83 through the production settings cascade, keeping grace at 7 minutes to isolate this bound. With refs continuously unreadable, at `firstSeenAt + configuredTimeout - 1 ms` assert wait/no escalation; at exactly `firstSeenAt + configuredTimeout` assert one `stack-base-unresolvable` needs-you; the next tick must not duplicate it. Use injected time and a fresh store per case. These cases reject a hardcoded 60-minute timeout.
23. `configured cycle threshold controls alerts` in we:scripts/conveyor/health-smells/__tests__/cross-daemon-hold-cycle.test.mjs: deterministic parameterized cases resolve `stackBase.holdCycleMinutes` as 11 and 44 through the production settings cascade. For the same continuously observed two-PR cycle, use an injected clock to assert no breach at `cycleSince + configuredThreshold - 1 ms` and a breach at exactly `cycleSince + configuredThreshold`; an acyclic control never breaches. Set `openAfter`/`closeAfter` explicitly in the fixture so sampling hysteresis cannot mask the threshold assertion. These cases reject a hardcoded 30-minute alert bound.

## Proof plan

Before: on the live #6044/#6043 pair, record `reconcile` rows showing `stack-base-unresolved`, the repeated review of the same head, and the suppressed needs-you (daemon log lines + the `needs-you-suppressed` event). After: register the branch via the prototype overlay loader and show the same pair resolved to one owned state (a `stack-blocked-by-bottom` needs-you on #6033 and no repeat review), via a `reconcile` dry-run. The daemon's rebuild smoke is the gate. If the live pair has moved on, replay the recorded rows from the fixture `we:scripts/conveyor/__tests__/fixtures/stack-base-deadlock-rows.json` (captured from the daemon log; the builder commits it) and say so in the PR.

## Acceptance

- [A1] **Executable** — `node we:scripts/operations/run.mjs heavy-admission -- npx vitest run we:scripts/conveyor/__tests__/review-referral-hold.test.mjs` includes the reviewed-stack-marker cases 1a-1d and 1f (foreign repo/PR identity matrix with a matching positive control) and fails before (1a), passes after.
- [A2] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-core.test.mjs we:scripts/conveyor/__tests__/scope-bloat.test.mjs we:scripts/conveyor/__tests__/review-stack-base.test.mjs` covers tests 1e, 2, 3 (3a-3e at both call sites), 4, 5-10 (8a and 8b) and 14-22 (the store tests 13, 15-18 and 20 live in we:scripts/conveyor/__tests__/review-stack-base.test.mjs, including independent repo/PR clocks and hash/NNN alias convergence; the route and precedence tests in the scope-bloat and reconcile-core files). Tests 21-22 exercise the production settings cascade with nondefault grace and unresolved timeouts immediately before and at each threshold, including grace-based retention, and fail if those bounds are hardcoded.
- [A3] **Executable** — `npx vitest run we:scripts/operations/__tests__/needs-you-suppress.test.mjs` covers test 11: same-head, `stack-blocked-by-bottom` and `stack-base-unresolvable` kept with `rulingNeeded` non-null AND null; `review-referrals-pending` retained while a ruling is owed and suppressed only when all findings are ruled, including in mixed batches.
- [A4] **Executable** — `npx vitest run we:scripts/conveyor/health-smells/__tests__/cross-daemon-hold-cycle.test.mjs` covers test 12 at 29 vs 31 min and test 23 immediately before and at each nondefault configured cycle threshold; a hardcoded 30-minute bound fails.
- [A5] **Executable** — the durable-state test (13) passes across a fresh module load, and a corrupt store fails closed.

## Non-goals

- [N1] Does not fix #6033's own review:human / CI-red state, does not auto-close stacks, and adds no UI for the pending store.

## Edge cases this change must handle

1. **Untrusted text** — PR titles/branch names reaching `why`/needs-you text are folded with `foldUntrusted`; reviewed-stack markers are read only from trusted comments (`parseStackMarkers`).
2. **Truncated reads** — comments come via `readCompletePrComments`; a `--limit` hit or an ls-remote/ref read failure is "unreadable" (wait, then unresolvable), never "no marker" or "resolved".
3. **Shared state files** — `we:stack-base-pending.json` written with `writeJsonAtomic` under `withFileLock`; re-read and compare-and-set on first-seen so two daemons cannot reset the clock.
4. **Fail closed** — unreadable or corrupt store, or unreadable refs, restart/hold the grace and name the reason; never route early and never treat as resolved.
5. **Identity scoping** — the store key is repo + PR number (the head oid is a value field, not part of the key, as in C); markers are matched on repo + PR number + head oid (test 1f); hash and NNN spellings of the card resolve to one record while foreign repo/PR clocks remain isolated (test 20); the unresolved-cause record is per PR so flapping heads cannot dodge the 60-min bound (test 18).
6. **State over time** — the record is NOT deleted the moment the base resolves: it is cleared only after the base has stayed resolved for a full grace window (`stackBase.graceMinutes`, C), so a shorter resolved span keeps `firstSeenAt` and flaps still count toward the 60-min bound (tests 5, 15); it is deleted at once only when the PR closes or merges (test 16); a new head resets pending only for head-dependent causes (test 18); first-seen survives a daemon restart (test 13); clock skew (a future first-seen) counts as zero elapsed.
7. **Who wrote it** — only trusted-author `reviewed-stack` comments count as a verdict (I3); a spoofed marker from another author is ignored (test 4).

## Follow-ups

- Unstick #6033 (review:human + ci-red + advisory:changes) in its own lane.
- A board view of `stack-base-pending` records.
- Extend the `waitsOn` model to non-stack holds (fix-claim, drain) once the smell shows real cycles.
