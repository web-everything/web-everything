---
kind: story
size: 3
parent: "xf7ax93"
status: open
blockedBy: ["xu8wvf7"]
scope: ["we:scripts/conveyor/decider-daemon.mjs", "we:scripts/conveyor/decide.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Decision-rule changes run in shadow: new rules beside old, diffs journaled, flip per role

Ruling E2: an edge change to the decide rules never goes live blind. The decider runs the new rules next to the live ones on the same PR states, journals every difference in requested actions, and the operator flips the new rules on one role at a time.

## Acceptance

- [A1] **Executable** — a test loads a candidate rule set that differs from the live one on one PR state and asserts the decider appends only the live set's actions and journals one diff naming the PR, role and both outcomes.
- [A2] A candidate rule set is loaded per role from a setting; the live set keeps acting.
- [A3] Flipping one role to the candidate rules leaves the other roles on their live rules.
- [A4] The diff journal is readable as a report (count of diffs per role and reason over a window).

## Non-goals

- [N1] No automatic flip; the operator flips a role.
- [N2] Not for executor code changes; each executor already carries its own edge version on its own clone.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: rule sets are repo code, not external input.
2. **Truncated reads** — a candidate set that fails to load is reported and ignored; the live set keeps acting.
3. **Shared state files** — the diff journal has one writer, the decider.
4. **Fail closed** — a candidate rule set never acts while in shadow, even if the live set errors.
5. **Identity scoping** — diffs are keyed to repo, PR, head commit and role.
6. **State over time** — the journal records the rule-set versions it compared.
7. **Who wrote it** — each diff names both rule-set versions.
