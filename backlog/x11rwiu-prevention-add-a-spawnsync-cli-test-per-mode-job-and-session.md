---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/land-advance-io.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/__tests__/land-advance-io.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a spawnSync CLI test per mode (job and session) covering: missing pin gives exit 75, and a va… (from web-everything/web-everything#7430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-dispatch.mjs:756` — Add a spawnSync CLI test per mode (job and session) covering: missing pin gives exit 75, and a valid pin reaches the dispatcher's `expectedHead`. Alternatively, a lint rule that every `flag('x')` read in an operation CLI is exercised by a test.
2. `we:scripts/operations/land-advance-io.mjs:245` — Add a gate or test that lists every production caller of `dispatchReview`, `dispatchReviewJob` and `dispatchReviewByMode` and asserts each supplies `expectedHead`. File a follow-up card to carry the planned head in land-advance's proposed rows.
3. `we:scripts/operations/review-dispatch.mjs:772` — Add an end-to-end spawnSync test of the we:scripts/operations/review-dispatch.mjs job-mode CLI (missing pin → exit 75). More generally, a rule that any new CLI flag consumed by a spawned script needs at least one test that runs that script's real argv parser.
4. `we:skills-src/conveyor/review-daemon.mjs:864` — When a comment lists 'no X, no Y, no Z', require one assertion per listed item. A review lens, or a lint that cross-references 'no ...' comment lists in new branches, is the cheapest option.
5. `we:scripts/operations/land-advance-io.mjs:251` — Before making an argument mandatory at a shared dispatcher, run a deterministic caller audit (a gate listing every dispatchReview and dispatchReviewJob call site that lacks expectedHead). File a follow-up for any caller that is deferred instead of wired.
6. `(no file cited)` — Add a named controlled live smoke test asserting a real pinned launch and a refused head-stripped replay with no launch; require each Acceptance item to reference a concrete test identifier.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7430@d6f2d3bd6a96fd8b749fe23250c741ea856069b3

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
