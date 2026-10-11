---
bornAs: x2nsoej
kind: story
size: 3
status: open
scope: ["we:.github/workflows/merge-gate.yml", "we:scripts/lib/merge-gate-ci.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a deterministic gate, either in rulesetSuggestion or as a check:standards rule, that fails wh… (from web-everything/web-everything#4876 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4876's review (reviewed head `12583c4873a3004e57db7cae44ac0117f11646f7`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:.github/workflows/merge-gate.yml:58` — Add a deterministic gate, either in `rulesetSuggestion` or as a `check:standards` rule, that fails when `merge-gate` is listed as a required check while the resolved mergeGate.mode is shadow.
2. `we:scripts/lib/merge-gate-ci.mjs:454` — Make the CLI exit 3 with a usage error when the file is run as the entry point without a recognised mode flag, and add a test that spawns it bare.
3. `we:.github/workflows/merge-gate.yml:74` — Add a test that the merge_group path evaluates body-derived rules (manifest and authorship) from the live PR body, and note in the workflow that the backstop applies only in enforce.
4. `we:scripts/lib/merge-gate-ci.mjs:442` — Add a deterministic wrapper test covering signal termination with complete HOLD JSON, and preserve abnormal termination information when deciding whether shadow mode may override the exit status.

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
