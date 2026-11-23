---
kind: story
size: 3
status: open
scope: ["we:scripts/ci/secret-scan.mjs", "we:scripts/ci/__tests__/secret-scan.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Scan each commit's added lines (git log -p --no-merges base..head) or git diff per commit, and ad… (from web-everything/web-everything#7398 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7398's review (reviewed head `898212fb40b22a774dea2a8ee02cd318f00a60ac`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/ci/secret-scan.mjs:196` — Scan each commit's added lines (`git log -p --no-merges base..head`) or `git diff` per commit, and add a test with an add-then-remove two-commit repo. Until then, list this in the waived-gaps card.
2. `we:scripts/ci/__tests__/secret-scan.test.mjs` — Add a deterministic required-check configuration assertion, named 'keeps secret-scan optional until operator activation', checking that secret-scan is absent before explicit activation; use an exported ruleset if configuration lives outside the repository.
3. `we:scripts/ci/__tests__/secret-scan.test.mjs` — Add a deterministic rollout check against the authoritative ruleset configuration that asserts secret-scan remains optional until rollout approval.

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
