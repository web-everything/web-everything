---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4362-write-guard-must-cover-the-control-clone-workspace-wev-contr.md"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — A prepare-stamp consistency check that every test named in Done-when has a declared 'red-before'… (from web-everything/web-everything#4334 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4362-write-guard-must-cover-the-control-clone-workspace-wev-contr.md:128` — A prepare-stamp consistency check that every test named in Done-when has a declared 'red-before' or 'green-before pin' tag. Failing that, a card-prepare checklist item to re-read Done-when after the Test plan changes.
2. `we:backlog/4362-write-guard-must-cover-the-control-clone-workspace-wev-contr.md:47` — A test-plan line for every smell with missingSubjectsUnknown: 'subject disappears permanently, and the episode closes or is explicitly expired'. A health-smell standards rule could require that missingSubjectsUnknown smells declare an expiry or TTL.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4334@d2dfe00a540b507e772422178e6f4dea411bb1e2

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
