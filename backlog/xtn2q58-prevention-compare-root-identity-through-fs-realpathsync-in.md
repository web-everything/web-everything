---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/sync-skills-deploy.mjs", "we:scripts/__tests__/providers-skill.test.mjs", "we:scripts/__tests__/sync-skills-deploy.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Compare root identity through fs.realpathSync in resolveRoots and in buildPlans (also against src… (from web-everything/web-everything#7281 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/sync-skills-deploy.mjs:343` — Compare root identity through `fs.realpathSync` in `resolveRoots` and in `buildPlans` (also against `srcRoot`). Add a test where one checkout is reached through two spellings.
2. `we:scripts/sync-skills-deploy.mjs:343` — Print one stderr or JSON note listing which roots were used and which default root was skipped. Add a test that asserts the note.
3. `we:scripts/sync-skills-deploy.mjs:247` — Pass a role label to `gitToplevel`. Cover it with a test asserting the primary-root error text.
4. `we:scripts/__tests__/providers-skill.test.mjs:1` — Add a lint or write-gate rule: when a PR deletes a test file, each guarantee it asserts must either appear in a test added in the same PR or be listed in the PR body as ported to a named test in another repo.
5. `we:scripts/sync-skills-deploy.mjs:343` — Add a root manifest or a `--require-root` flag, so `--check` in CI fails when a root named by the manifest is missing. Alternatively, have `--check` print a visible 'default ops root absent: N skills unchecked' line.
6. `(no file cited)` — Add a deterministic migration check named 'all 38 removed mirrors match their retained homes' using pinned pre-removal revisions and asserting the exact inventory and file-content equality.
7. `(no file cited)` — Add a deterministic CI integration test named 'no-dual-home CI fails on a duplicate skill' that injects a duplicate fixture and asserts the required job fails.
8. `(no file cited)` — Add deterministic tests in both repositories named 'CI rejects the gitleaks violation fixture' and 'CI rejects the tier-screen violation fixture', asserting nonzero job results through the configured CI entrypoints.
9. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring every cross-repository guarantee to reference a repository-qualified named test and its observable assertion, including migration content equality and negative CI fixtures.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7281@74a68fc2b98c94ad4c9bf0dfd5ce3130040bcacb

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
