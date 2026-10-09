---
bornAs: x2w940a
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-09-29"
dateStarted: "2026-10-09"
dateResolved: "2026-10-09"
preparedDate: "2026-10-09"
preparedAgainstSha: "0007875ad3f13546d089e71c49a89d50264feb15"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2941's independent review

Add a filing-time source-verification note to we:docs/agent/backlog-workflow.md: backlog claims about workflow behaviour must be checked against the cited workflow before filing. This is the documentation prevention owed by chalbert/web-everything#2941's independent review, not another change to the soak replay gate.

Filed mechanically on approval under the operator rule of 2026-09-27: prevention outstanding is filed by default. The accepted review requested a doc note and explicitly said a deterministic gate was not practical.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2941@afcc37394825026c3975277fdb53b8b102cdd1f2

## Progress

- Original premise/scope: this card scoped only we:backlog/4479-soak-replay-gate-re-reads-the-live-pr-body-on-rerun-so-an-ad.md and cited its line 13 as the location for a filing-time verification note. That line is now frontmatter; the relevant history is in that card's Progress section. Its original proposal included adding an `edited` trigger, which preparation found already present.
- Corrected premise/scope: the reusable note belongs beside “Review before adding (dedup)” under Rules in we:docs/agent/backlog-workflow.md:1215. The existing Rules cover deduplication and authoring hygiene but do not explicitly require checking workflow behaviour against its source at filing time. The broader verification discipline in we:docs/agent/conventions.md under “Provenance” distinguishes a resolvable citation from a true behavioural claim; this note applies that discipline at the filing step.
- Source evidence checked at checkout `bd19057d59fa45c863fcc4889b8de79f3ccacbbf`: we:.github/workflows/soak-replay-gate.yml:39 (as of 0007875a; earlier checkout bd19057d: line 38) includes `edited`; its lines 80–82 (as of 0007875a) now fetch the live body and fail on retrieval error. Commit `ef4cb7125` delivered #4479's workflow change. The matching existing test is we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs, which reads the actual workflow and exercises its shell. These are evidence, not this story's write targets. No live Actions result is inferred from reading them.
- The resolved runtime fix does not deliver this separate documentation note. Narrow the write scope to the single documentation file; no runtime source entry remains, so no matching executable test file is required in scope. Adding a text-matching unit test would not prove an author verified a behavioural claim. The documentation review and observable proof below are the appropriate checks.

- Re-prepared 2026-10-09 at 0007875a: premise re-checked on main — the "Verify workflow claims before filing" bullet is still absent from we:docs/agent/backlog-workflow.md and the dedup bullet anchor remains at line 1215; plan unchanged, stamp refreshed.

## Design

Add one concise bullet labelled **Verify workflow claims before filing** immediately after the dedup bullet in we:docs/agent/backlog-workflow.md under Rules. Require authors to open the cited workflow at the checkout being used to file the card, verify each claimed trigger or behaviour against the relevant block, and follow a delegated script when the claim depends on it. Require current repo-qualified citations and correction of the premise and predicted scope when the source contradicts the report. Distinguish observed source behaviour from historical incident reports and untested runtime hypotheses.

Use #4479 as a short example: `edited` was already configured, whereas live PR-body retrieval was the actual missing behaviour at preparation time and has since landed. Do not describe either as a current missing feature. Keep the rule a manual author/reviewer check, consistent with the accepted prevention request; introduce no lint, workflow change, API, or new policy fork.

## MVP

1. **Must 1:** Add the filing-time verification bullet in we:docs/agent/backlog-workflow.md with the concrete read, trace, cite, and correct steps above.
2. **Must 2:** Include the historically qualified #4479 example and explicitly distinguish source inspection from proof of a live Actions run.

Deliver as one documentation change. Preserve size 3 and all unrelated metadata. Preparation review, checks, stamping, and delivery are runner-owned in this worker task.

## Edge cases this change must handle

1. Untrusted text: n/a: documentation-only bullet, no text reaches a shell, argv, path or regex.
2. Truncated reads: the bullet tells authors to read the whole cited workflow block, not a grep excerpt.
3. Shared state files: n/a: single doc edit, no state file.
4. Fail closed: if the cited workflow cannot be opened or traced, the claim is not filed as fact; the bullet says so.
5. Identity scoping: citations are repo-qualified (we:path:line) at the checkout used; the note covers a claim that depends on a delegated script and a workflow with several triggers.
6. State over time: a historical report that is no longer true is labelled historical (the #4479 example); a source read is never claimed as proof of a live Actions run.
7. Who wrote it: n/a: the note grants no trust; it asks authors to verify rather than rely on the report.

## Test plan

This is documentation-only: no executable source is changed and no new test file is planned. Review the added bullet for all four required actions: inspect the workflow at filing time, trace delegated behaviour when relevant, cite current source, and correct an unsupported premise/scope.

For the example, read we:.github/workflows/soak-replay-gate.yml and compare its `edited` trigger and live body retrieval with the historical correction in we:backlog/4479-soak-replay-gate-re-reads-the-live-pr-body-on-rerun-so-an-ad.md under Progress. Confirm the note does not claim the old defect is still present or that a source read proves a live rerun. The existing we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs remains runtime coverage, not a test to change for this note. Run `npm run check:standards` and `git diff --check` during implementation verification; preparation checks remain with the runner.

## Proof plan

Before implementation, record that searching we:docs/agent/backlog-workflow.md for the exact label “Verify workflow claims before filing” finds no bullet. After implementation, repeat that search and retain the added Rules excerpt as the observable artifact. An independent reviewer checks its meaning against the Design requirements and verifies the example against the actual workflow and #4479's historical Progress entry. Record the inspected checkout SHA and standards result in the delivery evidence. Text presence proves that the note exists; it does not prove universal future compliance or live Actions behaviour.

## Done when

1. **Observable (Must 1):** we:docs/agent/backlog-workflow.md contains the named filing-time verification bullet beside the dedup rule, with inspect/trace/cite/correct instructions.
2. **Assertable (Must 2):** the #4479 example accurately separates the already-present trigger, the subsequently delivered live-body fix, and the limits of source inspection.
3. **Verification:** standards and whitespace checks pass. No tier-1 behavioural regression is claimed: this documentation-only prevention requires author/reviewer judgment and cannot deterministically validate arbitrary prose claims.

## Follow-ups

No additional guard or runtime work is required by this item. #4479 retains its own live Actions proof obligation; do not fold that delivery work into this documentation scope. If future reviews reveal another concrete failure class, capture its evidence separately rather than expanding this note into a speculative semantic lint.
