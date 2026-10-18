---
kind: story
size: 2
status: open
dateOpened: "2026-10-18"
scope: ["we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md", "we:scripts/lib/operator-override-store.mjs"]
tags: []
---

# Operator-override: apply-time freshness cannot be bypassed by direct log insertion

Priority: expedite (before public-preview). A signed approval can be backdated by inserting a record directly into the override log, bypassing the apply-time 15-minute freshness check; close that path in the store.

## Acceptance

- [A1] **Executable** — the suite in we:scripts/lib/__tests__/operator-override-store.test.mjs includes a named test that a validly signed approval older than the 15-minute freshness window, inserted directly into the log, is never applied by `readOperatorOverrides()`; it fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the approval workflow, the allowlist or the signing key; only the store and its read-time freshness rule.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no free text is parsed beyond the slice-1 canonical request bytes.
2. **Truncated reads** — n/a: a truncated log already returns readable: false.
3. **Shared state files** — The log is the shared state; freshness is judged against a store-recorded append time, not the attested approvedAt alone.
4. **Fail closed** — Any record whose append time is missing or later than approvedAt plus 15 minutes is refused and the layer reads as unreadable.
5. **Identity scoping** — n/a: single host-wide store.
6. **State over time** — A backdated record is refused however long after approval it is read.
7. **Who wrote it** — Record append time comes from the store lock holder, never the attestation.
