---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.ts", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add fixture cases to we:scripts/__tests__/check-standards.test.ts for a regular file at ../webeverything (… (from frontier-ui/frontierui#59 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:56` — Add fixture cases to we:scripts/__tests__/check-standards.test.ts for a regular file at ../webeverything (ENOTDIR/not-a-directory) and for a non-ENOENT stat failure such as a self-referencing symlink (ELOOP), asserting exit 1 and no skip warning. The general gate would be branch coverage over we:scripts/check-standards.mjs, which running a copy in a subprocess does not currently measure.
2. `we:scripts/check-standards.mjs:80` — Add a ratchet test that pins the allowed set of pairs (or its maximum size) and fails on any addition, and also flags entries whose block id and path no longer appear in we:blocks.json.
3. `we:scripts/check-standards.mjs:57` — Add we:scripts/__tests__/check-standards.test.ts cases where `../webeverything` is a regular file and where stat fails with a non-ENOENT code (for example a self-referencing symlink giving ELOOP), each asserting exit 1 and no skip warning.
4. `we:scripts/check-standards.mjs:80` — Add a ratchet test or check:standards rule that pins the allowed entries (or a maximum count) and fails on any new one.
5. `we:scripts/__tests__/check-standards.test.ts` — Add an assertion that the successful fixture reports zero warnings to the existing named regression test.
6. `we:scripts/check-standards.mjs:78` — Add a deterministic unit test requiring the current exception set to be a subset of a frozen baseline, allowing removals but rejecting additions.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#59@a7639015d5695778e798dbe0917eeb8ab29bed41

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
