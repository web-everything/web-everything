---
bornAs: xsim499
kind: story
size: 3
status: active
scope: ["we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling*.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling-io*.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-13"
preparedDate: "2026-10-13"
preparedAgainstSha: "6b4b641a7d59f8fda623db622bc41b243272405e"
tags: []
---

# Automatic referral-ruling policy never overrides an operator ruling

Held finding 230 (2026-10-11, safety). Live #4715 fixer stand-down 03:05Z: "auto-block also re-blocked an operator not-real (#4)". Fix: the auto-policy (actor auto-policy, may only rule block) skips any finding (same key or carried equivalent) that already has an operator ruling on this or an identical-diff earlier head; log the skip; test the #4715 case.

## Acceptance

- [A1] Automatic policy skips a finding with a validated operator ruling (`block`, `card`, or `not-real`) on the current head, including an equivalent finding in another run, or an operator-backed carry onto the current head. An identical-diff earlier head must retain that protection when unchanged-content evidence is available.
- [A2] Each skip identifies repository, PR, head, run/key and protecting ruling; an all-skipped selection succeeds without a ruling comment, ledger event, label mutation or follow-up. A mixed selection blocks only unprotected findings.
- [A3] Automatic policy still only writes `block` and cannot explicitly or implicitly supersede operator rulings. Registered operators retain the existing supersession paths.
- [A4] Must refuse automatic writes on malformed history or unavailable/truncated proof needed to decide protection. Must apply the same protection and conservative proof rules to source, docs, config and data findings.
- [A5] Executable regression: run the new focused test through the host heavy-run queue (command in Test plan); demonstrate failure against the prior implementation and success after implementation.

## Design

Keep enforcement at the sanctioned writer, so both daemon calls and direct operation calls obey it. The existing daemon selects pending exact keys in `we:scripts/conveyor/referral-auto-block.mjs:38-64`; that is insufficient protection against an equivalent re-raised finding or a ruling arriving after selection.

1. Extend `openReferralFindings` in `we:scripts/operations/record-referral-ruling.mjs:66-114` with protection metadata for current-head targets, including open, ruled and disputed targets. Derive it from the authenticated records/operator rulings already returned by the gate. Only a registered operator actor qualifies; the collection also contains `auto-policy` entries, which do not confer operator protection. Bind provenance to repository, PR, source head, source run and source key.
2. Match exact keys within that subject, or the existing `sameFindingForClearing` predicate in `we:scripts/lib/jury-core.mjs:515`. Do not use file name alone or the broad, unscoped `standingRulings` history as proof. Resolve operator-backed carries to their authenticated source ruling; reviewer-only carries do not qualify.
3. Supply earlier-head evidence through the reader in `we:scripts/operations/record-referral-ruling-io.mjs:123-139`. Reuse the existing carry comparison primitives in `we:scripts/operations/review-pr-io.mjs:753-823`: exact cited path, old/new citation windows and complete compare evidence. This is the current implementation's definition of an unchanged finding; identical diffs are covered without inventing a new diff-hash field. A changed citation does not protect a new occurrence; unknown evidence refuses the automatic write rather than treating the finding as unruled. Keep this evidence ephemeral, scoped to the read, and injectable for tests.
4. In `planOperatorRuling`, branch automatic policy before the explicit and implicit supersession paths in `we:scripts/operations/record-referral-ruling.mjs:210-242`. Reject automatic `--supersedes`; partition requested targets into protected skips and eligible blocks, preserving the existing selector numbering before filtering. Return structured skip diagnostics. For an all-skipped request return a no-op verdict with no record/body/follow-up; make the effect builder in `we:scripts/operations/record-referral-ruling.mjs:286-304` handle that shape. Preview exposes the same decisions without writes. Skipping never grants clearance to a finding still held by the gate.
5. Recheck protection from the fresh thread in the post sink, before any ledger append or comment, at `we:scripts/operations/record-referral-ruling-io.mjs:225-234`. Carry run/key identity in the effect payload so this check cannot confuse runs. If protection changed after planning, refuse the stale batch before effects and require a fresh plan; this prevents a stale planned follow-up from running. Emit skip diagnostics through the operation result and the sink's existing warning channel. Preserve head-change refusal, authorship validation, deduplication and ledger failure handling. This closes the observable read/plan/write gap; it does not claim an atomic GitHub compare-and-swap against a comment posted after the final read.

No change to global gate precedence or historical ruling records is required. Protect future automatic writes without rewriting earlier comments or ledger history.

## MVP

One implementation slice in the two scoped source files, with the focused planned `we:scripts/operations/__tests__/record-referral-ruling-auto-policy.test.mjs` covering both. Add metadata and injectable comparison evidence, then automatic-policy partition/no-op behavior, then the pre-write recheck and diagnostics. Preserve operator behavior using the existing `we:scripts/operations/__tests__/record-referral-ruling.test.mjs`, `we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs` and `we:scripts/operations/__tests__/record-referral-ruling-disputed.test.mjs` suites.

## Test plan

- Build a synthetic #4715-shaped regression in the planned focused test: operator `not-real` for finding 4, then an equivalent pending finding in a fresh run. Also test the exact current-head key, operator block/card, backed carry, and earlier head with unchanged comparison evidence. This is a reconstruction of the reported failure, not a captured production replay.
- Verify mixed and all-skipped selections, exact-key and numbered selectors, preview output, no empty ruling record, and zero post/ledger/label/follow-up calls for a no-op.
- Verify automatic explicit and implicit supersession cannot override an operator, while a real operator can still supersede. An earlier automatic block or reviewer-only ruling must not be misclassified as operator protection.
- Negative identity cases: other repository/PR, unrelated key/claim, wrong source run, forged comment, unbacked carry and changed cited lines. Exercise source, docs, config and data paths, including findings without a line number.
- Refuse malformed history, compare errors, truncated file lists, missing patches, rename/deletion and missing source records when protection cannot be established; do not silently convert uncertainty into eligibility.
- Inject a new operator ruling between reader and sink on the same head; require refusal before the first effect, including follow-up. Retain moved-head and ordinary unprotected-block behavior.

Run commands through `node we:scripts/readiness/heavy-admission.mjs run --` (strip the `we:` repository prefix when executing):

- Focused red/green: `npx vitest run we:scripts/operations/__tests__/record-referral-ruling-auto-policy.test.mjs`.
- Regression: `npx vitest run` with `we:scripts/operations/__tests__/record-referral-ruling.test.mjs`, `we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs`, `we:scripts/operations/__tests__/record-referral-ruling-disputed.test.mjs` and `we:scripts/conveyor/__tests__/referral-auto-block.test.mjs` as arguments.
- Standards: `npm run check:standards`, through the same queue.
- I/O regression: `npx vitest run we:scripts/operations/__tests__/record-referral-ruling-io-real.test.mjs`, through the same queue, to retain the existing real-checkout reader and card-resolution coverage.

## Proof plan

Capture red/green output for the focused regression against the old/new writer. Drive the real operation declaration with injected reader and recording sinks, retaining the skip result and the empty effect trace for the all-protected case. For a mixed batch retain the posted record and verify that only the eligible key is present; feed the resulting comments through `mandatoryReferralState` to verify the operator's outcome remains effective and the new unprotected block holds. Capture the same-head late-ruling refusal with zero ledger/post calls. Do not mutate live #4715 to prove the fix. The runner owns preparation stamping and preparation checks; implementation proof remains future work.

## Non-goals

No new referral policy, historical cleanup, change to reviewer/operator precedence in the gate, automatic clearance, or daemon scheduling rewrite. No HTTP receive endpoint is introduced: body caps, CSRF/origin checks and endpoint rate limiting are inapplicable. Existing CLI validation limits, bounded GitHub reads and throttling remain in force; skip handling must not reset shared state.

## Edge cases this change must handle

1. **Untrusted text** — only validated, authenticated structured rulings establish protection; prose cannot impersonate an operator or invent identity.
2. **Truncated reads** — incomplete comparison evidence is unknown and refuses the automatic write.
3. **Shared state files** — no state reset or rewrite; a skip appends nothing to the shared ledger.
4. **Fail closed** — uncertainty leaves existing holds and operator records intact; no automatic clearance or speculative overwrite.
5. **Identity scoping** — repository/PR plus source head/run/key provenance precedes equivalence matching.
6. **State over time** — verify carry evidence and re-read before effects; operator rulings arriving after planning invalidate the automatic batch.
7. **Who wrote it** — distinguish registered operator actors from `auto-policy` even though both use the structured operator-ruling envelope.

## Follow-ups

Atomic protection against a concurrently posted operator comment after the final read requires shared writer serialization or conditional writes; it is outside this bounded writer fix. Historical automatic overrides may need a separate audited repair, never silent rewriting here. No dependency changes are proposed.

## Progress

- Implementation sanity read confirmed the automatic actor still reached the actor-agnostic supersession branches and the sink checked only head movement. Added the focused synthetic #4715 regression and ran it through host heavy admission against the original writer: 20 failed, 5 passed (the failures include missing skips and the same-head late-ruling write).
- Implemented authenticated operator protection metadata for current-head targets, automatic partition/no-op decisions, historical citation comparison using the existing carry primitives, and a fresh protection snapshot check before post or ledger effects. Unknown proof refuses automatic writes when protection cannot otherwise be established; operator supersession remains on its existing path. Protection binds repository, PR, source head, run and key; registered actor matching follows the validator's case rules.
- Proof: the focused regression now passes 35 tests through host heavy admission. It covers the reconstructed #4715 equivalent fresh-run finding, exact and numbered selections, block/card/not-real, operator and reviewer carries, unchanged/changed/unknown citations across source/docs/config/data, malformed history, truncated comparisons, missing sources, preview/no-op effects, deduplication and late-ruling refusal. The real operation engine and effect executor confirm that a late operator ruling halts before the planned follow-up; a fresh plan returns no effects. Mixed-selection assertions retain only the eligible key in the posted record and verify the gate keeps both the operator decision and the remaining holds.
- Regression proof: the existing operator, supersession, disputed, daemon and real-checkout I/O suites passed (100 tests); the ledger failure-handling suite also passed (16 tests). Logs for this delivery session are `/tmp/5963-red.log`, `/tmp/5963-regression.log`, `/tmp/5963-focused-final.log` and `/tmp/5963-ledger.log`. No live PR was mutated. The delivery brief reserves gate commands and commits to the wrapper, so `check:standards` and the commit remain wrapper-owned.
- Validation repair: the previous scope listed only the broad `we:scripts/operations/__tests__/record-referral-ruling*.test.mjs` test pattern; add the explicit matching `we:scripts/operations/__tests__/record-referral-ruling-io*.test.mjs` pattern for the scoped I/O source. The existing `we:scripts/operations/__tests__/record-referral-ruling-io-real.test.mjs` exercises the reader and card resolution against a real checkout. This clarifies test scope without changing the implementation premise, touch-set estimate or size 3; the five completed preparation sections are preserved.
- Research: original premise was held finding 230, reported #4715 stand-down at 03:05Z on 2026-10-11: “auto-block also re-blocked an operator not-real (#4)”. That incident is supplied by the card; no production transcript was replayed during preparation.
- Original scope: only `we:scripts/operations/record-referral-ruling.mjs`, size 1. Corrected scope includes `we:scripts/operations/record-referral-ruling-io.mjs` and matching tests because the current reader discards historical context (`we:scripts/operations/record-referral-ruling-io.mjs:131-137`) and the pre-write read checks only head movement before constructing ledger events (`we:scripts/operations/record-referral-ruling-io.mjs:225-234`).
- Source observation: automatic actor validation only restricts the result to block (`we:scripts/operations/record-referral-ruling.mjs:197-200`); the supersession branches remain actor-agnostic (`we:scripts/operations/record-referral-ruling.mjs:219-235`). Open findings omit standing-ruling provenance (`we:scripts/operations/record-referral-ruling.mjs:86-92`). The goal is not already delivered by these paths.
- Corrected premise: current-head clearances are normally excluded from the open list, but equivalent re-raised findings and supersession paths still need protection. “Identical-diff earlier head” has no diff-hash field here; the established carry mechanism proves unchanged cited lines (`we:scripts/lib/jury-core.mjs:2895-2906`, `we:scripts/operations/review-pr-io.mjs:753-823`). Use that existing proof rather than assuming all earlier matching keys remain protected.
- Size 1 → 3: approximately 90 changed lines for metadata/partition/effect handling in `we:scripts/operations/record-referral-ruling.mjs`, 80 for reader proof and sink recheck in `we:scripts/operations/record-referral-ruling-io.mjs`, and 180 for the focused test plus about 30 lines of existing test adjustments (roughly 380 changed lines). This is a story, so no `estimatedLoc` field is added.
- Preparation changes only this card; no implementation tests were run and no implementation success is claimed. Stamping and checks remain runner-owned.
