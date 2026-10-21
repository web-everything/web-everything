---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add expect(calls).toHaveLength(4) after kill() and the flush. More generally, review lens: every… (from web-everything/web-everything#5277 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:1275` — Add `expect(calls).toHaveLength(4)` after kill() and the flush. More generally, review lens: every 'cannot / must not' guarantee in doc or comment prose needs an assertion on the negative observable.
2. `we:scripts/lib/enqueue-on-event.mjs:379` — Add tests for (a) `readQueueDepth` resolving `{ok:false}` and for it rejecting, each asserting zero spawns and the PR retained in pending, and (b) `readCatchUpQueueDepth` with a stubbed `execFileImpl` for ok, error, and malformed totalCount. Also check that the per-start gate still reads depth once per start.
3. `we:scripts/lib/enqueue-on-event.mjs:706` — Keep a 'dirty' mark for an active PR and re-queue it when the drain finishes, or accept the drop explicitly. Add an assertion on `handle.pending()` (empty, or holding the deferred PR) in the suppression test.
4. `we:scripts/lib/enqueue-on-event.mjs:681` — Apply the blocked-backoff, or a general per-head attempted-and-failed signature, to the busy decision. Add a test where a failing PR yields the full interval when its head is unchanged.
5. `we:scripts/lib/enqueue-on-event.mjs:685` — Add a test that a PR with N consecutive failed or missed drains falls back to the full interval, with a code gate on busy rescheduling that consults the misses map. As a lint-level backstop, require any retry-cadence shortening to cite its brake.
6. `we:scripts/lib/enqueue-on-event.mjs:82` — Give the validator a documented max (for example 1–8) and add a boundary test for it next to the existing invalid-value test.
7. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:1219` — Add a deterministic parameterized test for unsuccessful and throwing live-depth reads, asserting no child starts; verify that removing the fail-closed guard makes that test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5277@6bc79e895a775220b0eb2eaa61cef883b8e7e1eb

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
