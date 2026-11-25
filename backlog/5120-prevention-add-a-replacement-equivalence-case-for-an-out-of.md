---
bornAs: xweoi0x
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs"]
dateOpened: "2026-10-05"
preparedDate: "2026-11-25"
preparedAgainstSha: "5f7b1c25dcf36bf818e86c1361dbdc5f94701889"
tags: []
---

# Prevention — Preserve heavy-command replacement equivalence and one-shot defaults

Filed from the advisory review of web-everything/web-everything#3932. Preserve the original command target when suggesting admission, document wrapper classification, and prevent implicit Vitest watch defaults from occupying an admission slot.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3932@e01e1098d9ab683cef4efb16a713f0cf70f867cd

## Progress

- Original premise/scope: the review cited we:scripts/guard-bash.mjs:2540 and :2640 and assigned regression work to we:scripts/__tests__/guard-bash.test.mjs. It requested out-of-cwd standards replacement equivalence, wrapper spelling coverage, and deterministic default-mode Vitest replacements.
- Corrected premise/scope: implementation remains in we:scripts/guard-bash.mjs, but normalization is now at lines 3597–3640 and replacement construction at lines 3961–4016. The matching suite is we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs. Its lines 175–180 already table-test exec, env -i, stdbuf and nohup denial; line 277 covers npx -c. Extend this suite rather than duplicate those cases in the general suite.
- Remaining work is visible in source: we:scripts/guard-bash.mjs:4005–4006 replaces every recognized standards script with the cwd package alias, discarding an external script target. Lines 4003 and 4008 leave forwarded related defaults and implicit direct file runs without guaranteed one-shot normalization. The existing one-shot helper at line 3580 already handles these modes when called. Existing expectations at we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs:461 and :471–472 explicitly retain related without --run; the slot guarantee at lines 537–552 tests explicit watch forms and absence of watch tokens, which does not prove an explicit terminating mode.
- Keep size 3: expected touch set is roughly 25–45 changed implementation lines plus 80–120 test lines across the two scoped files. Wrapper coverage is partly delivered, but the replacement and default-mode gaps prevent an already-done disposition. This is source inspection evidence, not a claim of a passing runtime probe.

## Design

Preserve executable identity, arguments, quoting, environment assignments and npm workspace/prefix selection while recommending admission. For an out-of-cwd absolute target corresponding to we:scripts/check-standards.mjs, prefer the explicit queued original Node invocation over substituting the cwd package alias. Keep the local canonical alias where equivalence is known. Use generated temporary paths, including a path containing spaces, rather than a workstation-specific path.

Reuse oneShotVitest in we:scripts/guard-bash.mjs:3580 for executable Vitest replacements, including implicit file runs and direct or npm-forwarded related commands. Implicit file runs require run; related requires --run, exactly once. Preserve list/help inspection behavior and existing explicit-run, watch-flag, environment and workspace semantics. The npm test:unit alias is already one-shot (we:package.json:33); check:standards is already admitted (we:package.json:66). Neither package default needs changing.

Add an explicit wrapper expectation matrix to the existing heavy-enforce suite. Exec, env -i, stdbuf, nohup and npx -c around Node standards runs must be denied unqueued. Record direct tsx and bun standards spellings as currently outside the Node-only standards classifier, with allowed expectations after confirming through decide; this item documents that boundary rather than introducing a new runtime-enforcement policy. Keep already-admitted foreground commands allowed and existing wrapper-exhaustion refusal intact. No loosening of refusals or new fallback is intended.

## MVP

1. Extend we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs with named regression groups for external standards target equivalence, default-mode replacements, and the complete requested wrapper matrix.
2. Fix only the target selection and one-shot replacement paths in we:scripts/guard-bash.mjs. Update the old related expectations, including workspace and environment variants, to require --run.
3. Strengthen the admission-slot assertion to require an explicit terminating mode, not merely absence of watch tokens. Re-submit each generated suggestion to decide and require admission without a denial loop.

## Acceptance

All named tests below are planned additions in we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs. The replacement tests must fail against the pre-build implementation and pass after the fix; wrapper rows already covered are retained regression controls, not falsely claimed new failures.

- [A1] Executable — Test “5120 preserves an external standards target” must fail before the build and pass after: from a different cwd, extract the suggested command and assert it retains the exact quoted absolute target and arguments under admission. Include a space-bearing target and a local-alias control; a blanket cwd npm alias must fail this test.
- [A2] Executable — Test “5120 makes default-mode replacements one-shot” must fail before the build and pass after: direct implicit file runs require run; direct and npm-forwarded related runs require --run. Include npm workspace/prefix and environment callers, explicit-run idempotence, and existing watch variants. Each resulting suggestion must be accepted by decide.
- [A3] Executable — Test “5120 admission-slot defaults and wrapper boundaries” must fail before the build on its implicit/related default-mode rows and pass after. Assert explicit terminating modes and pin the allowed-or-denied wrapper matrix from Design. Include existing hop-budget exhaustion as a fail-closed control, full-suite refusal without its escape, and admitted foreground controls. Preserve inspection/list controls so normalization cannot turn a read into a test run.

## Test plan

Run the scoped suite via npm run test:unit with we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs as the file argument (remove the documentation-only we: prefix when executing). This alias enters we:scripts/readiness/heavy-admission.mjs; never run the test runner bare. Add the A1–A3 cases first, capture the expected failures in the new replacement/default rows, then implement and rerun the same suite. Use synthetic command strings and temporary fixtures under the task TMPDIR; do not launch actual standards gates or watch processes from the cases. Existing tests in that file cover adjacent parsing and replacement behavior.

## Proof plan

Capture the before/after named-test output for A1–A3 through the host queue. For A1, assert the extracted suggestion's executable target and arguments, not only a substring or non-null refusal. For A2/A3, assert explicit one-shot mode and successful guard re-entry; absence of watch flags alone is insufficient. Preserve all previously covered refusal controls. The runner owns preparation stamping and checks; this preparation makes no implementation edits and does not run a second review loop. If admission is busy, use its own bounded --wait-ms once, then report the unavailable evidence without polling.

## Follow-ups

Process-level enforcement and closing the direct tsx/bun standards-classification boundary remain separate work; this card neither claims those bypasses are safe nor changes that policy. Keep the wrapper matrix as the explicit record of the current parser boundary. No blockedBy change is proposed.
