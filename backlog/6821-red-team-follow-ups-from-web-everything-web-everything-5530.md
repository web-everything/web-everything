---
bornAs: xe25tkd
kind: story
size: 2
status: open
scope: ["we:backlog/x44bz7l-we-stacked-pr-policy-slice-4-closed-or-rejected-base-handlin.md"]
dateOpened: "2026-10-21"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5530 (head d3bee7370)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5530 (reviewed head `d3bee73707c865028ad58cdd40863e624e69101c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/x44bz7l-we-stacked-pr-policy-slice-4-closed-or-rejected-base-handlin.md:24` — (edge-case, broken) Closed-base recovery omits removal of the rejected parent's durable stack edge.
   - Scenario: A low-risk child has stackParents:["xbase01"] in its PR-body lane manifest. Its base is closed without merging; the child rebases cleanly onto main with an unchanged delta fingerprint and passes fresh review and CI. The specified recovery never requires updating that manifest, which survives a Git rebase. The existing planLabelDrain still requires positive landing proof for xbase01, so the child remains blocked indefinitely. A read-only probe of the checked-out planner returned ready:[] and deferred:[{waitOn:["xbase01"],...}]; clearing that obsolete edge made the same child ready. Recovery sho
   - Claude's re-check: demonstrated break

Operator ruling (chalbert via claude-code-chat): carded at the round cap. Reason: operator 2026-10-20 ~20:35 ET in chat: "Ok card it"; confirmed 2026-10-21 06:30 ET "Ok to all"

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
