---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/test-gaming-route.mjs", "we:scripts/conveyor/__tests__/test-gaming-route.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add one test that calls routeTestGaming/sweepTestGamingRoutes with no enabled and the setting fal… (from web-everything/web-everything#5537 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/test-gaming-route.mjs:94` — Add one test that calls routeTestGaming/sweepTestGamingRoutes with no `enabled` and the setting false (via env), asserting no writes.
2. `we:scripts/conveyor/test-gaming-route.mjs:21` — Reject any reason whose `;`-separated findings are not all `tests-removed`, plus a mixed-kind test.
3. `we:scripts/conveyor/test-gaming-route.mjs:62` — Add a shared helper that bounds and neutralizes any agent-authored string before it is re-posted to a PR comment or the feed. Back it with a lint or check:standards rule that flags raw interpolation of marker-extracted text into postComment.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5537@010df4874ac89d8fa83c8c72cab05d7533286273

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
