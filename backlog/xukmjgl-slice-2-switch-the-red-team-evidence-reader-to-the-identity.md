---
bornAs: xukmjgl
kind: story
size: 3
parent: "x5wqxb3"
status: open
blockedBy: ["xbyg4e4"]
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/lib/review-run-index.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 2: switch the red-team evidence reader to the identity index behind a cascade setting

Epic x5wqxb3. Blocked on an operator ruling (Option A on the epic): a PR's red-team evidence depends only on that PR's records, with a loud store-health alarm on any corrupt review-pr record. Adds the cascade setting redTeam.reviewRunIndexReader (standard shadow, then on), logged with its source each pass, plus the writer fence: it falls back to a full scan unless every live daemon build includes slice 0. It switches only after a mismatch-free shadow soak. Proof: live mergeCascade pass seconds before/after and a Codex guard verdict. Delivery mode: prototype.

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
