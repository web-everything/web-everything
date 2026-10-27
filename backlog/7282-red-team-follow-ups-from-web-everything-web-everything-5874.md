---
bornAs: xu02z27
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5874 (head 59dd2a7df)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5874 (reviewed head `59dd2a7df2c6f714b65fe1042b2c8f3759b32592`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-size-admission.mjs:102` — (edge-case, degraded) Qualified remote bases can be shadowed by another branch
   - Scenario: Run with remote=upstream and base=main while refs/remotes/origin/upstream/main also exists. The new caller supplies upstream/main, but the reader preferentially resolves origin/upstream/main. An injected-Git probe with upstream/main at the actual base and origin/upstream/main at the PR head selected the latter, returning status=ok, zero lines, and no split card or size escalation for an actual 301-line change. Already-qualified bases must retain the selected remote.
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
