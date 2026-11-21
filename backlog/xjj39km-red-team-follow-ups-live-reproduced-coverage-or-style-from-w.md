---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7142 (head a4855e6c0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `a4855e6c0fd3228a3c1bd39868c1f62a0b4f61cc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:29` — (failing-input, degraded) Malformed policy containers bypass the claimed fail-closed validation.
   - Scenario: Set the tool policy to ciUnitRerun: false instead of the documented object. Object.entries(false) yields no entries, so validation detects nothing and resolvePolicy returns enabled: true. With a failed first report and a passing retry, rerunOnce returns 0. Invalid policy containers should disable retries under the stated fail-closed policy rather than silently enable failure recovery.
   - Class: live-reproduced (basis: A read-only probe called the actual resolvePolicy with tool: false, observed enabled: true, and passed that result to the actual rerunOnce with injected IO. It invoked one retry and returned shard exit 0. Null, string, and array containers also retained enabled defaults.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
