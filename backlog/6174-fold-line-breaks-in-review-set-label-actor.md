---
bornAs: x9wyb24
kind: story
size: 2
status: active
scaffoldedBy: "fix-5169"
dateScaffolded: "2026-10-13"
scope: ["we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Fold line breaks in the review-set-label actor before rendering verdict comments

buildVerdictComment renders the actor raw in 'Cleared by <actor> via' and 'Recorded by <actor> via'. The direct review-set-label CLI only checks that --actor is non-empty, so an actor carrying U+2028 (or CR) starts a new line that plain-prose readers such as parseAdvisories match with ^ under /m: a forged '**Verdict:** / Net basis: / **Advisory outcome:** accept' note under a trusted author. Found by the PR #5169 fix self-review; operator-controls callers are safe (actor is a validated login). Fix: fold every line break (CR, LF, U+2028, U+2029) in actor inside buildVerdictComment, as round-extension-mark's oneLine does, or validate the actor in the CLI; add a parseAdvisories forgery test. Also check the restamp reason paragraph, rendered unquoted.

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
