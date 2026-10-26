---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5960 (head 6b855389f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5960 (reviewed head `6b855389f3a61d57fe92840ad6b2682c6c9fcd79`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-live-smoke.mjs:272` — (failing-input, degraded) Normal Node stack traces push the actual error out of the six-line tail
   - Scenario: Probed reconcile-dry-run with a real runBounded child executing: console.error("pr-snapshot: smoke sample 3"); function fail() { throw new Error("state schema mismatch: missing revision"); } fail();. The returned detail contains only the informational preamble, while stderrTail contains five trailing stack frames and the Node version. Neither field retains the error message, even before alert truncation. Preserve the error headline alongside the bounded tail.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-live-smoke.mjs:485` — (edge-case, degraded) Reconcile's timeout aggregation discards captured stderr diagnostics
   - Scenario: Probed a real runBounded child that prints 'Error: waiting on state lock held by pid 12345' and remains alive beyond its 200ms timeout. When every failed reconcile child times out, the special timeout return omits stderrTail despite collecting it. The resulting row and downstream alerts lose the captured diagnostic entirely. Include the collected tails while preserving the existing timeout detail and classification.
   - Claude's re-check: demonstrated break

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
