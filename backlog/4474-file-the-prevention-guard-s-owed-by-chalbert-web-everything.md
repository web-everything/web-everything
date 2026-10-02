---
bornAs: x0gr5d5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/lib/main-staleness.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/lib/__tests__/main-staleness.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-01"
preparedAgainstSha: "f561b1176c7abb4e2b982f1d41e7e76b7597ee88"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2916's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). Preserve the three owed guards: non-import security inputs on the review path, explicit decoy rejection, and consistent injected logging. The approval itself was not blocked by this debt.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2916@09fe9db61465beae917ef665f5df744c2ce1d6ba

## Progress

Preparation research found outstanding work, not an already-delivered goal.

- **Old premise/scope:** the original citations at we:scripts/operations/review-dispatch.mjs:405 and :415 implied missing coverage for settings/hooks and decoys; we:scripts/lib/main-staleness.mjs:215 requested a logger lint. Scope named the two implementation files and their existing test files.
- **Corrected premise:** the classifier is now at we:scripts/operations/review-dispatch.mjs:475, with the substring-based path expression at line 423. Existing import-coverage and unrelated-file tests are at we:scripts/operations/__tests__/review-dispatch.test.mjs:595. A direct Node import probe returned true for we:.claude/settings.json and we:scripts/bootstrap-session.mjs, false for we:scripts/guard-bash.mjs, false for the synthetic decoy we:preview-site.mjs, and true for the synthetic decoy we:scripts/lib/preview-site.mjs. Settings coverage alone is therefore not evidence that its command hooks are covered; the substring expression also accepts a decoy in a recognized directory.
- **Session-input correction:** we:scripts/operations/review-dispatch.mjs:592 creates a scratch session cwd and lines 609–610 inject its generated settings through the existing producers. we:scripts/lib/dispatch-bg-isolation.mjs:64 writes local settings in that cwd. Do not claim that every review launch loads we:.claude/settings.json directly. The tracked configuration's hook targets remain a conservative security-input inventory to protect, as requested by the original guard. Repository-local untracked settings and user settings cannot be inferred from a committed tree; tests must not read the preparer's personal settings.
- **Logger evidence:** we:scripts/lib/main-staleness.mjs:195 already provides an injected `write`, but lines 216 and 253 bypass it for non-code lag and successful fast-forward messages. The off-path case at line 225 uses it. Existing tests at we:scripts/lib/__tests__/main-staleness.test.mjs:248 exercise non-code lag without asserting injected output; the off-path test at line 255 does assert output.
- **Corrected scope:** retain the four existing scope entries. Add deterministic guards in the two matching test files and only the production corrections those guards expose. Read we:.claude/settings.json as fixture evidence without editing it. Limit logger enforcement to the function with the injected sink rather than introducing a repository-wide logging policy. No new dispatch mechanism, hook behavior, or staleness policy is needed. The runner owns checks, independent review, and stamping.

## Design

1. In we:scripts/operations/__tests__/review-dispatch.test.mjs, add an explicit inventory of tracked settings inputs and hook command targets. Read the tracked we:.claude/settings.json, walk every hook event/group, and extract the repository-relative target of its current `node` command form without executing commands. Compare the extracted targets to the declared inventory so additions/removals require an intentional update; fail with the command text on unsupported command forms rather than silently skipping them. Assert that each inventory path satisfies `isReviewCodePath`. Do not discover inputs from untracked we:.claude/settings.local.json. Pin representative local-settings classification with a synthetic path, and retain coverage of the generated-settings producers we:scripts/lib/gh-app-shim.mjs and we:scripts/lib/dispatch-bg-isolation.mjs through the existing sandbox roots.
2. Add missing inventory targets to the explicit review-path file set in we:scripts/operations/review-dispatch.mjs. Use the original card's deterministic inventory-test approach; do not broaden every repository file into the review path or compute the full entry-point import closure. Tighten the review/judge/jury filename match to token boundaries (start of basename or hyphen before the token; hyphen or extension after it). Keep the existing explicit files and sandbox closure behavior. Real review, judge, and jury entry names must remain covered.
3. In we:scripts/lib/main-staleness.mjs, route both bypass messages through `write`, preserving text, return values, and refusal/re-execution behavior. The default sink remains stderr.
4. Implement the owed narrow lint as a source-structure assertion in we:scripts/lib/__tests__/main-staleness.test.mjs using the already-declared TypeScript parser from we:package.json. Inspect the body of `assertMainNotStale` for direct `process.stderr.write` calls; reject them while allowing the default parameter initializer. This makes the rule executable in the existing test gate without a new global lint policy. Use small positive/negative source fixtures to prove the assertion catches a reintroduced call and ignores comments/string literals.

