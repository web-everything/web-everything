---
bornAs: xs9gv5e
kind: task
status: open
scope: ["we:scripts/hooks/guard-bash.mjs", "we:scripts/hooks/guard-bash.test.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6744"]
---

# guard-bash: expand shell braces and globs before matching gated scripts

we:guard-bash.mjs:4487 brace expansion hides the script/op/flag, and :4431 globs in longer script paths evade detection of denied --skipPrePrReview. Main denies none of it, so card-class (R907/R903). Red-first test: brace-expanded and glob-path forms of the gated invocation are denied.

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

## Duplicate admission

red-team breaks carded under R903/R907

new evasion shapes found in #6744 red-team
