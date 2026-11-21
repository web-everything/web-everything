---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/lane-pool-repair.test.mjs", "we:scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs", "we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test for a single-lane pool with a corrupt index. It should expect either a heal or an expl… (from web-everything/web-everything#7220 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/lane-pool-repair.test.mjs:97` — Add a test for a single-lane pool with a corrupt index. It should expect either a heal or an explicit operator-actionable error that names `refresh`/repair. Also add a rule that any fail-closed conversion lists the paths that used to rely on fail-open.
2. `we:scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs:228` — Assert on the git-call trace or on the absence of the 'claimed but failed to provision' log line. Better, share the trace-based skip helper.
3. `we:scripts/lane-pool.mjs:2874` — Add a `--force` variant to the free-list unpushed test, then add a lint or standards rule that any prose in `we:scripts/lane-pool.mjs` saying `--force never widens …` must name a test via a `// guarded-by:` tag. File as a backlog card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7220@c8a84403fe74d2e7f7f3eaf4cbcb971f6231b351

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
