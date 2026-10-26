---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/card-number-allocator.mjs", "we:scripts/backlog.mjs", "we:docs/agent/testing.md", "we:scripts/settings/number-at-birth.json", "we:scripts/operations/__tests__/scaffold.test.mjs", "we:scripts/lib/__tests__/card-number-allocator.test.mjs", "we:scripts/__tests__/backlog.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — File a card to prune or shard reservation refs once landed, or to list only refs above the high-w… (from web-everything/web-everything#5958 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/card-number-allocator.mjs:28` — File a card to prune or shard reservation refs once landed, or to list only refs above the high-water mark. Add a size-budget test that fails when the ref count projected over the next N cards exceeds the listing cap.
2. `we:scripts/backlog.mjs:738` — Add a CLI test that stubs the transport to return a number equal to an existing zero-padded file and asserts exit non-zero with no file written. Longer term, make the CLI scaffold call the shared planScaffold so there is one collision implementation.
3. `we:docs/agent/testing.md:1601` — Add an allocator test that captures `log` and asserts one line containing `backlog.cardNumbering` with a per-leaf source for both enabled and remote.
4. `we:scripts/settings/number-at-birth.json:5` — Gate changes with a CLI regression test that uses shipped settings and removes the enablement environment override.
5. `we:scripts/operations/__tests__/scaffold.test.mjs:274` — Parameterize the collision test with differently padded representations and require each to produce id-exhausted.
6. `we:scripts/settings/number-at-birth.json:5` — Add a deterministic integration test loading shipped settings with no numbering environment overrides and asserting a numeric filename and bornAs.
7. `we:scripts/operations/__tests__/scaffold.test.mjs:274` — Parameterize the named test with distinct numeric spellings, including existing '001' versus allocated '1' and the reverse, asserting id-exhausted.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5958@547ee72f3c9201a22b5c57af10dc3048cf8a6562

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
