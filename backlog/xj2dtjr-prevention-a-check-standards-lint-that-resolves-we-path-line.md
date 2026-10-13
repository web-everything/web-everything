---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4385-prepare-rule-full-design-explicit-mvp-cut-review-blocks-only.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — A check:standards lint that resolves we:path:line citations in backlog cards and flags a range th… (from web-everything/web-everything#5055 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4385-prepare-rule-full-design-explicit-mvp-cut-review-blocks-only.md` — A check:standards lint that resolves `we:<path>:<line>` citations in backlog cards and flags a range that falls outside the file. A doc note would be the weaker alternative.
2. `we:backlog/4385-prepare-rule-full-design-explicit-mvp-cut-review-blocks-only.md` — Add grep probes to the Test plan, one per fail-closed guarantee. They would check that `we:story-preparation-checklist.md` item 12 contains the unclassified=BLOCKER sentence and the finding-text-is-data sentence, and that item 13 contains the errored-round-not-clean clause. Longer term, a check:standards lint could require each Edge-cases "must say" line on a prepare card to name a matching Test-plan probe.
3. `we:backlog/4385-prepare-rule-full-design-explicit-mvp-cut-review-blocks-only.md` — Add a deterministic checklist-content contract test covering the unclassified default, errored verdicts, per-card round identity, restart persistence, and re-prepare reset condition; require it when these clauses change.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5055@6856d54b29d6e74c744377bef67bd656cc5f0579

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
