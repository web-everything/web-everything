---
bornAs: xcgj6a1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/conflict-watch-same-line.mjs", "we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs", "we:scripts/conveyor/__tests__/conflict-watch-same-line.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a test that pins the gh-call budget for an already-labelled conflicting PR under the default… (from web-everything/web-everything#5148 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/parked-pr-conflict-watch.mjs:1580` — Add a test that pins the gh-call budget for an already-labelled conflicting PR under the default setting, and fix the sweep so already-recovered PRs short-circuit.
2. `we:scripts/conveyor/parked-pr-conflict-watch.mjs:1587` — Add a retry-bound test (finding count after N failed supersedes) and dedup the finding against the recent-finding marker before re-posting.
3. `we:scripts/conveyor/conflict-watch-same-line.mjs:46` — Filter `declared.errors` by `source === 'we:settings/conflict-watch.json'` and add a test with an error from a different source file.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5148@112868fed139ee6d08de7ce9ea49063c5611dd30

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
