---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/delivery/delivery-read.test.ts", "we:src/delivery/delivery-validate.test.ts"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Use a required-file parameterized test covering plan, progress and stepMap, with an assertion that each E… (from plateauapp/plateau-app#247 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/delivery/delivery-read.test.ts:80` — Use a required-file parameterized test covering plan, progress and stepMap, with an assertion that each ENOENT returns ok:false.
2. `we:src/delivery/delivery-validate.test.ts:290` — Add deterministic cases for omitted and explicit ref/role values, asserting both normalized output and warnings.
3. `we:src/delivery/delivery-validate.test.ts:268` — Parameterize optional worker fields across omitted, null, valid and invalid values, asserting worker retention or removal and the corresponding warning.
4. `we:src/delivery/delivery-read.test.ts` — Restore a deterministic parameterized test covering ENOENT for all three required filenames and asserting the complete failure result.
5. `we:src/delivery/delivery-read.test.ts` — Restore a required-file ENOENT matrix in the test gate, covering plan, progress, and stepMap with explicit failure assertions.
6. `we:src/delivery/delivery-read.test.ts` — Add an AST-based deterministic import allowlist with negative cases for named write imports, namespace/default imports, dynamic imports, and both fs/promises module spellings.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#247@704627c0cbd2da9bd2272bfe7ad02831c9ce2539

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
