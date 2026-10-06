---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:skills-src/coroner/SKILL.md", "we:scripts/operations/__tests__/coroner-extract.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Run a mutation check (Stryker, or a manual break-the-line step) on new scripts. Write a test besi… (from web-everything/web-everything#4044 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-extract.mjs:4` — Run a mutation check (Stryker, or a manual break-the-line step) on new scripts. Write a test beside each documented guarantee in a file header.
2. `we:skills-src/coroner/SKILL.md:12` — Have the skill run extract with `--no-save` and commit the window end only after the append step succeeds. For example, add a `--commit-state=<until>` step, or make the SKILL step order explicit.
3. `we:skills-src/coroner/SKILL.md:41` — Add a check:standards rule for skills-src/**/SKILL.md. A skill that reads transcripts, logs or PR text and writes files must include an 'untrusted data' clause. Heredoc appends must use a per-run random delimiter or a file-write tool instead of a fixed `EOF2`.
4. `we:scripts/operations/coroner-extract.mjs` — Count complete normalized commands and truncate only displayed evidence; add a deterministic regression test requiring three commands with identical 200-character prefixes and different suffixes to produce zero loops.
5. `we:scripts/operations/__tests__/coroner-extract.test.mjs` — Add a deterministic test named 'sums overlapping gate durations and caps share at one', with total gate duration exceeding session duration, asserting both the summed minutes and shareInGate === 1.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4044@d256dfa1de794cd742e8084261e7747956d15007

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
