---
bornAs: xf3tgxh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-backlog-submissions.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs", "we:scripts/audit-backlog-health.mjs", "we:scripts/__tests__/audit-backlog-health.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "ad6d1a241477f1390da2008204b1ddbfd7fe4c16"
tags: []
---

# Prevention — reject uncodified decision resolutions and unfinished backlog submissions

Filed mechanically on approval of chalbert/web-everything#3229. Preserve the three prevention goals: catch direct-edit decision resolutions without codification in `check:standards`; make the literal unfinished acceptance placeholder a hard A1 failure; reject unmodified submission boilerplate in new stories.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3229@8fc41e30e1645e2e012804afba147899419b6c15

## Progress

Rechecked in the acquired checkout on 2026-11-19. The old preparation claimed no submission-placeholder guard existed and proposed fresh Git candidate discovery. Corrected premise: partial guards now exist, but the three prevention goals are not fully delivered. Preserve size 3: three implementation files plus five test files, approximately 100 lines of rule work, 100 of CLI integration, 40 of audit changes and 250 of regression coverage. Add the existing content-lint suite to scope because it owns the overlapping guard; the submission CLI suite remains a planned new file. No implementation or stamping is performed in this preparation.

- `we:scripts/check-standards-rules.mjs:1352` already has a fence-aware acceptance detector. At lines 1447–1457 the prepared-card policy guard and mutation-proof guard consume it. The previous “no placeholder rule” claim is stale: neither covers every changed open executable card independently of preparation, policy setting, or proof claims.
- `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:984` pins placeholder-only silence for the existing rendering guard; preserve that caller contract while adding submission-specific enforcement. The scaffold now comes from `we:scripts/backlog/task-agreement.mjs:57`, through `we:scripts/backlog/scaffold.mjs:164`; `## Acceptance` is canonical and `## Done when` is an alias.
- `we:scripts/check-standards.mjs:1049` already uses `localChangedSet` from `we:scripts/lib/verify-lane-gate.mjs:576`. It includes tracked working-tree changes and untracked files but returns no added-file classification. Reuse its candidate set; derive baseline existence separately, rather than changing this shared helper's callers.
- `we:scripts/audit-backlog-health.mjs:281` accepts a token or exemption before diagnosing unfinished acceptance; lines 548–551 limit A1 to open executable kinds. Lines 620–640 scope findings, falling back to whole-backlog when claims cannot be read. Lines 685–690 write output without setting a failure exit code. Its root/report paths are module-relative (lines 94–96), not configurable output flags: CLI proof requires an isolated fixture checkout.
- `we:package.json:81` exposes the audit as `check:health`. `we:scripts/__tests__/audit-backlog-health.test.mjs:80` tests the current candidate-only reasons. Preserve those reasons and exit behavior except for the new literal-placeholder reason.
- `we:scripts/backlog/frontmatter.mjs:174` already validates codification for resolve operations. Direct editing still needs the submission backstop. Authority: `we:docs/agent/platform-decisions.md#promotion-discipline-enforced`.
- Original symptoms remain: `we:backlog/4673-model-routing-strategy.md:3` is a resolved decision without codification; `we:backlog/4679-routing-pilot-one-capped-hosted-open-weight-trial.md:18` and `we:backlog/4681-routing-pilot-stage-0-join-every-model-call-to-its-card-step.md:18` contain the placeholder and line 20 contains the unchanged hint. These are evidence, not remediation targets.

## Design

Add pure submission validation in `we:scripts/check-standards-rules.mjs` taking raw frontmatter, body and added/modified classification. Return diagnostics with the offending file and stable rule identity. For added or modified resolved decisions, reject missing, null, empty, whitespace-only or non-string codification. Accept `one-off` and use the existing codification validator for string pointers; do not invent a second pointer syntax.

Share the existing fence-aware acceptance detector between the submission rule and health audit. For changed open executable kinds, the literal scaffold unfinished-command phrase inside any supported acceptance heading is an error, regardless of prepared state, proof claims, executable tokens or exemptions. Inspect all acceptance sections before allowing an exemption. Preserve the existing rendering guard's caller behavior. For added stories additionally reject the exact standalone `GUARD_RELAXATION_HINT` outside fences. Fenced examples, inline-code quotations, discussions outside acceptance and arbitrary TODO prose remain outside the literal acceptance detector. Draft scaffold production remains unchanged.

Wire the rule in `we:scripts/check-standards.mjs` using the existing changed-file selector, excluding deleted files and intersecting with explicit local files before linked expansion. Classify an existing candidate as added only when absent from the same merge-base tree; staged additions must remain added. Use bounded Git output and argument arrays, respecting existing path decoding. Missing base, Git failure (including output overflow), unreadable candidate or malformed frontmatter must block with a visible diagnostic, including under local partitioning. Tell the operator to restore comparison history or repair the named input and rerun; no success fallback. Historical unchanged and linked-only cards are not submissions.

