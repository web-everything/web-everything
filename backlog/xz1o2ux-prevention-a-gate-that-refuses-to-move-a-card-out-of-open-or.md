---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x5059uu-daemon-rebuild-keeps-the-adopted-overlay-set-and-parks-the-c.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — A gate that refuses to move a card out of open (or into a build lane) while any 'TODO:' placehold… (from web-everything/web-everything#4682 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x5059uu-daemon-rebuild-keeps-the-adopted-overlay-set-and-parks-the-c.md:30` — A gate that refuses to move a card out of open (or into a build lane) while any 'TODO:' placeholder remains in Acceptance, Non-goals or Edge cases, with the Untrusted text and Fail closed lines required to be non-n/a when the card posts externally derived text.
2. `we:backlog/x5059uu-daemon-rebuild-keeps-the-adopted-overlay-set-and-parks-the-c.md:12` — Add planned cases in we:scripts/lib/__tests__/daemon-rebuild.test.mjs named 'parks changed earlier-registered overlay while preserving adopted overlays' and 'reports parked newcomer and any established-overlay removal'. Specify assertions for retained HEAD content, parked newcomer state, alert fields, and PR notification. A deterministic backlog gate should require named planned tests for behavioral guarantees before implementation begins.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4682@fe5d2ffcd4d703faa0552056cbabc53f7b101436

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
