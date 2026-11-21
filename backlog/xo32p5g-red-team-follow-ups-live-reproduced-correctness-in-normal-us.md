---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/static-selection-edges.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7275 (head a7152dcbf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7275 (reviewed head `a7152dcbf8ced0afff77439458048d8552e7cfa9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/static-selection-edges.mjs:34` — (failing-input, degraded) Newline handling can erase a real dependency without marking the file unknown.
   - Scenario: Use tracked we:a.test.cjs containing 'let value\n/[/*]/.test("/");\nrequire("we:./x.cjs");', with tracked we:x.cjs changed. JavaScript accepts this semicolonless declaration, and execution reaches require("we:./x.cjs"). The scanner retains division state across the newline, misreads the regex's /* as a block comment, and discards the require. Reproduced shadowSelection output: mode related, tests empty, staticTests empty, partial false, unknownFiles empty. It should select we:a.test.cjs through the dependency or mark the file unknown so selection widens.
   - Class: live-reproduced (basis: A read-only Node probe executed the valid source with an injected require and observed we:./x.cjs, then passed identical source to shadowSelection and observed the clean empty selection. Impact is limited to shadow diagnostics.)
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
