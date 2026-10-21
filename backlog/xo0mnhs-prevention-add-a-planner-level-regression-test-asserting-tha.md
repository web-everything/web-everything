---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a planner-level regression test asserting that a full pass with contextComplete:false and a n… (from web-everything/web-everything#5316 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:2487` — Add a planner-level regression test asserting that a full pass with contextComplete:false and a numeric landed blocker keeps the dependent ready (or documents the intended deferral). Longer term, pass a mode flag instead of reusing contextComplete.
2. `we:scripts/lib/enqueue-on-event.mjs:718` — Add a test in we:enqueue-on-event.test.mjs: an event for a PR whose event-driven child is running must still be retained and re-run after the child exits. Restrict the filter to PRs whose active drain is a catch-up one.
3. `we:scripts/lib/enqueue-on-event.mjs:693` — Test that a PR attempted this round with a non-enqueued skip outcome does not set busy. Alternatively, exclude attempted-and-not-enqueued PRs from the busy scan, or cap consecutive busy rounds per PR head.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5316@887a53158ce132af00476ce83fe75b6c8123874a

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
