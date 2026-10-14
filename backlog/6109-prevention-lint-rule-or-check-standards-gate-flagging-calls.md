---
bornAs: x4iwf06
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Lint rule or check:standards gate flagging calls to the sync exec readers (execRead / execFileSyn… (from web-everything/web-everything#5241 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:317` — Lint rule or check:standards gate flagging calls to the sync exec readers (execRead / execFileSyncThrottled) from daemon-resident async modules. Alternatively, bound the per-interval comment-read count and test the bound.
2. `we:scripts/lib/enqueue-on-event.mjs:177` — Default the field (`json.reason ?? 'unknown'`) and add a test for a refusal with no reason.
3. `we:scripts/lib/enqueue-on-event.mjs` — Filter acceptance comments to the known verdict-bot author inside readCatchUpCandidates and add a forged-comment test. A lint rule for 'parseVerdictComment used without an author check' is the deterministic gate.
4. `we:scripts/lib/enqueue-on-event.mjs:437` — Add a deterministic unit regression combining an older event-pending PR, a catch-up candidate, and one available slot; require shared capacity accounting or a refreshed snapshot before the catch-up enqueue.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5241@70e7ae2aa16eb498994e4fd5828d8f5bdb95b7aa

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
