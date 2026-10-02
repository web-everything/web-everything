---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xwmzclt-a-review-finding-is-identified-by-file-line-and-lens-not-by.md"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — A check:standards rule could refuse a status:open card whose Done-when still contains the 'TODO: a comm… (from chalbert/web-everything#3564 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xwmzclt-a-review-finding-is-identified-by-file-line-and-lens-not-by.md:16` — A check:standards rule could refuse a status:open card whose Done-when still contains the 'TODO: a command' scaffold text, or whose body loosens a refusal without Must lines. The scaffold already emits GUARD_RELAXATION_HINT, but no gate enforces it.
2. `we:backlog/xwmzclt-a-review-finding-is-identified-by-file-line-and-lens-not-by.md:12` — Add a Must line to the card: a ruling carries only when the claim class or an evidence fingerprint also matches, otherwise the finding re-refers. Back it with a negative test in we:jury-core.test.mjs. A card-lint rule that requires a Must line whenever a card text 'loosens' or 'carries' a refusal would catch this class.
3. `we:backlog/xwmzclt-a-review-finding-is-identified-by-file-line-and-lens-not-by.md:16` — A write-gate or check:standards rule that rejects a card whose 'Done when' still contains 'TODO' before it is opened or dispatched. Each loosening card would also need the two Must lines.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3564@f341bb3d278b16d607962a97aeb55d4c7ca8657d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
