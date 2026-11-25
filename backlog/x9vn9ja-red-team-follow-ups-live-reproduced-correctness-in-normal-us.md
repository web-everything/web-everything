---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/open-pr-io.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7431 (head e9e4f9235)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7431 (reviewed head `e9e4f923569e3051b73943c510f1bae8f1c48403`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/open-pr-io.mjs:273` — (edge-case, degraded) A successful sibling recheck retains the earlier stale refusal
   - Scenario: Run --check with stale origin/main that lacks an already-landed sibling patch. The first sibling check records a blocker. canonicalAudit refreshes main and returns the resolved head SHA; the second sibling check returns an empty list, but the earlier blocker remains, so the command still refuses. The final decision should use the refreshed evidence and discard the superseded sibling blocker.
   - Class: live-reproduced (basis: Executed the unchanged runner and actual sibling checker in a read-only VM harness with injected Git and audit responses. The recorded checks returned one sibling before refresh and zero afterward, yet the final result was refused with sibling-base.)
   - Also class: correctness-in-normal-use
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