In `we:scripts/audit-backlog-health.mjs`, emit a distinct A1 reason for the literal placeholder before token/exemption checks. After normal report/JSON output and session filtering, set nonzero exit status if that reason remains. Preserve the current whole-backlog fallback for missing/unreadable claims. Other A1 reasons and G6 remain candidate findings. This deliberately changes the default `check:health` exit behavior for this concrete defect, without making all audit debt blocking.

## MVP

1. Extract/reuse the acceptance detector and add submission validation in `we:scripts/check-standards-rules.mjs`; cover the rule in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` and caller compatibility in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.
2. Wire changed-card selection and file-attributable failures in `we:scripts/check-standards.mjs`. Add `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs` with disposable Git fixtures and actual CLI assertions; retain existing validator coverage in `we:scripts/__tests__/check-standards.test.mjs`.
3. Add the distinct reason and post-report failure in `we:scripts/audit-backlog-health.mjs`, covered by `we:scripts/__tests__/audit-backlog-health.test.mjs`. Exercise its real CLI from a fixture checkout so module-relative report writes cannot touch production output.

## Test plan

Use the following named regression groups, each containing a new failing-before/passing-after assertion plus its compatibility controls:

- “submission codification”: added/modified resolved decisions with absent/null/blank/non-string/invalid pointers fail; valid pointers and `one-off` pass; unresolved decisions and resolved stories remain unaffected.
- “submission unfinished acceptance”: unprepared and prepared open executable cards fail with literal placeholder alone, alongside a command or exemption, and in a later acceptance section; all supported headings and subordinate headings work. Completed criteria, fenced examples and quoted discussion pass. Pin existing rendering-only behavior and scaffold output without weakening historical assertions.
- “new story boilerplate”: exact hint fails only for added stories, including staged additions; completed stories, modified historical hints and fenced examples pass.
- “submission CLI selection and refusal”: committed, staged, unstaged and untracked changes; deletions; unchanged legacy and linked-only cards; explicit local restriction; malformed/unreadable card; missing base, failed enumeration, failed baseline classification and bounded-output overflow. Failure diagnostics survive local partitioning, identify evidence to repair, and clear after correction.
- “health placeholder exit”: real CLI emits report and JSON and fails for the distinct reason; correcting only the placeholder clears it. Test selected-session inclusion/exclusion, unreadable/missing claims fallback, multiple acceptance sections, and ordinary A1/G6 findings retaining zero exit status. Use the production `check:health` entry-point behavior, not only an injected consumer result.

## Acceptance

- [A1] **Executable** — “submission codification” in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` and its actual CLI case in `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs` fail before implementation and pass after: direct-edit uncodified resolutions are refused with file attribution.
- [A2] **Executable** — “submission unfinished acceptance” in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`, with compatibility cases in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, fails before and passes after: changed open executable cards cannot mask the placeholder with preparation state, policy, commands or exemptions; existing rendering callers and completed/quoted examples retain their behavior.
- [A3] **Executable** — “new story boilerplate” in `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs` fails before and passes after: new stories retaining the exact hint fail, including after staging, while draft generation remains usable.
- [A4] **Executable** — “submission CLI selection and refusal” in `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs` fails before and passes after: normal/local CLI selection catches actual changes, excludes historical/linked-only/deleted cards, and blocks incomplete evidence or oversized Git output with the repair-and-rerun fallback visible.
- [A5] **Executable** — “health placeholder exit” in `we:scripts/__tests__/audit-backlog-health.test.mjs` fails before and passes after: the default health CLI reports then exits nonzero for the literal-placeholder reason, respects session scope and whole-backlog fallback, and preserves other candidate-only reasons and output formats.

## Proof plan

Run only the five scoped suites through the host heavy-run queue. Invoke the runner at `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` followed by the WE-relative forms of the five test paths in scope. Commands use ordinary relative paths at execution; the repository prefixes here identify their locus.

Tests must capture stdout, stderr and exit status from the actual standards and health producers in isolated fixture checkouts rooted under the task's TMPDIR. Seed each defect, record failure, correct only that defect and record the cleared diagnostic. Include an unchanged legacy defect to prove the submission boundary, and preserve ordinary audit findings to prove the changed exit default is narrow. Run `npm run check:standards` only through the same heavy-admission runner; distinguish unrelated baseline findings. If busy, wait once using its supported wait option, then stop and report. Preparation asserts source observations only; it does not claim these future regressions pass.

## Follow-ups

Existing G6 and A1 debt needs separate card-specific remediation. Do not bulk-add `one-off`, manufacture acceptance commands, broaden the placeholder vocabulary, alter queue eligibility or change shared candidate-selection defaults. Broader quality judgments remain outside this item. No blockedBy changes are proposed.
