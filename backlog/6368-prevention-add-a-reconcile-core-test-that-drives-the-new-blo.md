---
bornAs: x7795lf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/operator-send-backs.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a reconcile-core test that drives the new block to the cap and asserts the refusal. More gene… (from web-everything/web-everything#5356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2530` — Add a reconcile-core test that drives the new block to the cap and asserts the refusal. More generally, apply the card-6147 convention that every new fail-closed or cap branch needs a named test.
2. `we:scripts/lib/operator-send-backs.mjs:62` — Add a cutoff or migration rule, for example ignoring send-backs older than the first marker-bearing brief or giving the operator a documented release command. Also add a test that replays a legacy thread with no marker and asserts the documented release path. The backlog card 6147 rule would cover this.
3. `we:scripts/lib/operator-send-backs.mjs:78` — Record the PR head at the time the send-back is first read, or the head of the last comment preceding it. Then require evidence on a different head even for headless items. Alternatively, add a test convention that every hold-release path has a negative test (a release attempt that must NOT clear) built through the real producer render.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5356@5d1be85f51c906b2680d8fff5fa4cc69aea88907

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
