---
bornAs: x60xcy4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "b701f463d2111a777f9876514c58a60707560d27"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2927's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4297-catch-up-with-main-once-right-before-the-final-gate.md` — A formatting lint on backlog files that flags large shell blocks or excessive prose in the `Done when` section, enforcing that it contains only simple, repeatable commands.
2. `we:scripts/__tests__/conveyor-brief-main-catchup-policy.test.mjs` — A review lens or lint rule that flags review-process terminology ('round-1', 'convergence finding', 'earlier draft') in source code comments.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2927@2fb228a3ed4ecdc35936d6ffcfab4f8f6bb1fa0a

## Design

Deliver both prevention guards through existing extension points. The two originally named files are evidence fixtures, not the implementation homes. Keep the first guard advisory, matching the existing prose heuristics in `we:scripts/check-standards-rules.mjs`; use the already-permitted review-lens option for the second guard.

**Done-when formatting:** add a pure detector in `we:scripts/check-standards-rules.mjs` and invoke it from `lintBacklogItemRendering`, which is already consumed by the whole-repository and item-scoped standards checks. Inspect only `## Done when`, including its subsections, stopping at the next real level-two heading; headings inside fences must not end the section. Support backtick and tilde fences, CRLF, and indented list fences. Return findings with body-relative line numbers and distinct kinds for long shell blocks and excessive prose.

For this advisory heuristic, a shell fence (bash, sh, shell, zsh, or unlabelled) is long when it contains more than five nonblank, non-comment physical lines. Flag more than 80 prose words across the section after excluding fenced code, inline code, headings, and list/formatting markers. These are explicit detector thresholds, not claims that word count proves repeatability. Recommend moving setup, mutation instructions and delivery history to `## Proof plan` or `## Progress`, leaving short repeatable checks in `## Done when`. Emit warnings for both open and resolved cards so the original #4297 example remains detectable. Do not reject concise observable/assertable criteria or the documented doc-only exemption: the acceptance ladder in `we:docs/agent/backlog-workflow.md` explicitly permits them.

**Source-comment review:** add a simplicity entry to `LENS_HUNT_BRIEF` in `we:scripts/lib/review-core.mjs`. The existing `huntBriefForLens` → `buildPanelMandate` path supplies it to the simplicity reviewer without a new lens, scanner, or caller. Ask the reviewer to flag changed source comments that narrate the review process (examples: “round-1”, “convergence finding”, “earlier draft”) instead of explaining the current invariant. Require a cited comment and a suggested rewrite preserving its technical rationale. Treat these as non-blocking style findings under the existing prose-imprecision rule. Exclude strings, test input data, review-history documents and comments whose actual subject is the review algorithm; keyword presence alone is not a defect.

## MVP

1. **Must 1:** implement the section-bounded formatting detector and wire its two warning kinds into `lintBacklogItemRendering` in `we:scripts/check-standards-rules.mjs`.
2. **Must 2:** register the simplicity comment-history hunt brief in `we:scripts/lib/review-core.mjs`, preserving other lenses and existing mandate rules.
3. **Must 3:** add detector and public lint wiring cases to `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`; add generated-mandate cases to `we:scripts/lib/__tests__/review-core.test.mjs`.

Out: editing #4297 or its catch-up-policy assertions, rewriting historical comments across the repository, changing review severity or lens selection, introducing a hard prose gate, or building a source-language comment parser. The original examples are copied into inline test fixtures so later cleanup does not erase the regression evidence.

## Test plan

- **Capability — RED before implementation:** in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, reproduce #4297's long stash/run/restore shell block and prose in an inline fixture. Assert both findings and their line numbers through the detector and through `lintBacklogItemRendering`, including a resolved item. Missing exports alone are not the intended red proof: also show that the old public lint entry returns neither warning.
- **Capability — RED before implementation:** in the same test file, exercise exactly five versus six shell lines and exactly 80 versus 81 prose words; cover CRLF, tilde fences, indented fences, headings inside fences, and a subsection before the next level-two heading.
- **Preservation — passes on both implementations through the public lint entry:** short commands, concise observable/assertable criteria, doc-only exemption, and lengthy text or shell blocks under `## Proof plan` or `## Progress` produce neither new warning. Mutation proof: remove the section boundary or the code-exclusion logic and show the corresponding negative case fails.
- **Capability — RED before implementation:** in `we:scripts/lib/__tests__/review-core.test.mjs`, generate the real simplicity panel mandate and assert the comment-history instruction, the three example phrases, the requirement to preserve technical rationale, its non-blocking treatment and exclusions. Check the rendered mandate, not only the registry constant. Deleting the new registry entry or the existing brief-appending call must make the test fail.
- **Preservation — passes on both:** in `we:scripts/lib/__tests__/review-core.test.mjs`, retain claim-accuracy brief isolation and shared mutation/prose-imprecision rules; other lenses must not gain the simplicity brief. Mutation proof: append the simplicity brief to every lens or drop a shared rule and demonstrate the relevant assertion fails. Keep the existing correctness mandate golden unchanged.

## Proof plan

