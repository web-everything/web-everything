---
bornAs: xjvv6za
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a test in we:drain-red-team-evidence.test.mjs that supplies list/read stubs with a run carryi… (from web-everything/web-everything#5551 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-red-team-evidence.mjs:51` — Add a test in `we:drain-red-team-evidence.test.mjs` that supplies `list`/`read` stubs with a run carrying `redTeam: { status: 'ran', comment: 'posted' }` and no status file, then asserts `recorded: true`. Longer term, a coverage gate on changed branches in `scripts/lib` would catch this class.
2. `we:scripts/lib/drain-red-team-evidence.mjs:44` — Require that any change to `evidence.recorded` semantics has an integration test through createDrainMergeStrategy that advances the clock past redTeamPendingMaxMin and asserts enqueue versus hold. A review lens on 'hold-weakening changes need an end-to-end outcome test' is the cheapest guard.
3. `we:docs/agent/testing.md:61` — Add the named integration test to the automated test gate, retaining incomplete saved evidence throughout posted-result recovery.
4. `we:docs/agent/testing.md:62` — Add 'trusted posted live-head result releases a persisted incomplete saved-result hold' in we:web-everything/web-everything/scripts/lib/__tests__/drain-merge-strategy.test.mjs, asserting enqueue succeeds and pending state clears while the saved row remains incomplete.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5551@6b4b3057ee20dc396123edb354ac8ada36fe49c6

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
