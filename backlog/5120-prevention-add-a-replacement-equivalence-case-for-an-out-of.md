---
bornAs: xweoi0x
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs"]
dateOpened: "2026-10-05"
preparedDate: "2026-11-25"
preparedAgainstSha: "fce223e9806756bfaf88b0247d06b99854269c09"
tags: []
---

# Prevention — Preserve standards-script targets and make queued Vitest replacements one-shot

Preserve the prevention goal from web-everything/web-everything#3932: replacement equivalence for an out-of-cwd absolute invocation of `we:scripts/check-standards.mjs`, explicit wrapper expectations, and deterministic one-shot Vitest suggestions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3932@e01e1098d9ab683cef4efb16a713f0cf70f867cd

## Progress

- Original premise/scope: the review cited `we:scripts/guard-bash.mjs:2540` and `we:scripts/guard-bash.mjs:2640`, with tests in `we:scripts/__tests__/guard-bash.test.mjs`, and requested all three prevention groups as new coverage.
- Corrected premise/scope: normalization is now at `we:scripts/guard-bash.mjs:3597`; replacement construction is at `we:scripts/guard-bash.mjs:3999`. The focused suite is `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs`. Its wrapper table at line 175 already covers exec, env -i, stdbuf and nohup; command-string coverage at line 191 covers npx -c. Extend these rather than duplicating them in the general suite.
- Remaining gaps: `we:scripts/guard-bash.mjs:4005` replaces every recognized standards invocation with the current package's npm alias, discarding the original script path. `we:scripts/guard-bash.mjs:4008` calls the existing one-shot normalizer only for explicit watch modes; the npm subcommand branch at line 4002 never calls it. Existing expectations at `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs:461` and lines 471–472 explicitly retain related's implicit mode. The admission-slot table at line 538 covers explicit watch forms only.
- Observation: a preparation probe through the host heavy-admission queue called `decide` on an absolute synthetic standards target outside cwd, implicit direct Vitest, direct related, and npm-forwarded related. It returned an npm standards alias without the original target, and three queued suggestions without explicit one-shot mode. Direct tsx and bun standards invocations returned null. No standards job or Vitest child was launched by the probe. The goal is not already delivered.
- Scope replaces the general test file with the focused suite; retain size 3. Estimate: roughly 20–40 changed lines in `we:scripts/guard-bash.mjs` plus 80–120 in `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs`, grounded in the normalization, replacement, expectation and admission-slot loci above. No implementation or test files are edited during preparation; the runner owns stamping.

## Design

Preserve the original executable target when a standards invocation cannot safely use the cwd-local alias. Keep the existing npm alias for the canonical relative invocation of `we:scripts/check-standards.mjs`; for an absolute or parent-relative script target, suggest the existing heavy-admission queue around the original node command, retaining Node options, quoted path, arguments and environment assignments. This avoids guessing another package root or changing cwd. Use the queue in the invoking WE checkout; the target script remains the supplied path.

Reuse `oneShotVitest` in `we:scripts/guard-bash.mjs:3580` for all Vitest execution suggestions, including implicit file mode and npm-forwarded related after workspace/prefix reconstruction. Implicit file runs gain `run`; related gains `--run` exactly once. Keep explicit run, non-execution subcommands, target filters, quoting and npm package selection intact. Update old related expectations rather than weakening them.

Complete a table of wrapper verdicts in `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs`: unqueued exec, env -i, stdbuf, nohup and npx -c heavy runs are denied; admitted foreground counterparts remain allowed where existing background rules permit. Direct tsx/bun standards spellings remain allowed by this classifier, recorded explicitly as a known detection boundary rather than silently expanding parser policy. Pair each with a harmless mention/inspection control. Existing recursion-budget refusals remain fail closed with their foreground-queue fallback.

## MVP

1. Add a `#5120` regression group in `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs`, with exact replacement strings and a nonempty suggestion assertion before checking re-admission.
2. Fix the two replacement branches in `we:scripts/guard-bash.mjs` using the existing normalizer and queue format. Preserve the local standards alias and existing full-suite refusal.
3. Update direct/npm-related expectation rows, including workspace, prefix and environment variants; extend the admission-slot guarantee to implicit modes. Reuse the existing wrapper matrix and include it in the focused acceptance group without deleting its earlier coverage.

## Acceptance

The following command is Q. The variables carry repository-qualified references; shell prefix removal resolves them relative to the WE checkout for execution. Each named test below is proposed within the focused suite.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
suite=we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs
node "${queue#we:}" run --wait-ms=1000 -- npx vitest run "${suite#we:}" -t '#5120'
```

- [A1] Executable — Q, test `#5120 standards replacement preserves target and wrapper verdicts`: the absolute out-of-cwd target and parent-relative target survive verbatim with Node flags, arguments and quoting; the canonical local alias stays unchanged. Include the explicit wrapper verdict matrix described above. The absolute-target assertion fails against the current replacement branch and passes after the fix.
- [A2] Executable — Q, test `#5120 implicit file replacement is one-shot and refuses raw runs`: direct implicit file runs produce an explicit `vitest run`, raw input is denied, at least one replacement is extracted, and every replacement passes `decide`. Include quoted filters and explicit-watch controls. The implicit-mode assertion fails before the fix.
- [A3] Executable — Q, test `#5120 related callers release admission slots`: direct and npm-forwarded related default-mode rows produce exactly one `--run`; workspace/prefix selectors and assignments survive; existing explicit `--run` rows remain stable. Require `admittedVitestWatchReason` to accept each suggestion, not merely absence of a watch token. The default-mode rows fail before the fix.
- [A4] Executable — Q, test `#5120 replacement safety retains fail-closed boundaries`: combine an implicit-mode positive replacement assertion with unqueued-heavy refusals, full-suite refusals without the existing escape, and bounded-wrapper fallback controls from the existing suite. Also assert harmless docs/config/data mentions do not become invocations. The positive assertion fails before the fix; negative controls must pass on both revisions and prevent loosening a refusal during the repair.

## Test plan

Implement A1–A4 first and run Q against the unchanged guard, capturing assertion failures rather than counting a missing test or empty selection as red evidence. Apply the implementation changes and rerun Q. Then run the same queued command without the name filter for the complete affected `we:scripts/__tests__/guard-bash-heavy-enforce.test.mjs` suite. This checks the old related expectations and wrapper/full-suite interactions together. Use only the host queue, with one bounded wait; if admission is unavailable, stop and report it.

## Proof plan

Attach the focused red/green output, test counts and complete affected-suite result. For A1, derive the absolute target from a temporary fixture under the task temporary directory (including a directory with spaces), not a workstation path. Parse the suggested queue child and compare executable, script path, flags and arguments with the denied input; do not launch a real standards run merely to test replacement text. For A2/A3, record exact replacements and both `decide` and `admittedVitestWatchReason` verdicts. For A4, record refusal/fallback assertions alongside the positive replacement. The runner owns standards checks and preparation stamps; preparation itself changes only this card.

## Follow-ups

Process-level admission enforcement remains separate from this bounded replacement/prevention work. Direct tsx/bun standards recognition is an explicitly documented limitation; expanding it requires its own scoped work rather than an incidental policy change here. No blockedBy changes are proposed.
