---
bornAs: xmzgy3d
kind: task
parent: "3929"
status: resolved
scope: ["we:scripts/pr-land.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-09"
graduatedTo: f330efefa60cfd4e7280c21e3955432b1190ccec
tags: []
---

# Ledger slice E3: write ledger rows alongside pr-land parks, drain re-parks and drain-hold reason changes

Slice E3 of the verdict-ledger plan (#3007), the event-writing half of #3929. Strictly additive: record a verdict row beside each pr-land park (scored escalation and explicit --park) and each drain manifest-tamper and test-gaming re-park, and append one drain-hold event when a held PR's drain reason changes. Never changes a hold, label or land decision; a ledger miss follows the write-miss posture and is non-fatal. Backfill and checker guidance stay with #3929.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
