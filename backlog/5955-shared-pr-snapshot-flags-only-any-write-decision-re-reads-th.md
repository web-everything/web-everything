---
bornAs: xhkx845
kind: story
size: 3
status: resolved
scope: ["we:scripts/lib/pr-snapshot.mjs", "we:scripts/lib/__tests__/pr-snapshot.test.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs", "we:scripts/conveyor/ruling-needed-sweep.mjs", "we:scripts/conveyor/__tests__/ruling-needed.test.mjs", "we:scripts/conveyor/__tests__/ruling-needed-sweep.test.mjs", "we:scripts/conveyor/referral-auto-block.mjs", "we:scripts/conveyor/__tests__/referral-auto-block.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-13"
dateResolved: "2026-10-13"
preparedDate: "2026-10-12"
preparedAgainstSha: "4ac28cbadea0a2519698e37b9930486872e71d83"
tags: []
---

# Shared PR snapshot: flags only, any write decision re-reads the full comment thread

Held finding 216 (2026-10-10). Shared PR listings are discovery evidence, not authority for comment-dependent writes. Preserve the shared cache, but make the review-hold sweep and its ruling-label/auto-block passes re-read live PR state and the complete comment thread before deciding mutations. A trusted clearance or operator ruling after comment 100 must affect the decision.

## Progress

- Completed implementation and queued verification: all six specified suites, including the unchanged pagination suite, passed (151 tests). Final overlap regression plus stronger late operator-ruling and exact-100-thread fixtures passed in the two affected suites (97 tests), bringing covered tests to 152. All forge/subprocess IO in the new proofs is injected; no real PR was mutated.
- Observed call traces match the proof: cleanup reads state then the complete thread before comment/label writes; ruling labels read metadata and paginated comments before ensure/set; composition reads pending state, records the auto-block, then reads ruled state before removing the ruling label. Dry-run performs both reads without writes. Failed reads isolate the PR and retry on the next tick; snapshot objects stay unchanged.
- Final review also fixed overlapping cleanup/heal removal filtering: a successfully removed pending label is not removed again during healing; dry-run reports the same plan.
- The delivery brief reserves gate commands and commits for the wrapper, so check:standards was not run by this agent. Remaining work outside this item is the documented fleet-consumer inventory and operational measurement of the extra reads; no fleet-wide safety claim is made.

- Red proof: the queued pre-change run failed all five new behavioral assertions (late trusted clearance, stale advisory labels, late ruling-label referral, late ruling cancellation, late auto-block referral); 58 existing tests passed. Failures showed incorrect writes or missed work, not import errors.
- Implemented independent fresh metadata/complete-thread boundaries in all three mutation loops, strict required-field checks, per-PR failure diagnostics, and fresh ruling-label reads after auto-block. Preserved cache projection and existing verdict/trust policy. The initial queued implementation run passed all six suites (106 tests); expanded edge-case and composed-pass proofs are complete.

- Implementation sanity read (2026-10-13): the three mutation loops still use snapshot authority as described; the spec remains coherent and buildable. Added behavioral regressions before implementation for a trusted clearance at comment 120, stale advisory labels, late referrals and a late ruling.

- Original premise/scope: the shared snapshot itself truncates comments and review-hold reconciliation decides directly from that cut snapshot; two source files, no tests, size 1. Historical incidents #4708, #4826 and #4938 motivated the card.
- Corrected premise: the cap is inherited from GitHub CLI list/view comment connections, not an explicit slice in the cache. we:scripts/lib/pr-snapshot.mjs:40 includes comments and we:scripts/lib/pr-snapshot.mjs:95 fetches the list unchanged. we:scripts/conveyor/pr-comments-complete.mjs:4 documents the 100-comment list cap; its complete reader is at we:scripts/conveyor/pr-comments-complete.mjs:19, not under the library directory.
- Review-hold already reads state for contradictory verdicts (we:scripts/conveyor/review-hold-reconcile.mjs:159), but that provider uses a plain view read (we:scripts/lib/review-label-provider.mjs:157). It parses those comments while retaining snapshot labels (we:scripts/conveyor/review-hold-reconcile.mjs:160). Ordinary removals happen directly from snapshot labels at we:scripts/conveyor/review-hold-reconcile.mjs:147. Thus neither removing comments from the cache nor merely adding another view call delivers this goal.
- Corrected scope includes the composed writers: we:scripts/conveyor/review-hold-reconcile.mjs:212 and we:scripts/conveyor/review-hold-reconcile.mjs:221 pass the listing into auto-block and ruling-label sweeps. Those plan directly from it at we:scripts/conveyor/referral-auto-block.mjs:76 and we:scripts/conveyor/ruling-needed-sweep.mjs:64. Both need their own live-read boundary so standalone calls remain safe.
- Existing model: we:scripts/conveyor/advisory-label-sweep.mjs:108 combines fresh metadata with paginated comments, and we:scripts/conveyor/advisory-label-sweep.mjs:150 re-plans before writing. Acceptance carry already delegates authoritative checking to restamp (we:scripts/conveyor/accept-carry-sweep.mjs:11); retain that boundary.
- Size changes from 1 to 3: expected changes are approximately 15 lines of snapshot contract documentation, 65 lines in review-hold, 35 lines each in ruling-label and auto-block, plus approximately 20/120/15/60/75 lines in their five test files (about 440 changed lines across nine files). Evidence for the additional IO and test work is the three independent mutation loops cited above. This remains a story; no estimatedLoc field is added.
- Validation repair: the previous scope listed only we:scripts/conveyor/__tests__/ruling-needed.test.mjs for the ruling sweep. That existing suite imports the sweep at we:scripts/conveyor/__tests__/ruling-needed.test.mjs:2, but the required matching scope pattern is we:scripts/conveyor/__tests__/ruling-needed-sweep*.test.mjs. Add planned we:scripts/conveyor/__tests__/ruling-needed-sweep.test.mjs for the live-read boundary regressions around we:scripts/conveyor/ruling-needed-sweep.mjs:64; retain the existing suite for fixture updates and regression coverage. Split the previously estimated 75 ruling-test lines into 15 existing-suite and 60 new-suite lines; total estimate and size 3 remain unchanged.
- Preparation is based on source inspection, not a claim that regressions already pass. No implementation, live mutation, or preparation stamp is performed here.

## Design

1. Document in we:scripts/lib/pr-snapshot.mjs that its comments are potentially partial and cached; even a short array is not a fresh write authorization. Keep the cache schema, projection, TTL, dirty floor and field union unchanged. “Flags only” describes how writers use discovery, not a replacement response containing only booleans.
2. In we:scripts/conveyor/review-hold-reconcile.mjs, use the snapshot only to nominate label cleanup candidates. Before any removal or contradiction healing, resolve the repository once, read live state through the provider, and replace its comments with `readCompletePrComments` from we:scripts/conveyor/pr-comments-complete.mjs. Add an injectable complete-reader seam. Require an open PR, usable labels, a nonempty head and an array of comments; a failed or malformed read skips the PR with a diagnostic. Recompute both the cleanup plan and healing decision from live labels/head/comments, including removal filtering. Preserve the existing verdict rules, trusted-marker parsing and write ordering.
3. Add equivalent injectable live-read boundaries to we:scripts/conveyor/ruling-needed-sweep.mjs and we:scripts/conveyor/referral-auto-block.mjs, reusing the metadata-plus-complete-thread reader in we:scripts/conveyor/advisory-label-sweep.mjs where its fields suffice. For ruling/auto-block candidate selection, visit every listed PR while the relevant pass is enabled: an absent marker in a partial snapshot cannot prove there is no work. Auto-block remains disabled without its existing setting. Compute plans only from the fresh record, retaining current card-readability, dispute and judgment-call rules.
4. Each composed pass obtains its own fresh decision input, including after an earlier pass has written. Do not enrich once and reuse that array as authority for later writes. A read error must never become an empty thread or a successful auto-block result that suppresses the ruling-label pass. Dry-run performs the same reads and planning but no mutations.
5. Scope this delivery to the review-hold mutation chain and the shared snapshot contract. Other snapshot consumers require a separate inventory, not an unsupported assertion that every fleet writer is already safe. Existing advisory and restamp boundaries are reference behavior, not rewrites in this touch set.

## MVP

- Add the snapshot usage contract and an unchanged-projection regression in we:scripts/lib/__tests__/pr-snapshot.test.mjs.
- Implement the three live-read boundaries with injected readers and per-PR failure isolation; update existing fixture providers to supply live state explicitly.
- Add the 120-comment regression to we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs: the first 100 comments lack a clearance, but a trusted current-head clearance at comment 120 prevents healing/removing acceptance.
- Cover late rulings in planned we:scripts/conveyor/__tests__/ruling-needed-sweep.test.mjs, retain and update existing fixtures in we:scripts/conveyor/__tests__/ruling-needed.test.mjs, and cover late referrals in we:scripts/conveyor/__tests__/referral-auto-block.test.mjs. No changes to policy, cache format or shared pagination are required.

## Acceptance

- [A1] Executable: the queued focused suites in the Test plan pass after implementation; the new late-clearance, stale-label and late-ruling regressions must fail against the pre-change implementation.
- [A2] Must refuse all mutations for a candidate whose live state or complete-thread read fails; continue processing other PRs and retry on a later tick.
- [A3] Must apply the same read-before-write rule to source, docs, config and data PRs; no changed-file exemption exists.
- [A4] No candidate is healed from snapshot labels or capped view comments. Dry-run and real execution derive the same plan for the same fresh input.

## Non-goals

- Changing clearance authority, referral policy, comment parsing, cache TTL/locking, REST pagination, or the restamp writer.
- An atomic GitHub read-and-write transaction: changes after the final read remain possible; do not claim this removes all races.
- A fleet-wide consumer migration in this story; record the remaining inventory as a follow-up rather than silently expanding the touch set.

## Edge cases this change must handle

1. **Untrusted text** — pass comments through the existing trusted-marker parsers; never execute comment text or build shell strings from it.
2. **Truncated reads** — use the paginated reader even for 0–99 snapshot comments; test exactly 100 and 120 comments, and failure on the later page. Never fall back to snapshot comments.
3. **Shared state files** — preserve cache format and locking; fresh decision records stay local to each pass, without mutating shared snapshot objects.
4. **Fail closed** — state/comment errors, non-array comments and incomplete required metadata produce a skipped/error result and zero mutation calls for that candidate.
5. **Identity scoping** — resolve one owner/repository per pass and use it with the same PR number for all reads/writes; verify identical PR numbers in different repositories do not share authority.
6. **State over time** — recompute on live labels/head; skip a closed PR, honor labels removed since discovery, and retry failed reads next tick. A subsequent pass re-reads after preceding mutations.
7. **Who wrote it** — preserve author identities from pagination and existing trust checks; a forged clearance at comment 120 must not acquire trusted status.

No receive/write HTTP endpoint is introduced: request body caps, CSRF/origin checks and inbound rate limits are inapplicable. Outbound GitHub reads retain existing throttling, timeouts and bounded process readers. No new state-reset trigger is added.

## Test plan

Run tests only through the host heavy-run queue. In these commands, `we:` names the repository-relative command and test paths; strip that display prefix when executing in the WE checkout.

- `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/pr-snapshot.test.mjs we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs we:scripts/conveyor/__tests__/ruling-needed.test.mjs we:scripts/conveyor/__tests__/ruling-needed-sweep.test.mjs we:scripts/conveyor/__tests__/referral-auto-block.test.mjs`
- Snapshot: retain projected capped comments unchanged, with existing TTL/dirty/lock assertions intact; the fix belongs at consumers.
- Review-hold: 120-comment late trusted clearance; untrusted lookalike; old-head clearance; fresh labels contradict snapshot; closed PR; missing head/labels; reader throw/non-array; a short stale snapshot still triggers a full read; no-candidate avoids the read. Assert reads precede every write and assert zero writes on refused reads.
- Ruling-label: late referral introduces work absent from the first 100 comments; late operator ruling cancels a nominated label addition; existing ruling label is not removed on read failure. Assert ensure-label is also forbidden before successful reading.
- Auto-block: late operator ruling/dispute/judgment prevents an obsolete dispatch, late actionable referral is discovered, setting off does no reads/writes, exact finding keys remain used, and read failure does not report successful blocking.
- Composed sweep: fresh state changes after auto-block; ruling-label obtains a new record. Two PRs with one failed read demonstrate per-PR isolation. Dry-run obtains the same fresh plan with no provider writes or ruling subprocess calls. Inject all IO so tests never contact GitHub.
- Reuse pagination behavior covered by we:scripts/conveyor/__tests__/pr-comments-complete.test.mjs; run that existing suite through the same queue as an integration regression without changing its source.

## Proof plan

1. Add the new behavioral regressions first and run their focused suites through the queue against the old implementation. Preserve assertion failures showing the late marker is ignored or a stale write is attempted, not failures caused only by new import names.
2. Run the implemented focused suites through the same queue. Capture fake-provider call traces proving repository/PR identity, full-read-before-write order, fresh-plan inputs and zero writes on failed reads. Include 120 comments with the decisive record after index 99.
3. Exercise the composed sweep through injected IO, including dry-run and a state change between passes; record expected versus observed label/ruling calls. Do not mutate a real PR to prove this preparation.
4. Run `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` at implementation verification. For this preparation the runner owns checks and stamping. Report any failing gate honestly; a code inspection alone is not runtime proof.

## Follow-ups

- Inventory remaining consumers of `readSharedOpenPrs`, distinguishing discovery-only users, complete-thread readers, and snapshot-authorized writers. File concrete migrations with matching tests for any uncovered writer; this story does not certify the rest of the fleet.
- Measure the additional per-PR calls during the first operational run using existing GitHub call logging. Optimize nomination only where absence in a truncated thread cannot hide work; never restore snapshot-based write authorization to reduce calls.
