---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/sync-skills-multiroot.test.mjs", "we:scripts/__tests__/providers-skill.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Link each out-of-repo Acceptance item to the PR or CI check in its own repo, and record that link… (from web-everything/web-everything#7281 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/sync-skills-multiroot.test.mjs:1` — Link each out-of-repo Acceptance item to the PR or CI check in its own repo, and record that link in the card.
2. `we:scripts/__tests__/providers-skill.test.mjs:1` — Add a check:standards rule: a PR that deletes a *-skill.test.mjs must either delete no `skills-src` we:SKILL.md that contains safety prose, or link the replacement test path in the PR body. As a lighter alternative, the plateau-ops no-dual-home CI could also run a provider-routing assertion test.
3. `we:scripts/__tests__/sync-skills-multiroot.test.mjs` — Add a deterministic destination-repository test, proposed as we:plateauapp/plateau-ops/scripts/__tests__/skills-home.test.mjs: 'providers and review-design have tracked canonical homes', asserting both actual we:SKILL.md files exist and are tracked.
4. `(no file cited)` — Capture a deterministic migration comparison, proposed as we:plateauapp/plateau-ops/scripts/__tests__/skills-home.test.mjs: 'all 38 retired mirrors match retained homes', asserting the expected manifest count and file-content equality against the pre-removal revision.
5. `(no file cited)` — Add a deterministic CI contract test, proposed as we:plateauapp/plateau-ops/scripts/__tests__/skills-home-ci.test.mjs: 'CI rejects a duplicate home', asserting workflow invocation and nonzero status for a duplicate fixture.
6. `(no file cited)` — Add deterministic workflow contract tests in we:plateauapp/plateau-ops/scripts/__tests__/ci-contract.test.mjs and we:plateauapp/plateau-settings/scripts/__tests__/ci-contract.test.mjs, proposed name 'required CI runs gitleaks and tier-screen', asserting both checks are invoked and failures propagate.
7. `(no file cited)` — Add repository-qualified deterministic checks for the real relocated skill files, the expected mirror-removal manifest and content equality, unique skill homes, and required CI jobs in plateau-ops and plateau-settings; attach their named cases to Acceptance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7281@84287b17515a9ef05aad0dd02228392b54b5ba9e

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
