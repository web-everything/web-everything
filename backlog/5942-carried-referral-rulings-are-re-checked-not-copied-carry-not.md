---
bornAs: x3or1a2
kind: story
size: 2
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6742d1202f2de0350e0a5a6978cebaa385be8b43"
tags: []
---

# Carried referral rulings are re-checked, not copied; carry note names the real ruler

An earlier block must be re-examined against the current head before it counts there. Unchanged cited lines alone cannot establish that a defect remains. Carry explanations must accurately name the ruling's actor.

## Progress

- Original premise treated all earlier blocks as copied and cited incidents #4715/#4631. Those incident outcomes are historical reports, not independently replayed here.
- Corrected premise: reviewer carry already excludes block results (we:scripts/lib/jury-core.mjs:3140). Operator carry still accepts them at :3120; the sink uses unchanged-line evidence at we:scripts/operations/review-pr-io.mjs:1082–1102. The gate counts a backed carried block at we:scripts/lib/jury-core.mjs:3368–3376. This is the remaining block path.
- The constant at we:scripts/lib/jury-core.mjs:3045 always says “the operator ruled”, although rendering at :3460 already appends a reviewer/operator discriminator. Validation at :3277 requires the literal legacy reason, so changing the constant alone would invalidate stored records.
- Original source scope remains; add the two existing matching tests. Size changes from 1 to 2: approximately 65 source lines in the gate/schema/render logic, 35 in the sink, and 110 test lines across the two suites. This includes legacy-record compatibility, not merely a wording substitution.

## Design

Do not create a new carried operator block solely from unchanged lines. Keep that finding live for the existing current-head finding-specific reviewer and include the earlier ruling as evidence to re-check. Missing, failed or inconclusive review leaves it pending; it never silently clears it. Current-head operator rulings retain their existing precedence.

At read time, a legacy carried block without a counted current-head ruling must likewise remain pending and eligible for the existing withdrawn-carry re-ask path in we:scripts/operations/review-pr-io.mjs:1129. A fresh counted current-head ruling decides through the existing rules. Preserve same-head linked blocks and all independence requirements.

Retain acceptance of the legacy stored reason string. Render actor-correct wording from the backing discriminator (`from.rulingId` for reviewer backing), and distinguish an automatic-policy backing from a human operator when that backing says so. Do not rewrite append-only history or infer authorship from free text. Clearance carry (`card`/`not-real`) retains its existing identity, unchanged-lines, readability and supersession checks.

## MVP

Exclude block results from new carry creation; hold and re-ask legacy block carries rather than counting their old result; render accurate actor wording without breaking old records. Reuse the existing reviewer route and bounded re-ask behavior.

## Test plan

In we:scripts/lib/__tests__/jury-core.test.mjs, exercise a legacy operator block carry with unchanged lines but a fixed surrounding dependency: it remains pending until a current-head ruling. Test fresh block, fresh clearance, failed/untrusted review, same-head operator precedence, reviewer block exclusion, and legacy reason parsing. Snapshot carry text for operator, reviewer and automatic policy backing.

In we:scripts/operations/__tests__/review-pr-io.test.mjs, inject current-head review and changed-line ports. Assert an old block enters review even when the line set is empty; it is not appended as a new carry. Existing legacy carries trigger the bounded re-ask; review failure stays held. Card readability, changed citation, missing backing and current-head rulings retain their guards. Run both suites through the host heavy-admission queue.

## Proof plan

Replay a synthetic two-head referral with identical quoted lines but corrected surrounding logic through the real gate and injected sink. Record that the old block no longer supplies a current-head verdict, that the reviewer actually receives the finding, and that only its counted result changes the gate. Replay an unresolved defect to show a fresh block still blocks. Render an old reviewer-backed clearance to verify the note names the reviewer while its record remains valid. Do not post to live PRs.

## Acceptance

Unchanged lines cannot automatically renew an earlier-head block. Rechecking failure keeps acceptance held; current-head authority remains intact; persisted legacy records still parse and displayed actor attribution is correct.

## Non-goals

No automatic overruling of current-head human rulings, change to clearance carry policy, identity heuristics, or rewriting of historical referral records.

## Edge cases

Untrusted reviewer output and missing independence stamps cannot clear. Truncated/unreadable records stay pending. Keep repo/PR/head/run/finding identity checks and append-only history. Repeated reads must not launch unbounded re-asks. No new endpoint or shared-state format is introduced.

## Follow-ups

Replay the historical incident records only if available with reliable head/ruling identity; do not present the synthetic regression as proof of those incidents' exact causes.
