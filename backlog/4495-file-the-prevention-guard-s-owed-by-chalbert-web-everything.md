---
bornAs: x0eudv8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs", "we:scripts/__tests__/tests-first.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e2bed0a8c3b86ff61617d318f55efeda18ff5b21"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2949's independent review

Prevent unfinished acceptance criteria from passing `check:standards`. The approval review requested a hard guard against `TODO:` placeholders under `## Done when`, plus frontmatter validation. The latter must preserve today's canonical `kind` contract, not restore the retired `workItem` field.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2949@09d945ceed5c52787823562755d17505d37a4732

## Progress

- Original premise: the approval findings cited unfinished criteria on #4492/#4493 and requested mandatory `workItem` with rejection of `kind`. Earlier preparation corrected this to a literal acceptance-placeholder guard plus preservation of canonical `kind`, scoped to one rules module and three test files.
- Rechecked 2026-11-18: both cited cards are now resolved; neither contains the original placeholder. They are historical evidence, not implementation targets. The required-field loop and membership check at `we:scripts/check-standards-rules.mjs:505` and `we:scripts/check-standards-rules.mjs:516` already enforce `kind`. Reintroducing `workItem` would regress that contract.
- Corrected current premise: the old scanner citation at line 1187 has moved to `we:scripts/check-standards-rules.mjs:1352`. It matches only the scaffold phrase, strips inline spans, and returns a boolean. The claim-gated rule remains at `we:scripts/check-standards-rules.mjs:1453`; a newer prepared-open, policy-gated rule at `we:scripts/check-standards-rules.mjs:1447` also uses the scanner. Neither implements unconditional literal-token rejection. This is source evidence, not a claim of a newly executed runtime probe.
- Corrected scope: retain the rules module and three existing test files; add `we:scripts/__tests__/tests-first.test.mjs`. Its exemption assertions at lines 16–18 and policy-disabled assertion at line 64 would conflict with the new unconditional guard. Update those assertions explicitly while retaining tests of the narrower policy diagnostic. The #4738 tests at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:944` filter their own diagnostic and must continue to prove its original semantics.
- Callers already propagate shared errors: `we:scripts/check-backlog-item.mjs:100` and `we:scripts/check-standards.mjs:985`. No caller production edit is needed. The CLI fixture isolation is implemented at `we:scripts/__tests__/check-backlog-item.test.mjs:39` and `we:scripts/__tests__/check-backlog-item.test.mjs:59`.
- Size remains 3: approximately 50 changed lines in the rules module, 100 in content-lint coverage, 30 in kind-axis coverage, 40 in CLI coverage, and 25 in tests-first compatibility assertions (about 245 lines across five files). This is a story; no `estimatedLoc` is added. Existing preparation stamps are left for the runner to refresh.

## Design

Factor the fence-aware section walk in `we:scripts/check-standards-rules.mjs:1352` into reusable scanning logic. Keep the existing claim and policy diagnostics and their predicates intact. Add a separate unconditional hard diagnostic for case-sensitive literal `TODO:` in acceptance prose, including inline code spans. Use the shared heading predicate from `we:scripts/backlog/task-agreement.mjs:29`, covering both Acceptance and Done when. Continue through subordinate headings to the next level-two heading or EOF; a level-one heading does not terminate the section. Heading lines themselves are not criteria. Ignore backtick and tilde fenced examples and heading-like text inside them; fence closing must match character and minimum opening length. Preserve the old scanner's case-insensitive scaffold matching and inline-span stripping for its existing consumers.

The new error applies to every kind and status, with or without a preparation stamp, proof claim, or enabled executable-acceptance policy. The policy still controls its existing diagnostic; it cannot exempt this independently requested content-validity rule. Return one diagnostic containing the item id and unique one-based body line numbers, plus an instruction to replace placeholders with concrete acceptance criteria. Do not echo the offending prose.

Before other body detectors run, reject any non-string body with a clear incomplete-evidence error and return normally. An empty string is valid input with no acceptance section. This is an input-type boundary, not a new filesystem-read or markdown-parser guarantee. Keep existing canonical frontmatter validation unchanged.

## MVP

