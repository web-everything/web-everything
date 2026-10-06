---
bornAs: xmch78o
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Extract the live-body read and reconcile step into a pure, injectable helper such as reconcileLiv… (from web-everything/web-everything#4126 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5130` — Extract the live-body read and reconcile step into a pure, injectable helper such as `reconcileLiveEscalationBody({readBody, reasons})`. Pin it with a test that a read failure returns `{changed:false}`. A lens or lint cannot decide this class automatically, so a review-lens note is the cheapest guard.
2. `we:scripts/merge-ai-prs.mjs:5134` — Add a deterministic caller-path test that makes the initial body read fail and asserts that no gh pr edit occurs; include a successful-read control that requires an edit.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4126@5bf29f8fd012b76bba25df3b04757799c346dfd9

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
