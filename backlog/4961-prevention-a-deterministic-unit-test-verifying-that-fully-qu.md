---
bornAs: xy6wt3g
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-01"
tags: []
---

# Prevention — A deterministic unit test verifying that fully-qualified cross-origin HTTPS links (e.g., https://ci.example… (from chalbert/plateau-app#192 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/backlog-view/proof-tiers.ts:71` — A deterministic unit test verifying that fully-qualified cross-origin HTTPS links (e.g., `https://ci.example/...`) are preserved and rendered correctly when the provided `baseUrl` belongs to a different origin.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#192@decd6891d8fe7228e16e8eb52666e70ef9e9c1fb

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-11-20)

The build-dispatch daemon held #4961 with:

> worker-declined: Not prepared: #4961 — could-not-prepare. The requested preservation guarantee conflicts with the current same-origin policy in 'plateau:src/backlog-view/proof-tiers.ts:76'. The test at 'plateau:src/backlog-view/proof-tiers.test.ts:166–169' explicitly requires cross-origin CI links to become '#'. The unresolved choice is whether to retain that policy or permit cross-origin HTTPS evidence. Choosing either would change the requested goal or existing policy. No files changed or stamps added. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
