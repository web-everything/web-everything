---
bornAs: xxf0bg6
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5945-test-gaming-detector-ignore-skip-only-markers-inside-strings.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Require each fail-closed Must in a card to name a fixture that passes today only through that gua… (from web-everything/web-everything#5129 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5945-test-gaming-detector-ignore-skip-only-markers-inside-strings.md` — Require each fail-closed Must in a card to name a fixture that passes today only through that guard, with a stated mutation ('delete this guard → this named case goes red'). A card-lint rule would only enforce that the sentence is present, so this stays a review-lens check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5129@da57c8180cd7ec7e6df43055f46a53f84d64422c

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
