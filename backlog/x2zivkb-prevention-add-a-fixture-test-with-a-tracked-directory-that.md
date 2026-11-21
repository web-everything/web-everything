---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/sync-skills-deploy.mjs", "we:scripts/ci/test-timings.json", "we:scripts/__tests__/sync-skills-multiroot.test.mjs", "we:scripts/__tests__/sync-skills-deploy.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a fixture test with a tracked directory that has no we:SKILL.md and assert the intended outco… (from web-everything/web-everything#7281 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/sync-skills-deploy.mjs:242` — Add a fixture test with a tracked directory that has no we:SKILL.md and assert the intended outcome (skipped, or reported with accurate wording). Better, make `listSkillNames` require `we:SKILL.md` on disk, so 'no we:SKILL.md' (not a skill) is distinct from 'we:SKILL.md not committed' (untracked).
2. `we:scripts/ci/test-timings.json:318` — Add a `check:standards` rule that flags we:scripts/ci/test-timings.json keys with no file on disk, or leave removal to the timings-refresh job.
3. `we:scripts/__tests__/sync-skills-multiroot.test.mjs:196` — Add a `runCli` case: two git roots with the same skill name, assert exit 1, stderr names both paths, and `dest` does not exist.
4. `we:scripts/__tests__/sync-skills-multiroot.test.mjs:1` — File a card to add a WE-side test that asserts skills-src has no directory also present in the plateau-ops root. Link the plateau-ops no-dual-home and gitleaks workflow files from the PR as the named gates.
5. `we:scripts/sync-skills-deploy.mjs:280` — Add a test in we:scripts/__tests__/sync-skills-multiroot.test.mjs for a present non-git default ops root. Decide whether it should be a skip-with-warning or a hard refusal. Make the message generic ('source root') so it fits the primary root too.
6. `(no file cited)` — Supply deterministic tests, proposed names 'removed mirrors match retained originals' and 'no-dual-home CI rejects a duplicate skill', asserting content equality for all 38 removals and a failing gate for a duplicate fixture. Mutation verification was unavailable in the read-only environment.
7. `(no file cited)` — Add a deterministic workflow contract test in each repository, proposed name 'CI enforces gitleaks and tier-screen', asserting required invocation and failure propagation. Mutation verification was unavailable in the read-only environment.
8. `we:scripts/sync-skills-deploy.mjs:343` — Add a deterministic regression test covering absolute, relative, and trailing-slash aliases, including an explicit alias of the primary root.
9. `(no file cited)` — Add deterministic workflow-contract gates in both repositories checking scanner invocation and failure propagation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7281@b73d2a5d0cf9bb6ed12f440371687c2e307ae657

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
