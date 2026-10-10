---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/accept-carry-sweep.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Accept carry-forward: recognise a formal GitHub CHANGES_REQUESTED review and an operator free-text hold after a clear-human

PR #4631 round-2 residuals: a native GitHub CHANGES_REQUESTED review (gh --json comments never returns it) and an operator free-text comment posted after a clear-human are not read by the accept carry-forward rule (we:scripts/lib/accept-carry-forward.mjs#isLaterVerdictBody). The drain runs under the operator's own login on this host, so authorship cannot classify a free-text comment; needs a positive marker or an explicit hold command. The label-only hold, the held-park laundering and the sweep cwd/memo findings were fixed in the PR itself.

Also owed here (round-2 self-review, same defect class, not fixed in the PR): (a) hold origin is proven by timing — the drain's ledger row paired with the latest `labeled review:human` event within [-5s, +120s] — so a person who removes and re-adds the label inside that window reads as the drain; a head-bound drain marker on the park would prove cause. (b) the sweep plan admits `held — a review hold` / escalation-policy / manifest-tamper drain parks but the restamp CLI can only prove a test-gaming park, so those get one settled refusal per head. (c) the ledger is read from the home file only; with `verdictLedger.store=git` the feature silently never fires. (d) no compare-and-swap between the proof reads and the label swap (two concurrent runs). (e) ledger `at` (local clock) vs GitHub event time: skew beyond the 5 s early tolerance refuses.

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
