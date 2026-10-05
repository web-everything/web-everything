---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xca0u65-halt-merging-while-main-is-red-and-publish-a-main-red-signal.md", "we:backlog/xi8vgqq-re-check-a-green-pr-before-merge-when-main-moved-after-its-c.md", "we:backlog/x5qhw83-open-pr-overlap-gate-for-orchestrator-dispatched-jobs-with-a.md", "we:backlog/xcs4nce-delivery-flow-policy-keys-their-platform-defaults-and-one-lo.md"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a cross-card consistency lint for backlog stories under one epic. Any prose claim of the form… (from web-everything/web-everything#3794 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xca0u65-halt-merging-while-main-is-red-and-publish-a-main-red-signal.md:60` — Add a cross-card consistency lint for backlog stories under one epic. Any prose claim of the form "with <key> on, X" should cite the test that defends it. As a cheaper fix, narrow the claim to the cases it actually holds for, and have the exemption require evidence that the PR changed a cause of the red (for example, the red check is green on its run).
2. `we:backlog/xi8vgqq-re-check-a-green-pr-before-merge-when-main-moved-after-its-c.md:146` — Add a standing 'every input to a merge gate has a throw/empty fixture' line to the card template, then enforce it with a test that iterates each injected reader of the gate and asserts none yields 'land'.
3. `we:backlog/x5qhw83-open-pr-overlap-gate-for-orchestrator-dispatched-jobs-with-a.md:55` — Put the self-PR exemption under its own policy key (for example `dispatchGate.selfPrExempt`, default `require-reason`), or require a logged reason in `off` mode too. Add a card-lint rule that a policy key described as 'no override' lists every flag that suppresses its refusal.
4. `we:backlog/xcs4nce-delivery-flow-policy-keys-their-platform-defaults-and-one-lo.md` — Add a preparation-review check requiring a concrete MVP consumer for optional configuration machinery; otherwise specify a simple unsupported-form fallback and defer implementation with the first consumer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3794@79c60d359918422f131fc5556284ebe47095fcd0

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
