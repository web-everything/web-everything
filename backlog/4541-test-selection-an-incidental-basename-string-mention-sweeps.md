---
bornAs: xaani98
kind: task
status: open
scope: ["we:scripts/readiness/test-selection.mjs", "we:scripts/readiness/__tests__/test-selection-local.test.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/conveyor/__tests__/run-rating.test.mjs"]
estimatedLoc: 260
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e2bed0a8c3b86ff61617d318f55efeda18ff5b21"
tags: []
---

# test-selection: an incidental basename-string mention sweeps an unrelated test into the diff-driven gate

Split from #4538. Keep the local diff-driven gate from selecting a test solely because an explicitly identified example mentions a changed filename. Preserve actual import, subprocess, file-read, and directory-discovery coverage. CI remains authoritative and independent of this local supplement.

## Progress

- Original premise/scope: both needle generation and matching were attributed to we:scripts/readiness/test-selection.mjs, the only scoped file; no matching tests or line estimate were declared.
- Corrected premise: we:scripts/readiness/test-selection.mjs:450 generates basename/root needles, but `testsNaming` in we:scripts/lib/verify-lane-gate.mjs:773 runs whole-file fixed-string grep. Its caller at we:scripts/lib/verify-lane-gate.mjs:501 unions hits with graph inputs. The incidental command remains at we:scripts/conveyor/__tests__/run-rating.test.mjs:142. The goal is not already delivered.
- Import-only matching is demonstrably too narrow: we:scripts/readiness/test-selection.mjs:367 and :442 explicitly supplement subprocess/file-read edges, and we:scripts/readiness/__tests__/test-selection-local.test.mjs:53 pins directory-root discovery. Use the original card's permitted occurrence-level escape instead of replacing this coverage model with an incomplete import recognizer.
- Corrected scope adds the actual matcher/caller, its existing wiring suite, the needle suite, and the offending example test. Existing wiring fixtures at we:scripts/lib/__tests__/verify-lane-gate.test.mjs:28 simulate grep results without source contents; update them explicitly to supply content for filtering.
- Current local defaults differ from the original full-suite fallback description: `relatedMode` defaults to `all` at we:scripts/lib/verify-settings.mjs:7; broad selections are blocked at we:scripts/lib/verify-lane-gate.mjs:489. Preserve that behavior. CI unit selection comes from its shard inventory at we:.github/workflows/ci.yml:296, not this local reference matcher.
- Estimate added (previously absent): 260 changed lines = approximately 70 in we:scripts/readiness/test-selection.mjs (pure occurrence filter and documented annotation contract), 80 in we:scripts/readiness/__tests__/test-selection-local.test.mjs, 35 in we:scripts/lib/verify-lane-gate.mjs (source reader, filtering, error handling), 74 in we:scripts/lib/__tests__/verify-lane-gate.test.mjs (fixtures and wiring), and 1 annotation in we:scripts/conveyor/__tests__/run-rating.test.mjs. No size change or dependency change is proposed.

## Design

Use a narrow, explicitly authored escape: a standalone line comment immediately before an incidental occurrence, with syntax `// @test-incidental-reference <needle> -- <nonempty reason>`. This is an assertion by the test author that the next physical line's single occurrence of that exact needle is example data, not coverage. Document the contract beside the pure helper in we:scripts/readiness/test-selection.mjs. It is not a whole-file exclusion and is not permission to annotate an actual dependency.

The pure helper receives source text and needles, and reports whether any unsuppressed fixed-string occurrence remains. Match annotations only as actual standalone line-comment tokens (use the existing TypeScript scanner dependency, not a regex that mistakes template/string contents for directives). An annotation is valid only for a nonempty requested needle, a nonempty reason, and exactly one occurrence of that needle on the immediately following physical line. Remove only that occurrence and the valid directive's own text from consideration for that needle. Do not suppress other needles on either line. Malformed, dangling, repeated/ambiguous occurrences, or tokenization errors retain the original conservative match. A second unannotated occurrence anywhere in the file retains selection, including an import, dynamic import, mock specifier, subprocess invocation, file read, or directory name. Do not reinterpret string contents as syntax or infer intent from command wording.

Keep `referencedTestNeedles` unchanged apart from documentation. In `testsNaming`, retain grep as the candidate prefilter and apply the helper to each candidate's working-tree contents, using an injectable reader with a production filesystem default rooted consistently with the gate's repository. Reuse the existing `readRepoFile` injection at `resolveDefaultGate`; callers without it must still perform filtering rather than silently retain the old behavior. Preserve sorted/deduplicated targets and the existing test suffix set.

Unreadable candidate contents or lexical uncertainty retain that candidate: an opt-out needs complete evidence. Distinguish grep exit status 1 (no matches) from other failures. Other grep failures propagate into an explicit blocked decision with no command and an operator-visible reason directing the caller to repair discovery or supply an explicit affected-test gate. Never treat incomplete discovery as an empty successful result or start a full local suite as fallback. Preserve existing target-count/command-size bounds and their explicit-gate fallback.

