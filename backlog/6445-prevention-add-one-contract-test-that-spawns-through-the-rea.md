---
bornAs: x415uyn
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs", "we:scripts/operations/prepare-light-revalidate.mjs", "we:docs/agent/testing.md", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/__tests__/prepare-light-revalidate.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add one contract test that spawns through the real detached-dispatch helper and asserts the env v… (from web-everything/web-everything#5484 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:3417` — Add one contract test that spawns through the real detached-dispatch helper and asserts the env var reaches the child. A broader gate would require every env var read in parseArgs to have a named propagation test.
2. `we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs:83` — Parameterize the invalid-value matrix over every cascade layer (platform, tool, env) in the settings test helper.
3. `we:scripts/operations/prepare-light-revalidate.mjs:27` — Table-drive the scope-safety predicate with one row per rejection clause. A mutation-testing gate on the evidence-builder module would also catch this.
4. `we:docs/agent/testing.md:1573` — Add a test that asserts, after the light still-valid path, that the only git effects are a card-only commit plus openPr (no push to main) and that the card's readiness still depends on the stamp being on main. A doc-claim-to-test lint would catch this class.
5. `we:scripts/operations/prepare-light-revalidate.mjs:29` — Add a byte ceiling beside the line cap and a test with a long-line diff; ideally a shared helper for 'bounded evidence' used by all fenced prompts.
6. `we:scripts/operations/__tests__/probation-build-run.test.mjs` — Capture a fresh baseline immediately before the directory mutation, and add a targeted mutation gate requiring this named test to fail when directory entries are excluded from the fingerprint.
7. `we:scripts/operations/__tests__/probation-build-run.test.mjs` — Add a deterministic regression case with a fresh baseline where the only change is adding or removing a child of a collapsed ignored directory; verify it detects removal of directory fingerprinting.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5484@770a6487cb5976595447be973754c963036f20ab

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
