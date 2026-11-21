---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/sync-skills-deploy.mjs", "we:scripts/__tests__/providers-skill.test.mjs", "we:scripts/__tests__/sync-skills-multiroot.test.mjs", "we:scripts/__tests__/sync-skills-deploy.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Record the plateau-ops no-dual-home check as a named card with its own test in that repo, and seq… (from web-everything/web-everything#7281 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/sync-skills-deploy.mjs:259` — Record the plateau-ops no-dual-home check as a named card with its own test in that repo, and sequence the merges: the ops mirror drop lands before this PR.
2. `we:scripts/sync-skills-deploy.mjs:251` — Make the `gitToplevel` message role-neutral ('source root') and add a primary non-git CLI test.
3. `we:scripts/__tests__/providers-skill.test.mjs:1` — Add a lint or standards rule so that a PR deleting a *.test.mjs must name the replacement test, or state that the guarded assertions are intentionally dropped. Alternatively, have the relocation checklist require porting the tests with the skill.
4. `we:scripts/__tests__/sync-skills-multiroot.test.mjs:1` — Split cross-repo guarantees into their own cards. Each card links the PR or test in the repo that owns it, or the Acceptance lists the owning-repo test by name.
5. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring repository-qualified test files, case names, and observable assertions for each guarantee. Supply downstream checks asserting both relocated skills exist, the 38 mirrors matched before removal and are absent afterward, duplicate homes fail CI, and both repositories run the promised scanners.
6. `(no file cited)` — Add a deterministic migration verification gate that checks the destination skill contents, expected mirror removals, uniqueness across source roots, and required CI configuration in plateau-ops and plateau-settings; map each Acceptance guarantee to a named assertion.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7281@d51012dbceee028d25184c04928da32b2f7e79d5

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
