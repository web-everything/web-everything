---
kind: story
size: 2
status: open
scope: ["we:scripts/settings/build-priority.json"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5488 (head 486f2292d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5488 (reviewed head `486f2292d9deb1fe9e8d12d819b9fad0ac84215a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/settings/build-priority.json:21` — (failing-input, degraded) Five new priority IDs reference nonexistent backlog cards, silently omitting the claimed work.
   - Scenario: Use the committed settings and backlog at this head. The real settings reader accepts x334ind, xbrgqq5, x8a6951, xl3a0ik and xiacg5p, but scanning all 6,155 backlog files and probing buildPriorityPlacement finds zero matching cards or descendants for each. These entries therefore have no scheduling effect: the claimed incident-coroner S1–S4 and assistant-session registry cannot enter the ordered queue through these references. Commit the corresponding cards or use their actual existing IDs so the advertised work receives its intended priority.
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
