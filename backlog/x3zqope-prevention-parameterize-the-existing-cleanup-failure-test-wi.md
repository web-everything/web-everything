---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/advisory-merge.mjs", "we:scripts/conveyor/soak/breaks/settings-registry-doc-conflict-regenerated.mjs", "we:scripts/lib/daemon-rebuild/__tests__/advisory-merge.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/settings-registry-doc-conflict-regenerated.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Parameterize the existing cleanup-failure test with a throwing onDiagnostic callback and assert s… (from web-everything/web-everything#7322 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/advisory-merge.mjs:30` — Parameterize the existing cleanup-failure test with a throwing onDiagnostic callback and assert successful tree, commit, and stage results.
2. `we:scripts/conveyor/soak/breaks/settings-registry-doc-conflict-regenerated.mjs:42` — Set repository-local fixture identity and run the soak test in a deterministic CI environment with author/committer variables unset and automatic identity inference disabled.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7322@716ce5da829248ca9e821f0c425541779aa71655

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
