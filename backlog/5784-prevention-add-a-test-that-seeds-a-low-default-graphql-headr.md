---
bornAs: xoikfmi
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle.shim-routed.test.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a test that seeds a low default graphql headroom file and asserts a shim-routed deferrable pr… (from web-everything/web-everything#4833 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:1585` — Add a test that seeds a low `default` graphql headroom file and asserts a shim-routed deferrable `pr list` still runs. Better, route every `identity`-keyed read in `runGhSync` through one `shimRouted`-aware helper.
2. `we:scripts/lib/gh-throttle.mjs:1513` — Re-`statSync` immediately before the rename and skip if the size is now under `maxBytes`, or rotate under the existing `.admission` lock helper. A two-process rotation test would pin it.
3. `we:scripts/lib/__tests__/gh-throttle.shim-routed.test.mjs:41` — Add a deterministic test that observes filesystem calls, asserts a maximum 512-byte read, and verifies repeated probes of the same file perform no additional reads.
4. `we:scripts/lib/gh-throttle.mjs:1507` — Serialize rotation across processes and add a deterministic concurrency test that forces both callers to observe the old size and asserts the original generation remains intact.
5. `we:scripts/lib/__tests__/gh-throttle.shim-routed.test.mjs:40` — Add a deterministic filesystem-spy test asserting a maximum 512-byte read and no second read for repeated probes of the same resolved file.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4833@3b56eeaf0fb98e1dd26edb88f0341cf30d64369e

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
