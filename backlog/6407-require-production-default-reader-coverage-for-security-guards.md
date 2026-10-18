---
bornAs: xdfwrg1
kind: task
status: open
parent: "6271"
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
scopeRationale: "Extend the existing test-plan lint and its split content-lint test file."
dateOpened: "2026-10-18"
tags: []
---

# Require production default reader coverage for security guards

PR 5520's security review found that injected run readers could not protect the production default that sees unfinished reviews. The repair adds real-store regressions in `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs`, including `default run readers refuse an unfinished %s live-head review through resolveRunsDir`. Add a test-plan rule requiring a named regression without injected readers whenever a security guard selects its reader through a default parameter.

## Design

Validate an explicit default-reader coverage mapping in the existing test-plan lint. Require a test file, exact case name, and observable refusal or successful control. Do not infer behavioral coverage from matching function names.

## MVP

Require the mapping for newly authored or edited security guard risk constraints; leave legacy cards outside blocking enforcement until a rollout policy is declared.

## Done when

- [A1] `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` case `security reader defaults require a named regression without injected readers` reports a missing default-path mapping even when injected-reader tests are named.
- [A2] The same file's case `security reader default mapping accepts a real-store refusal and positive control` accepts a complete mapping with exact names and assertions.
- [A3] The same file's case `legacy security reader mappings remain nonblocking outside edited cards` pins the scoped rollout.

## Edge cases

Treat Markdown and test names as data. Report missing file, case, or assertion separately and attribute each diagnostic to its own card. A generic injected-reader test does not satisfy the mapping.

## Test plan

Run the three named content-lint cases through the unit-test gate. Preserve the PR 5520 real-store regression, which asserts `MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN` without `readRuns` or `readRunHeads` overrides, alongside its clean carry control.

## Proof plan

Show a scoped lint refusal for a security-reader risk with only injected-reader tests, then acceptance when its named default-reader regression and observable assertion are supplied.
