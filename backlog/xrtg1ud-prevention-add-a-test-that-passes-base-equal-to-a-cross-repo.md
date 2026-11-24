---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/sibling-base-check.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/__tests__/sibling-base-check.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test that passes base equal to a cross-repository PR's head name and expects a refusal. As… (from web-everything/web-everything#7431 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/sibling-base-check.mjs:55` — Add a test that passes `base` equal to a cross-repository PR's head name and expects a refusal. As a longer-term guard, route all PR-identity matching through one same-repo helper.
2. `we:scripts/lib/sibling-base-check.mjs:46` — Add a merge-commit case to we:open-pr-sibling-base.test.mjs. The suggested name is 'treats a merge commit with no cherry row as unlanded'.
3. `we:scripts/operations/open-pr-io.mjs:259` — Add a runner test that checks the sibling reader is not called under `--dry-run` and that the argv sent to pr-land still carries `--dry-run`.
4. `we:scripts/operations/open-pr-io.mjs:147` — Add a deterministic boundary test using otherwise valid records and a targeted mutation check that removing the cutoff makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7431@e1e85d12fa7c6676299f85f798118372202c4bcc

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
