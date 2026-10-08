---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/engine.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Review: a ruling on an unchanged head resumes the paused review; no fresh panel, no new referrals

After an operator ruling on an unchanged head the review daemon (we:scripts/conveyor/review-referral-hold.mjs release then we:scripts/operations/review-loop-cli.mjs fresh start) ran a full new panel that raised NEW mandatory referrals, so the PR flipped back to advisory:ruling-needed and never reached the operator (live 2026-10-08: #4361 ruling 12:09Z then fresh review 12:15Z with 2 new referrals; #4388 round 2 at 12:20Z re-raised a finding the fixer had already fixed). Fix: resume the parked run (rewind to the mandatoryReferrals step) and reuse its verdict and findings; advisory-lens findings first raised in a later round on the same head become card suggestions (rule of #3999; gate lenses are never set aside), and a re-raised finding matched by finding identity (#4233) is not re-referred. New referrals come only from a new push. Gate change: needs human review.

## Done when

1. **Executable** — `npx vitest run` on we:scripts/operations/__tests__/review-ruling-resume.test.mjs and we:scripts/conveyor/__tests__/review-referral-hold.test.mjs fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — juror finding text only feeds finding-identity matching (path plus normalized claim); it never builds a command or path.
2. **Truncated reads** — the resume reads the complete paginated PR thread; an unreadable PR or run store answers null and a fresh review starts.
3. **Shared state files** — the run record is rewritten in place through the run store; the resume only proceeds for a run parked on a confirm step.
4. **Fail closed** — any doubt (head moved, re-arm, send-back, operator reply, persistence failure, `WE_REVIEW_RESUME_PARKED=0`) starts a fresh review; the referral step still reads the thread, so a block ruling still gates.
5. **Identity scoping** — a finding is matched by finding identity (#4233), never by wording or line; covered means already referred on this head.
6. **State over time** — a push moves the head, so the parked run no longer resumes and new referrals come only from the new review.
7. **Who wrote it** — only trusted-marker authors and the operator count as ruling events.
8. **Evidence a fix was made** — a block-ruled re-raise is set aside only when the fixer's push changed a source file within the #3999 line window of the cited line (`fixerChangeNearFinding`, shared with the later-round advisory rule). Touching the file is not enough: an unknown line set, a non-source file (a backlog card, docs, config), a distant edit or a re-raise citing no line all stay mandatory, so the ignored-ruling path still sees them.
9. **Gate lenses** — correctness and security findings are never set aside by the round rule, in any round; only an advisory seat's later-round finding becomes a card suggestion.
10. **Partial persistence** — a head with a referral record nobody has attempted (a run died between chunks) is not a finished round; the retry keeps referring on it (`openReferralHeads`).
