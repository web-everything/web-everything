---
bornAs: xmco3wr
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5624 (head 2b893754c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5624 (reviewed head `2b893754ccf3ed784ba432d7dbc0ee0809622963`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/heavy-admission.mjs:1208` — (edge-case, degraded) Host-load waiters block interactive commands despite free slots
   - Scenario: Start a mandatory noninteractive FULL caller at load 36 on 12 cores with cap=1 and no occupied slots. It registers a waiting marker, then sleeps for host load. Start an interactive FULL caller afterward. Its host check admits it, but FCFS ranks it behind the sleeping background caller. An in-memory filesystem probe reproduced three blocked polls with zero held slots. This can delay the operator for the default 15-minute host wait plus the background job's runtime. Callers waiting for host eligibility should not prevent an eligible interactive caller from taking a free slot.
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