1. Implement the shared scan, unconditional diagnostic, and non-string refusal in `we:scripts/check-standards-rules.mjs`.
2. Add content-lint and canonical-kind regression cases in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` and `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`.
3. Add bad/good acceptance fixtures in `we:scripts/__tests__/check-backlog-item.test.mjs`; update the changed exemption expectations in `we:scripts/__tests__/tests-first.test.mjs`. Preserve the policy-specific and #4738 diagnostics rather than weakening their assertions.

## Test plan

Name the new content-lint describe group `4495 unconditional acceptance validity`. Cover both accepted heading names; all canonical kinds and statuses; prepared and unprepared cards; absent claims; ordinary and inline-code literal tokens; multiple hits and sections; subordinate headings; EOF; and exact id/line diagnostics without reflected body text. Negative cases cover valid criteria, lowercase token spelling, tokens outside the section, both fence types, longer opening fences, fenced fake opening/closing headings, and empty body. Reject null, undefined, object, and numeric bodies without throwing. Keep examples isolated from the live corpus.

Name the kind-axis regression `4495 canonical kind remains required`; assert a valid story without the retired field passes, and missing/unknown kind or the retired field alone fails. These are preservation assertions, already green on the base; do not misrepresent them as missing functionality.

Name the CLI group `4495 acceptance diagnostic reaches CLI`; use the existing temporary backlog helper to compare identical bad/good cards, assert exit 1/0 and the new diagnostic, and keep the real-backlog immutability assertions. Name the tests-first group `4495 unconditional validity survives policy exemptions`; assert new errors for unprepared/resolved and policy-disabled cards, while the old policy diagnostic remains conditional and concrete criteria pass.

For mutation checks, remove the new guard (capability cases fail), remove type refusal (non-string cases fail), break fence/boundary tracking (preservation cases fail), and remove required-kind or membership enforcement (kind cases fail). Restore each mutation before proceeding. No new size bound, network dependency, or state file is introduced.

## Acceptance

Paths below use repository-locus notation. For runnable commands, set shell variables to strip the notation: `admission=we:scripts/readiness/heavy-admission.mjs` and `suite=we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, then run `node "${admission#we:}" run --wait-ms=60000 -- npx vitest run "${suite#we:}"`. Substitute the explicitly named suite for each entry. Every new capability test is expected to fail on the base and pass after implementation; preservation subcases pass on both.

- [A1] **Executable** — Run `4495 unconditional acceptance validity` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` using the queued command above. It proves unconditional literal-token rejection, inline spans, item/line-only diagnostics, boundaries and fence exclusions. The rejection assertions fail before the build; boundary controls remain green.
- [A2] **Executable** — In the same queued suite, run the named non-string and empty-body cases within `4495 unconditional acceptance validity`. Non-string input must return a refusal diagnostic without throwing; empty string remains accepted. The refusal assertions fail before the build.
- [A3] **Executable** — Run `4495 unconditional validity survives policy exemptions` in `we:scripts/__tests__/tests-first.test.mjs` through the queued command. New unconditional rejection assertions fail before and pass after for unprepared, resolved, and policy-disabled inputs; existing conditional-diagnostic assertions remain green.
- [A4] **Executable** — Run `4495 acceptance diagnostic reaches CLI` in `we:scripts/__tests__/check-backlog-item.test.mjs` through the queued command. The bad-fixture exit/diagnostic assertions fail before and pass after; the good fixture exits zero and the live backlog remains untouched.
- [A5] **Executable** — Run the content-lint capability group together with `4495 canonical kind remains required` in `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`, passing both suite paths through the queued command. This combined guard-and-schema acceptance run fails before on the new content rule and passes after; canonical-kind assertions are explicitly preservation checks, and the required-field/membership mutations must make them fail.

## Proof plan

Use only the host heavy-admission queue for test execution. Run the five scoped test files, record named capability failures against the base and passes after the implementation, and record preservation and mutation results separately. If admission is busy, wait once using its own 60000ms wait budget, then stop and report; do not poll. Scratch fixtures belong under the task's `$TMPDIR`.

After implementation, run `node "${admission#we:}" run --wait-ms=60000 -- npm run check:standards -- --item 4495` and the same queued command without the item flag for the full gate. The shared full-gate propagation is visible at `we:scripts/check-standards.mjs:985`; record its actual output, not merely the single-item result. The CLI tests supply the isolated negative/positive control without editing real cards.

Inventory hits over `we:backlog/*.md` with the implemented scanner before claiming full-gate success. Earlier preparation's approximate ten-card inventory is stale and must not be treated as current evidence. Record exact offending ids, statuses, and body lines. Existing substantive acceptance debt requires separate preparation; do not delete placeholders mechanically, invent commands for unrelated goals, exempt resolved cards, or describe a failing gate as green. Any remaining corpus blockers prevent a completion claim, even if targeted tests pass.

## Follow-ups

Prepare existing cards exposed by the corpus inventory separately, preserving their goals. The scaffold at `we:scripts/backlog/task-agreement.mjs:57` deliberately emits unfinished criteria; this guard makes those criteria invalid until authored and does not change scaffold generation. Broader placeholder vocabulary, case folding, Unicode normalization/invisible-character detection, arbitrary frontmatter allowlisting, and file-read failure handling are outside this literal-token and canonical-kind scope. No dependency-edge change is proposed by this preparation.
