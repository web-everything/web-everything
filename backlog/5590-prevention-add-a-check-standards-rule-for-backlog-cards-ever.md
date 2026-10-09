---
bornAs: x0y2dzv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md", "we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md", "we:backlog/5596-supersede-rule-rewrite-marker-line-re-without-super-linear-b.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule for backlog cards. Every edge-case line that is not 'n/a:' must cite a… (from web-everything/web-everything#4616 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md:35` — Add a check:standards rule for backlog cards. Every edge-case line that is not 'n/a:' must cite an acceptance id (e.g. '[A4]').
2. `we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md:28` — Use the same card-lint rule: a non-n/a untrusted-text edge case must reference an acceptance id.
3. `we:backlog/5596-supersede-rule-rewrite-marker-line-re-without-super-linear-b.md:34` — Use the same card-lint rule: each non-n/a edge-case line must reference an acceptance id.
4. `we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md:34` — Require each behavioral edge-case constraint to reference a planned test case and observable assertion through a backlog validation gate.
5. `we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md:34` — Require separately stated behavioral constraints to map to planned named cases and assertions in backlog validation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4616@209864d02eaf9b3c99bee68e5410adb68de23433

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
