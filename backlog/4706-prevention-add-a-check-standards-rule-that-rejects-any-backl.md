---
bornAs: x2g29ih
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4831-the-drain-restores-ready-to-merge-on-an-accepted-green-merge.md"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Add a check:standards rule that rejects any backlog card with status open or ready whose Done-when sect… (from chalbert/web-everything#3598 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4831-the-drain-restores-ready-to-merge-on-an-accepted-green-merge.md:16` — Add a check:standards rule that rejects any backlog card with status open or ready whose Done-when section still contains the literal 'TODO:' placeholder.
2. `we:backlog/4831-the-drain-restores-ready-to-merge-on-an-accepted-green-merge.md:14` — Add a review-lens checklist item for cards that add automatic label restoration: list every legitimate way the label is removed and say how each is distinguished. Back it with a test that a PR with an intentional removal is not restored.
3. `we:backlog/4831-the-drain-restores-ready-to-merge-on-an-accepted-green-merge.md:18` — A write-gate in check:standards that rejects a backlog card entering status open or ready while it still contains a 'TODO:' Done-when line, and requires two Must lines when the card text says it loosens or removes a refusal.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3598@8c2dbd3d6a2c77d6843ddce205bbdb4cd4a123c5

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Also raised by

- Also raised by web-everything/web-everything#5490 (finding 1: `we:backlog/6192-build-dispatch-expired-group-member-claim-aliases-must-not-m.md:15` — Have the prepare step, or a check:standards rule on new backlog cards, reject cards whose Acceptance or Non-goals still contain 'TODO:' placeholders. The card could also be prepared Acceptance filled in before it is dispatched.) · key `approval-prevention-key:web-everything/web-everything#5490@e1dbe4bb0d951c9437dca6d4b8696a946ce3ca88`
- Also raised by web-everything/web-everything#5518 (finding 2: `we:backlog/xrkgjr3-overlap-yield-held.md:14` — A write-gate or check:standards rule that rejects a card with status: active whose body still contains the 'TODO' placeholders.)
- Also raised by web-everything/web-everything#5547 (finding 1: `we:backlog/x6ix36v-approve-human-only-enqueues-from-chat-with-a-recorded-instru.md:14` — A write-gate in check:standards or card-lint that rejects a 'ready' or top-priority card whose Acceptance or Edge-case sections still contain TODO, and requires a refusal case when the card text mentions human-only, sandbox or gate loosening.)
