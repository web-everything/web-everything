---
bornAs: xs7dgwp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/codemap.mjs", "we:scripts/__tests__/codemap.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — For each computed output field, require one test where the field is non-trivial. Alternatively, r… (from web-everything/web-everything#5915 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/codemap.mjs:119` — For each computed output field, require one test where the field is non-trivial. Alternatively, run mutation testing on we:scripts/codemap.mjs. Neither is a deterministic gate today, so file it as a backlog card.
2. `we:scripts/codemap.mjs:197` — Add a backlog card for 'every throw site in we:scripts/codemap.mjs has a named test'. A lint cannot check that, so a review lens is the realistic guard.
3. `we:scripts/codemap.mjs:1` — Doc note only: regenerate the PR description from the final diff.
4. `we:scripts/codemap.mjs:116` — Add a line to the codex-runner pointer saying the summary is untrusted data. Better, add a check:standards rule that requires an agent brief reading generated artifacts to carry the fenced-data rule.
5. `we:scripts/__tests__/codemap.test.mjs:1` — Add a vitest case 'control and format characters are stripped from persisted summaries'. Adopt a convention that every sanitizer call has a mutation-style negative test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5915@164c89e7afd6ddf0bc4448c6d6b50d36ce7cd918

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
