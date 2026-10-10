---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-stack-base.mjs", "we:scripts/conveyor/__tests__/review-stack-base.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — File a backlog item for a signed or ledger-backed marker. For example, the STACK_HOLD sink could… (from web-everything/web-everything#4729 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4729's review (reviewed head `a110f2412a716e540f5dbe775bfcd3f115de7227`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/review-stack-base.mjs:118` — File a backlog item for a signed or ledger-backed marker. For example, the STACK_HOLD sink could also write a shadow-ledger row (the review-pr sinks already have a verdict ledger), and the carry would require that row to match the marker.
2. `we:scripts/conveyor/review-stack-base.mjs` — Add a deterministic real-git regression test with a conflict-resolving merge that alters the bottom, an unchanged top fingerprint, and assertions that bottom verification fails and carry is never invoked; require content-equivalence evidence for the merge result.

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
