---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/class-sweep-check.mjs", "we:scripts/conveyor/__tests__/class-sweep-check.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Before enforce is enabled, make the enforcing consumer the review or harness side, reading class-… (from web-everything/web-everything#4536 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/class-sweep-check.mjs:38` — Before `enforce` is enabled, make the enforcing consumer the review or harness side, reading `class-sweep/<session>.json` from the coordination root. Alternatively, ignore the env override and `--kind` once the mode is `enforce`. Add a test asserting `since` is stamped regardless of mode source.
2. `we:scripts/conveyor/class-sweep-check.mjs:36` — Before enforce is switched on, make the consumer side (daemon or review pass) recompute the verdict from the posted evidence and the host's file-only mode. A script-decidable guard would be a standards rule that policy-settings resolvers used by a checked party must not accept an env downgrade of a file-declared stricter mode (env may only tighten).
3. `we:scripts/conveyor/class-sweep-check.mjs:78` — When the record becomes an input to a decision (enforce, completion record v2), derive session/pr/repo from the harness-provided environment (e.g. a harness-set session variable) and ignore or cross-check the flags. Until then, add a doc note on the record that it is self-reported.
4. `we:scripts/conveyor/class-sweep-check.mjs:61` — Use a bounded file reader and add a deterministic CLI test asserting the maximum requested bytes, including multibyte input.
5. `we:scripts/conveyor/class-sweep-check.mjs:99` — Add deterministic fault-injection tests requiring the default CLI output to distinguish successful validation from failed persistence while preserving warn-mode exit zero.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4536@40d3fddec8aaea2c8a26b3c636d77fb0b8a4cfb0

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
