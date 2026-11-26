---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs", "we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/daemon-rebuild/__tests__/orchestrator-ask.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/state.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic oversized-journal regression and retain deduplication keys independently of t… (from web-everything/web-everything#7487 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:20` — Add a deterministic oversized-journal regression and retain deduplication keys independently of the bounded journal tail; the disclosed ORCH-ASK-DEDUPE-HARDEN follow-up can carry this guard.
2. `we:scripts/lib/daemon-rebuild/state.mjs:273` — Gate the change with separate fixtures for each ancestry predicate and parameterized nonzero-status and thrown-error cases.
3. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:32` — Add a deterministic test with no path override and filesystem spies asserting zero reads, directory creations, and appends.
4. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:36` — Add a deterministic injected EACCES read test asserting ok:false and no append, alongside an ENOENT case that permits creation.
5. `we:scripts/lib/daemon-rebuild/state.mjs:270` — Add a pin-provenance test with a tip that descends from `pinnedFrom` but not `pin.sha`, which must stay stale. Add a graft-file case. A mutation-testing gate on guard conditions would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7487@0cfb51f34a1c14ab4a33cc8d9e3f9abf7ad2a17c

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
