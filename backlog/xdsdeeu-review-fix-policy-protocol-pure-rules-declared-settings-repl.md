---
kind: story
size: 5
parent: "5407"
status: open
relatedTo: ["5461", "x8mmzuz"]
scope: ["we:scripts/lib/review-fix-policy.mjs", "we:scripts/lib/review-fix-policy-settings.json", "we:scripts/lib/__tests__/review-fix-policy.replay.test.mjs"]
dateOpened: "2026-10-08"
tags: [delivery-standard, review, fixer]
---

# Review & fix policy protocol: pure rules, declared settings, replay fixtures

Fixer/review proposal, operator 2026-10-08, CROSS-CUTTING ruling (covers P1-P6 and lane protection). Every fixer and review policy becomes a standard rule: a pure decision function over plain facts plus declared settings. Today's behaviour is each setting's off value. Each rule has replay-fixture tests and standard-shaped names (no forge or label strings). The core implements behind the rules. This card defines the rule shape, the settings declaration and the fixture format, and collects the rules into the delivery standard (#5407).

It relates to the Decision API slice xzlrqss (#5461): those fixtures are "events in, actions out" for decide and admission; these are "facts in, verdict out" for the review/fix policies, in the same fixture style.

The rules (each slice of epic x8mmzuz adds its own rule and fixtures through this shape):

| Rule | Ruling | Off value (today) | Slice |
|---|---|---|---|
| fix slot = active sessions only; a parked resume goes first | P1 | parked session holds its slot | push-on-green lane (A2) |
| push on green | P2 | push waits for the next tick | push-on-green lane (A1) |
| lane protection: verified unpushed work is not reapable or acquirable | (A3) | reap/reset with a loud warning | lane-protect-unpushed lane |
| binding prior round | P3 | every round re-judges everything | xtzqoyq |
| heal delta review | P4 | full re-review after a heal | xu7kxtt |
| round budget K | P5 | none (cap 5 escalates) | xlsepow |
| revert-red check | P6 | off | x5d9nso |

## Acceptance

- [A1] **Executable** — a replay runner loads each fixture (facts plus settings in, exact verdict out) against the reference rules, passes, and fails on a deliberately broken rule.
- [A2] Each rule above is a named pure function with no IO, clock or network inside it; `now` and every threshold arrive as inputs.
- [A3] Every threshold and mode (fix cap, parked cap, round budget K, shadow window, revert-red mode warn/enforce, await TTL) is a declared setting with a schema and a default; no rule hardcodes one.
- [A4] Every setting's off value reproduces today's behaviour, proven by one fixture per rule run with the off value.
- [A5] Rule and fact names are standard-shaped: they name states, findings and rounds, never GitHub, label strings or our file paths.
- [A6] The card's rule table is linked from #5407 and from #5461 so the Decision API and these policies share one fixture format.

## Non-goals

- [N1] No rule implementation logic beyond the reference functions; the core wiring lives in each slice.
- [N2] Where the protocol finally lives (protocol home repo) is #5407's call; this card makes it movable, not moved.
- [N3] No new rules beyond the ruled set; A4 and B5 are unruled.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — fixtures include finding and PR text as data to prove it never changes a verdict.
2. **Truncated reads** — a fixture with a truncated fact set (missing round, missing ledger row) yields the safe verdict (block or hold), never accept.
3. **Shared state files** — n/a: rules are pure; fixtures are read-only test data.
4. **Fail closed** — an unknown or malformed setting value falls back to the off value (today's behaviour), never to a looser one.
5. **Identity scoping** — facts are keyed by repo, PR and head sha; a fixture with a stale head yields no verdict change.
6. **State over time** — time rules (shadow window, await TTL) take a fixed `now` in fixtures.
7. **Who wrote it** — facts keep their writer field; a rule reading a finding status trusts only ledger-written status.
