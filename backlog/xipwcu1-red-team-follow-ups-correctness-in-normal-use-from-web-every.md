---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/merge-gate-pin-probe.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7433 (head dc2eba3c2)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7433 (reviewed head `dc2eba3c2e42cdaab8834329b9feced9a84c8769`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/merge-gate-pin-probe.mjs:34` — (edge-case, degraded) Branch-rule pagination causes a valid pin to be reported missing
   - Scenario: Configure 31 active branch rules with the matching merge-gate workflow rule on page two. The CLI requests rules/branches/main once without pagination, receiving only the default first 30 rules. It reports missing and fails despite the valid pin. Reproduced with an injected executor modeling paginated responses; evaluating the complete rule list returns pinned. Read all pages before declaring the pin missing, or return unknown when completeness cannot be established.
   - Class: correctness-in-normal-use (basis: Ordinary API pagination can hide an existing pin. A read-only Node probe reproduced the false failure through main using injected responses; no live GitHub request was made. The existing required-status-checks reader also documents this endpoint's 30-rule default and explicitly paginates it.)
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
