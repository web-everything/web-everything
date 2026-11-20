---
bornAs: xd12x2e
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "b435fe7f9d6aa22719d214c9c72057fa59ac5ece"
tags: []
---

# Prevention — Add negative-case tests (vitest --version, vitest --config x run f) to the 'admitted vitest must be one… (from chalbert/web-everything#3258 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:640` — Add negative-case tests (`vitest --version`, `vitest --config x run f`) to the 'admitted vitest must be one-shot' describe block. The sibling test in #3793 already pins `npx vitest --version` as unflagged for the raw form.
2. `we:scripts/guard-bash.mjs` — A unit test explicitly asserting that non-vitest commands containing 'vitest' as an argument (e.g. `npx foo vitest`) are not flagged by the vitest guard.
3. `we:scripts/guard-bash.mjs` — A unit test asserting that `yarn vitest` without `--run` is also caught by the watch mode guard.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3258@8e15f9fa8d7dbc18ae1f900501bf25685f622bec

## Done when

Acceptance uses the existing `admitted vitest must be one-shot (#4449)` block in `we:scripts/__tests__/guard-bash.test.mjs`. W denotes the admission-wrapper command prefix already defined there. Each named regression below must fail against the pre-build guard and pass after the fix; exercise both `admittedVitestWatchReason` and its dispatched caller for build, fix, and ci-heal.

- [A1] **Executable** — test `allows admitted vitest version queries`: W + `vitest --version` and W + `npx vitest --version` return null. These queries must not be classified as resident watchers.
- [A2] **Executable** — test `allows admitted run after config options`: W + `vitest --config x run f` returns null; include the npx spelling. A consumed config value must not hide the subsequent run subcommand.
- [A3] **Executable** — test `ignores vitest in another executable's arguments`: W + `npx foo vitest` returns null. An argument named vitest must not select the vitest guard.
- [A4] **Executable** — test `denies admitted yarn vitest without one-shot mode`: W + `yarn vitest` returns a reason matching `--run`; pair it with allowed `yarn vitest run f` and `yarn vitest --run` controls.
- [A5] **Executable** — test `does not consume option values as one-shot evidence`: W + `vitest --config --run` and W + `vitest --config run` remain denied. A value or incomplete value-taking option is not evidence of one-shot execution. The former currently passes incorrectly, so this test is red before the fix. Include missing-value `vitest --config` and bare/related commands as refusal controls.

## Design

Fix command recognition within `admittedVitestWatchReason` in `we:scripts/guard-bash.mjs:640`, retaining admission-wrapper scoping and the caller contract at `we:scripts/guard-bash.mjs:657`. Determine the actual child executable rather than searching all child words for vitest. Reuse the existing executable-position normalization in `we:scripts/guard-bash.mjs:3597` (`normalizeHeavyHead`) and runner parsing in `we:scripts/guard-bash.mjs:1051` (`runnerInvocation`), preserving raw token offsets/quoting when extracting the child after the wrapper separator.

For a recognized vitest invocation, scan argument positions while consuming known value-taking options from `VITEST_VALUE_FLAGS` in `we:scripts/guard-bash.mjs:3416`. Recognize a real run subcommand after config options and a real version flag as non-watching. Retain the existing explicit one-shot flags. Option values must not count as subcommands or flags; absent one-shot evidence, retain refusal. Do not loosen the separate raw-heavy admission policy or change interactive-session defaults. The dispatched caller must continue applying the watch guard before its wrapper exemption.

## MVP

Change only the two scoped files: the watch classifier and its existing unit-test block. Add the five named regression tests with table-driven spellings and dispatch kinds. Preserve the existing tests for related without --run, explicit one-shot flags, direct run, interactive behavior, and the brief-derived command. No new settings, caller API, persisted-state migration, CLI dependency, or runtime vitest invocation is needed; command strings are input to pure guard functions.

## Test plan

Run the focused existing block through the host queue. The following shell command uses WE-relative paths at execution time; its referenced files are `we:scripts/readiness/heavy-admission.mjs` and `we:scripts/__tests__/guard-bash.test.mjs`:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
test_file=we:scripts/__tests__/guard-bash.test.mjs
node "${queue#we:}" run --wait-ms=1000 -- npx vitest run "${test_file#we:}" -t 'admitted vitest must be one-shot'
```

Add A1–A5 first and capture the expected failing assertions before modifying the guard. After implementation, run that command again, then run the same admitted command without the title filter to cover the affected file's other guard callers. Keep the raw version-query negative at `we:scripts/__tests__/guard-bash.test.mjs:147`. If capacity is unavailable after the queue's bounded wait, report deferral; do not poll or run unslotted.

## Proof plan

Attach before/after output for A1–A5 and the affected-file run, including actual assertion failures and final test counts. A1–A4 must invert the four observed classifications below. A5 proves that accepting config-before-run does not accidentally accept a config value as execution mode. Existing interactive and wrapper tests provide unchanged-default/caller coverage. The runner owns preparation stamping and standards checks; this preparation does not claim the implementation is fixed.

## Follow-ups

None required to deliver this item. Broader shell parsing or additional runner-policy changes should be separate work supported by a reproducer; do not expand this prevention fix into a new command policy.

## Progress

- Original premise: missing negative tests only, citing `we:scripts/guard-bash.mjs:538`. Corrected premise: the helper is now at `we:scripts/guard-bash.mjs:640`; its word search and runner allowlist at lines 647–651 cause real classification defects. The relevant test block is at `we:scripts/__tests__/guard-bash.test.mjs:4038`; it covers related, one-shot flags, run, interactive behavior, and the brief mutation, but none of the four requested inputs. The raw-form version negative remains at `we:scripts/__tests__/guard-bash.test.mjs:147` and does not exercise the admitted helper.
- Source evidence: `we:scripts/guard-bash.mjs:648` accepts npx-family prefixes without checking the executable position and excludes yarn; line 650 recognizes run only as the first argument; line 651 counts flags even when they are option values. Existing reusable normalization and value-flag inventory live at `we:scripts/guard-bash.mjs:3597` and `we:scripts/guard-bash.mjs:3416`.
- Observed through a successful host-heavy-admission queued Node import probe: admitted `vitest --version`, `vitest --config x run f`, and `npx foo vitest` each returned a denial; admitted `yarn vitest` returned null. No vitest processes were launched by those input strings. This is not already delivered.
- Original and corrected file scope are identical: `we:scripts/guard-bash.mjs` plus `we:scripts/__tests__/guard-bash.test.mjs`. Work expands from nominal test additions to a focused classifier correction backed by those tests. Size remains 3 (old 3 → new 3): approximately 30–50 changed source lines around the helper and 45–65 test lines around the existing describe block, roughly 75–115 changed lines total across two files. This is a story, so no estimatedLoc field is added.
