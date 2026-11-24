---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/secret-scan.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7398 (head 1bdc26b9a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7398 (reviewed head `1bdc26b9ae7cb47a6156c4e9822552527fbfb0c0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/secret-scan.mjs:131` — (failing-input, degraded) Ordinary JSON array-string edits are reported as private keys
   - Scenario: Fix we:package.json line 133 from "polylfill", to "polyfill", using a zero-context diff. The CLI exits 1 and prints we:package.json:133 private-key-structure. It synthesizes a private JWK member around the ordinary array element. This valid, credential-free keyword correction should pass.
   - Class: live-reproduced (basis: Reproduced through --stdin with the shipped allowlist. The modified we:package.json parses successfully, and the shared structural detector returns null for the complete modified file.)
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