Run the two scoped suites through the existing heavy-admission runner. Record the new regression assertions failing on base behavior and passing after implementation, with the tests retained in both runs. Keep red/green and mutation setup here rather than in `## Done when`; do not use a stash recipe or `--passWithNoTests` as success evidence.

For the formatting guard, feed the frozen #4297 fixture through the real `lintBacklogItemRendering` entry and record the two warnings, then move its history to Progress and retain the short command to show both warnings disappear. The existing caller in `we:scripts/check-standards.mjs` already prints that entry's warnings; run the standards gate and inspect its output as well as its exit code, because warnings do not make the gate fail.

For the review guard, inspect the actual `buildPanelMandate` output for simplicity and the existing mandate-isolation test results. This proves the reviewer receives the instruction; it does not claim a deterministic guarantee that a model will identify every offending comment. No billed review or external PR action is required to prove prompt delivery.

## Done when

1. **Musts 1, 3:** the content-lint suite passes via the heavy-admission runner: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.
2. **Musts 2, 3:** the review-core suite passes via the same runner: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/review-core.test.mjs`.
3. **Musts 1–3:** `npm run check:standards` passes.

The `we:` tokens above identify the repository; strip them from executable arguments when running from the WE checkout root.

## Edge cases this change must handle

1. **Untrusted text:** card bodies are untrusted input to the detector; it only counts lines and words and never passes text to a shell, argv, path or regex built from it. Warning text must not echo body lines verbatim (cite line numbers only). Test: a body line with backticks and newlines does not alter the warning text.
2. **Truncated reads:** n/a: the detector is pure over the in-memory `body` string passed to `lintBacklogItemRendering`; it performs no `gh`/`git` read.
3. **Shared state files:** n/a: no state file is read or written.
4. **Fail closed:** a missing `## Done when` section, or an unterminated fence, yields no false warning and no throw; an unterminated fence is treated as running to end of section. Test both.
5. **Identity scoping:** n/a: findings key on the item `id` already passed in and are not stored.
6. **State over time:** n/a: stateless and recomputed each run; thresholds (5 shell lines, 80 prose words) are constants, tested at the boundary.
7. **Who wrote it:** n/a: no trust is granted from any comment, ref, label or job name; the review-lens text is instruction to a reviewer, not a trust signal.

## Follow-ups

No follow-up is required to deliver these guards. A corpus cleanup or promotion of a heuristic warning to a hard error would be separately scoped work, supported by measured false positives. Review-algorithm comments must remain distinguishable from incidental review narration.

## Progress

- **Premise checked during preparation:** the original scope listed `we:backlog/4297-catch-up-with-main-once-right-before-the-final-gate.md` and `we:scripts/__tests__/conveyor-brief-main-catchup-policy.test.mjs` as though those were the guard homes. Both still exist. The former's Done-when still contains the one-time stash procedure and extended explanation; the latter still has review-history comments at lines 36–38 and 67–69. No moved-file correction was needed, and neither example has been silently cleaned up.
- **Corrected scope:** those files supply regression evidence. Implementation belongs in `we:scripts/check-standards-rules.mjs`, matched by existing `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, and `we:scripts/lib/review-core.mjs`, matched by existing `we:scripts/lib/__tests__/review-core.test.mjs`. Both source/test pairs are now listed in scope. The existing standards caller requires no edit.
- **Corrected premise:** “only simple, repeatable commands” cannot mean banning all acceptance prose: the acceptance ladder in `we:docs/agent/backlog-workflow.md` explicitly permits observable and assertable criteria and a doc-only exemption. Preserve that contract while flagging oversized reproduction procedures and narration. `lintBacklogItemRendering` already carries warning-level prose checks; `LENS_HUNT_BRIEF` currently contains claim-accuracy only, and `buildPanelMandate` already appends registered briefs. These observed extension points support both owed guards without changing policy or building another review path.
- **Re-prepare 2026-10-09 (stamp had gone stale):** since base `dda3ff32`, `we:scripts/check-standards-rules.mjs` (+223 lines), `we:scripts/lib/review-core.mjs` (+11), and both test files changed, but a grep of both source files for a Done-when-section lint or a comment-history hunt brief finds none: the goal is still undelivered and `git log --grep` for `4471` shows only the card's own prepare/filing merges. Re-verified anchors: `lintBacklogItemRendering` is at `we:scripts/check-standards-rules.mjs:1220`; `LENS_HUNT_BRIEF` is at `we:scripts/lib/review-core.mjs:1933` (claim-accuracy only); `buildPanelMandate` at `:1107` appends `huntBriefForLens(lens)` at `:1130`. The #4297 example comments are still at `we:scripts/__tests__/conveyor-brief-main-catchup-policy.test.mjs:36` and `:67`. Design unchanged; added the now-required edge-cases section. Builder should re-read the current line numbers, since the files keep moving.
- **Delivery status:** inspection of the named examples, current lint helpers and hunt-brief registry found the prevention work still outstanding. This preparation changes only this card's body and scope; implementation, test execution, stamping and review remain with the subsequent delivery/runner steps.
