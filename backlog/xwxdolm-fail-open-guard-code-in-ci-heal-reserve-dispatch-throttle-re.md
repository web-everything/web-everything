---
kind: task
status: active
scaffoldedBy: "fix-cap-raise"
dateScaffolded: "2026-11-20"
scope: ["we:scripts/lib/ci-heal-reserve.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Fail-open guard code in ci-heal reserve, dispatch throttle, resource gate and claim readers

Seven pre-existing fail-open items found by the R1103 audits: we:scripts/lib/ci-heal-reserve.mjs:45 claim-read errors count as zero holders; we:scripts/conveyor/fix-claim-store.mjs:92 returns empty on directory errors; we:scripts/lib/ci-heal-reserve.mjs:53 and we:scripts/lib/dispatch-throttle.mjs:197 gate exceptions admit; we:scripts/lib/dispatch-throttle.mjs:113 and we:scripts/lib/resource-policy.mjs:89 unavailable host or CPU readings admit; we:scripts/lib/dispatch-throttle.mjs:192 and we:scripts/lib/resource-gate.mjs:400 claim-read failure means zero live sessions; we:scripts/conveyor/tick-core.mjs:2241 load gate defaults to open after probe failure; we:scripts/lib/ci-heal-reserve.mjs:40 dedup ignores repo and we:scripts/lib/ci-heal-reserve.mjs:30 occupancy cache is not atomic; also we:scripts/lib/policy-cascade.mjs:83 swallows platform-preference read and parse errors (a restrictive platform limit can be silently lost) and we:scripts/lib/policy-cascade.mjs:71 reads platform preferences with an unbounded readFileSync (a FIFO or oversized file can block or exhaust). Each should refuse or hold when evidence is unavailable.

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
