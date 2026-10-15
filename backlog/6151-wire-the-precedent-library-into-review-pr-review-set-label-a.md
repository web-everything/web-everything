---
bornAs: xnphk85
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/review-set-label.mjs", "we:scripts/operations/record-referral-ruling-io.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Wire the precedent library into review-pr, review-set-label and record-referral-ruling (one-line hooks)

The operator precedent library (we:scripts/lib/review-precedents.mjs, we:scripts/lib/review-precedents-io.mjs, CLI we:scripts/review-precedents.mjs) shipped with its logic in new modules because the hook files were held by open PRs (we:scripts/operations/review-pr.mjs and we:scripts/operations/review-pr-io.mjs by #5025, we:scripts/review-set-label.mjs by #5223, we:scripts/operations/record-referral-ruling-io.mjs by #5216). Once those land, add three thin hooks. (1) INJECT: in the review-pr read step load active precedents once (readPrecedents + loadPrecedentSettings) and wrap every juror request built from renderJudgeInput with withPrecedents(request, {precedents, files: read.netChangedFiles, text: title+body+diff, settings}); an unreadable transport injects nothing and logs it, never blocks a review. (2) CITE: in the review-pr record step, extractCitations over the verdict findings and append a citationEvent (repo, pr, head, ids, seat, verdict) so precedentAgreement has data without the comment backfill. (3) CAPTURE: after the label tool posts a --to=changes send-back or a --to=clear-human with notes, and after the referral-ruling sink posts an operator block/card/not-real ruling, run capturePrecedents for that PR and append the drafts (status draft; best effort, never fails the label write). Until then capture runs via node we:scripts/review-precedents.mjs capture --pr=N --apply. Done when: each hook has a red-green test and a live run shows a draft captured, a juror request carrying the precedents block, and a citation row recorded.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Review prevention follow-up (PR #5243)

Add a check:standards rule requiring each `claude -p` spawn under scripts to supply an explicit `--tools` restriction or a documented exemption. The precedent drafting spawn now disables tools; the broader scanner lies outside this repair's allowed file scope. Cover literal argument arrays and wrapped spawn helpers, including dynamically assembled arguments that need an explicit exemption.

The precedent hooks must pass operator logins into status validation and preserve comment/review source identity on citation events. Active transport first writes are trusted only when they exactly match repository-reviewed seeds; other records require a validated operator status event. Actor login remains a transport-writer attestation, not proof of the invoking user's identity; stronger authentication requires a separate operator-only write boundary.

The complete comment reader currently projects creation time and node identity but omits edit time. Project `updated_at` as `updatedAt` there so a same-comment edit returning to earlier content has a distinct citation revision; without that upstream field, backfill can distinguish new comments and changed evidence but cannot reconstruct repeated edits of one comment. That reader is outside this repair's scope. Direct citation writers must retain a stable occurrence time or a source identity unique to the review revision.
