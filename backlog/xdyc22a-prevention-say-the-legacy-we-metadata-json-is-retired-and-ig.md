---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/settings-registry.mjs", "we:scripts/lib/daemon-rebuild/advisory-merge.mjs", "we:package.json", "we:scripts/lib/__tests__/settings-registry.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/advisory-merge.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Say the legacy we:metadata.json is retired and ignored, not generated. A lint is not worth buildi… (from web-everything/web-everything#7389 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/settings-registry.mjs:195` — Say the legacy we:metadata.json is retired and ignored, not generated. A lint is not worth building for this class of defect.
2. `we:scripts/lib/daemon-rebuild/advisory-merge.mjs:16` — Add a check-standards rule or test that every file readMetadata can read is either listed in GENERATED_MERGE_PATHS inputs or gitignored and refused if tracked.
3. `we:package.json:8` — Add a deterministic test in we:scripts/lib/__tests__/settings-registry.test.mjs that invokes the npm script in an isolated fixture and asserts that the previously missing document equals the expected render.
4. `we:package.json:8` — Add a deterministic test named `npm settings:registry generates the missing document` in we:web-everything/scripts/lib/__tests__/settings-registry.test.mjs that invokes the package command in an isolated fixture and asserts successful exit and document bytes equal to the render.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7389@41182e4eeb914d5583e0cda45a3bb640f23f5ca3

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
