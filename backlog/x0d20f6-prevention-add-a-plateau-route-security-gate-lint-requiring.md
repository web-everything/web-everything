---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/2773-steer-composer-for-a-running-build.md"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Add a Plateau route-security gate/lint requiring every mutating /api/backlog/* handler to go through a… (from chalbert/web-everything#3549 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/2773-steer-composer-for-a-running-build.md:30` — Add a Plateau route-security gate/lint requiring every mutating /api/backlog/* handler to go through a shared origin/host-check helper, with a test table asserting foreign Origin/Host is refused; until then, add an explicit acceptance bullet to this card for Origin/Host validation on the steer route.
2. `we:backlog/2773-steer-composer-for-a-running-build.md:31` — Add a standards/lint check (or card-template acceptance item) that any new HTTP route spec states a body-size cap and a 413 test; capture as a future backlog item.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3549@9b9202ba1a41b86de8277f49608adc0ce6b50b4f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