Annotate only the example at we:scripts/conveyor/__tests__/run-rating.test.mjs:142 with the exact generated basename needle. Do not suppress that test globally. Static graph inputs, the default `all` mode, `import-only` bypass, explicit opt-out handling, standards checks, and CI configuration retain their current meanings.

## MVP

Must: implement and document the occurrence escape, wire candidate-source filtering into the default local caller, annotate the reported false positive, and add pure plus caller-level regression cases. Include malformed evidence and discovery failure behavior. No new setting, global exclusion list, test filename special case, or CI change.

Could: automatic semantic classification of arbitrary examples. That is outside this repair because the existing supplement intentionally covers non-import relationships and this card already permits an explicit escape.

## Acceptance

Each named regression below is to be added before implementation and run against the old code to record red, then against the build to record green. Names beginning `4541` form the focused acceptance selection; retained-behavior assertions accompany the newly failing assertion in each case.

- [A1] **Executable** — `4541 suppresses only the annotated incidental occurrence` in we:scripts/readiness/__tests__/test-selection-local.test.mjs: an annotated example alone stops matching; a sibling true import still matches; a mixed file retains its real dependency and drops only the separately annotated unrelated needle; a real string-valued dynamic import remains selected. Run command P below.
- [A2] **Executable** — `4541 annotations fail closed and cannot originate inside strings` in we:scripts/readiness/__tests__/test-selection-local.test.mjs: valid suppression is the positive control; missing reason, unknown needle, dangling directive, multiple next-line occurrences, lexical failure, and directive-like text inside a multiline template all retain matches. Real subprocess/read/root references remain untouched. Run P.
- [A3] **Executable** — `4541 default gate filters candidate contents` in we:scripts/lib/__tests__/verify-lane-gate.test.mjs: with default settings and production-equivalent source reading, an annotated example fixture disappears from `referencedTests` and targets while an importing sibling remains; an unannotated candidate still matches. Assert the resulting command, and repeat with injected reading. Assert `import-only` never calls reference discovery, graph inputs remain, and broad selection still blocks. Run W below.
- [A4] **Executable** — `4541 incomplete discovery cannot silently shrink` in we:scripts/lib/__tests__/verify-lane-gate.test.mjs: contrast valid suppression with an unreadable candidate retained; grep status 1 gives no candidates, while status 2 or unknown errors produce blocked/no-command with the explicit-gate remedy. Include an oversized candidate/target set retaining the existing bounds and fallback. Run W.
- [A5] **Executable** — `4541 run-rating example is explicitly incidental` in we:scripts/lib/__tests__/verify-lane-gate.test.mjs: load the actual we:scripts/conveyor/__tests__/run-rating.test.mjs contents through the candidate filter and assert it is excluded for the needle generated from we:scripts/verify-lane.mjs. Pair with a genuine import fixture and assert it stays selected. This fails on the unannotated source. Assert CI's unit workflow does not call this local selector. Run W.

## Test plan

Commands P and W use the queue-backed npm script in we:package.json:31. The shell expansion strips the documentation's repository prefix to produce runnable repository-relative arguments.

- P: `npm run test:unit -- "$(p=we:scripts/readiness/__tests__/test-selection-local.test.mjs; printf '%s' "${p#we:}")"`
- W: `npm run test:unit -- "$(p=we:scripts/lib/__tests__/verify-lane-gate.test.mjs; printf '%s' "${p#we:}")"`

Run these affected suites only, including their existing tests, so changed fixtures cannot silently weaken old default/graph/standards assertions. Fixture source bodies must contain the references their mocked grep outputs claim. Give no-match mock errors numeric status 1, and use distinct status-2/unknown fixtures for failure coverage. Use task temporary storage for filesystem fixtures, with cleanup; no repository-wide test execution or real host lane scanning.

## Proof plan

Before implementation, add A1–A5 and capture their expected assertion failures through P/W. After implementation, capture both suites green and the caller's returned target list/command for the example-versus-import fixture. Use actual source in A5 to connect the synthetic wiring proof to the reported case; do not execute the entire run-rating suite merely to verify text selection. Confirm the final diff touches only the declared implementation/test set, leaves CI configuration unchanged, and does not alter the local settings defaults. The preparation runner owns preparation checks and stamps; this preparation itself changes only this card.

## Follow-ups

Automatic reference classification remains a possible later improvement, contingent on a corpus of subprocess, file-read, dynamic-import and directory-discovery edges proving it is not lossy. Basename collisions and unannotated incidental mentions remain conservative false positives under this MVP. No whole-file opt-out or CI shrink is introduced, and no follow-up blocks this bounded repair.
