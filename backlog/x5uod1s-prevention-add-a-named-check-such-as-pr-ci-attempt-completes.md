---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci-runners.test.mjs", "we:.github/workflows/ci.yml"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a named check, such as 'PR CI attempt completes on GitHub-hosted runners', asserting that this PR's t… (from plateauapp/plateau-app#249 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci-runners.test.mjs:21` — Add a named check, such as 'PR CI attempt completes on GitHub-hosted runners', asserting that this PR's test and e2e jobs both conclude successfully and have the required runner-name prefix using the attempt-specific jobs API.
2. `(no file cited)` — Add a named PR-specific changed-file check allowing only we:.github/workflows/ci.yml, we:CLAUDE.md, and the old/new paths of the renamed runner test.
3. `we:scripts/ci-runners.test.mjs:1` — Add a check:standards rule that fails CI if any `.github/workflows/*.yml` job (not only we:.github/workflows/ci.yml) uses `self-hosted` or a non-allowlisted runner label. Failing that, note live-run acceptance items as explicitly manual in the card template.
4. `(no file cited)` — Add named automated checks: 'PR attempt uses successful GitHub-hosted test and e2e jobs', asserting attempt-specific jobs API results, and 'PR changes only approved runner-migration files', asserting the changed-path allowlist.
5. `we:.github/workflows/ci.yml:50` — Add a named check, 'PR CI jobs succeed on GitHub-hosted runners', asserting both job conclusions and runner names from the attempt-specific jobs API.
6. `(no file cited)` — Add a named PR check, 'runner migration changes only approved paths', comparing changed paths against the workflow, we:CLAUDE.md, and both rename paths.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#249@5f514ff01cbddfc34577d40639dbec38b76ac4a8

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