## MVP

- **Must 1:** A deterministic settings/hook inventory guard covers every command target in tracked we:.claude/settings.json and reports unsupported command forms; all inventory targets are on the review path.
- **Must 2:** Explicit decoy assertions reject synthetic we:preview-site.mjs, we:scripts/operations/preview-site.mjs, and we:scripts/lib/preview-site.mjs with a complete closure; existing positive/import-closure and incomplete-closure tests remain green.
- **Must 3:** Both logging bypasses use the injected sink, with behavioral assertions and a narrow source lint preventing their return.

Deliver as one bounded implementation change across the four scope files. No settings edits, external CLI launches, credentials, or new dependencies are required.

## Test plan

- we:scripts/operations/__tests__/review-dispatch.test.mjs: inventory equality, unsupported command rejection, positive classification for settings and all configured targets, decoy negatives, and the existing entry-import/sandbox-closure checks. Keep the unknown/incomplete closure fallback intentionally conservative; decoy rejection is asserted for a complete closure.
- In that same test file, extend the existing managed-clone fixtures with a commit touching a previously missed hook target. With no last-known-good fallback available, dispatch must refuse before spawning. An unrelated code change must continue to tolerate lag. This verifies the classifier is actually used at the dispatch boundary.
- we:scripts/lib/__tests__/main-staleness.test.mjs: inject a collecting `write` for non-code lag and successful fast-forward, spy on stderr, and assert the message reaches only the injected sink. Use an unrelated `codeRoot` for the fast-forward logging case to avoid triggering self-reexecution. Restore environment and spies. Retain the default-stderr behavior test and existing staleness/refusal cases.
- Add the narrow logger source lint and its mutation fixtures in we:scripts/lib/__tests__/main-staleness.test.mjs. Cover the default parameter allowance and direct calls inside nested body branches.

## Proof plan

The implementation worker runs the two scoped Vitest suites first with the new assertions against unchanged production code: record the missed hook target, nested decoy, and logger failures. Then apply the corrections and rerun those same suites. Record before/after results and named assertions; a passing classifier probe alone is not sufficient proof of dispatch behavior.

Commands are run from the WE checkout. For the focused run, pass we:scripts/operations/__tests__/review-dispatch.test.mjs and we:scripts/lib/__tests__/main-staleness.test.mjs to `npx vitest run` with their repository prefixes removed for shell arguments. Run `npm run check:standards` after implementation. Exercise the managed-clone test fixture, not a live paid review session. Preparation itself does not claim these future checks have passed.

## Done when

1. **Must 1:** The inventory and managed-clone hook-target tests fail on the pre-change classifier and pass after correction; existing off-path dispatch behavior remains covered.
2. **Must 2:** The explicit decoy table passes, including the nested preview names that currently return true, without losing the existing positive/import-closure coverage.
3. **Must 3:** Injected logging captures both formerly bypassed messages, the source lint rejects a reintroduced body call, and the default stderr sink remains supported.
4. Both focused suites and `npm run check:standards` pass, with proof recorded by the implementation worker.

## Follow-ups

No prerequisite policy decision remains. If tracked hook configuration gains a different command syntax, the inventory guard must fail visibly and be extended alongside that change. Host/user settings discovery and repository-wide logger enforcement are outside this bounded debt; do not imply this guard audits those inputs. Preserve the existing last-known-good fallback and the non-code filtering in we:scripts/lib/main-staleness.mjs:156; this item does not redefine which file extensions count as executable code.
