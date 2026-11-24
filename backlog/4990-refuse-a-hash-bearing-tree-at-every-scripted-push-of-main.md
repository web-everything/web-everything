---
bornAs: xk8rem0
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["4985"]
scope: ["we:scripts/push-if-green.mjs", "we:scripts/guard-git-push.mjs", "we:.githooks/pre-push", "we:scripts/lib/assert-numbered-push-tree.mjs", "we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs", "we:scripts/__tests__/push-if-green.test.mjs", "we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs", "we:scripts/__tests__/guard-git-push.test.mjs", "we:scripts/__tests__/guard-git-push-tree.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-11-24"
preparedAgainstSha: "b901e6ed47ede0fff4364d6ed916f2aab9d304b8"
tags: []
---

# Refuse a hash-bearing tree at every scripted push of main

Refuse a hash-named backlog file in the exact tip tree being published to main, including explicit `--sha` publication and sanctioned scripted pushes. Retain direct-filing numbering before validation. Authority: we:docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish. Ancestor hashes are allowed; raw admin bypass remains the accepted Rung 1 residual until #3532. This is local scripted-push enforcement, not server-side protection or the separate required PR check.

## Acceptance

Each named test below is to be added before implementation and must fail on the current implementation, then pass after. Existing compatibility assertions run alongside the new negative case in each group.

- [A1] **Executable** — `we:scripts/__tests__/push-if-green.test.mjs`, test “rejects hash-bearing exact source with assumed or explicit green”: both ordinary publication after a numbering no-op and `--sha` refuse, with no push call; the numbered counterpart reaches the push. Green gates and `--assume-green` cannot waive tree validation.
- [A2] **Executable** — `we:scripts/__tests__/push-if-green.test.mjs`, test “pins the checked source through publication”: check the post-numbering commit and push that SHA, even if the branch moves afterward; explicit SHA checks that commit even when HEAD differs. Hash-bearing ancestors of a numbered tip are accepted. `--dry-run` rejects a hash-bearing would-publish source without numbering or pushing.
- [A3] **Executable** — `we:scripts/__tests__/guard-git-push-tree.test.mjs`, test “sanctioned main update still rejects hashes”: run the actual hook with `MAIN_PUSH_OK=1`; hash-bearing main is refused and numbered main passes, including mixed POC/main ref updates and detached source refspecs. A POC-only push never invokes tree inspection; existing prototype and lease guards still apply.
- [A4] **Executable** — `we:scripts/__tests__/guard-git-push-tree.test.mjs`, test “unreadable publication evidence refuses”: unreadable stdin, malformed nonempty ref records, missing commit, failed/timed-out tree read, oversized output and incomplete NUL output refuse with a diagnostic and no publication. In `we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs`, test “tree evidence failures refuse” directly exercises missing commits, failed/timed-out reads, oversized output and incomplete NUL output; retain coverage through both CLI and hook adapters. Valid empty hook input remains a no-op; valid deletion records have no source tree to inspect and remain subject to the existing main/lease policy.
- [A5] **Executable** — `we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs`, test “numbering success must still prove the resulting tree”: numbering reports success but leaves a hash file and publication refuses; a real successful rename publishes the numbered tip. Existing numbering-error, non-WE and non-main controls retain their behavior.

- [A6] **Executable** — `we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs`, test “bounds and sanitizes refusal diagnostics for hostile paths and Git errors”: inject hash-bearing filenames and Git error messages containing ESC/ANSI sequences, CR, LF, TAB, DEL and C1 controls, including inputs exceeding the diagnostic limit. Assert each returned diagnostic is at most 2,048 UTF-8 bytes, contains no U+0000–U+001F or U+007F–U+009F characters, retains a recognizable refusal reason and recovery instruction, and marks truncation when needed. Every case remains a refusal. This test fails if sanitization or bounding is omitted.

## Design

Add the shared, injectable verifier in planned `we:scripts/lib/assert-numbered-push-tree.mjs`; test it directly in planned `we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs`, retaining adapter integration coverage in planned `we:scripts/__tests__/guard-git-push-tree.test.mjs`. Accept repository and resolved source commit; return a clean verdict or a structured refusal with offending paths or the evidence failure. Resolve commits with argument-safe Git calls; inspect committed paths with NUL-delimited recursive tree listing under the backlog directory. Reuse `idFromName` and `isHash` from `we:scripts/backlog/id.mjs:25-40`, stripping the Markdown extension before extracting the basename token. Inspect all kinds of backlog cards without reading frontmatter. Numbered filenames containing `bornAs` hashes are allowed. An absent backlog directory is clean only after a successful tree read.

Bound each Git read to 5 seconds and 8 MiB. A timeout, overflow, nonzero exit, malformed record or incomplete output is refusal, never an empty clean tree. Emit a control-character-sanitized diagnostic identifying the source and failure, capped at 2,048 UTF-8 bytes including a truncation marker when needed. Reserve space for the refusal reason and recovery instruction; remove C0, DEL and C1 controls from untrusted paths and Git errors before emission. The bound applies to the diagnostic body, excluding the CLI framing newline. Recovery is to number the source on a build lane, restore missing objects/read access, or have an operator investigate an oversized tree and deliberately revise the bound; rerun verification afterward. Do not suggest bypassing this invariant.

In `we:scripts/push-if-green.mjs`, preserve ordinary direct-filing numbering and its refusal behavior. After numbering, resolve the final source once, verify it, and use that immutable SHA in the refspec for both ordinary and explicit publication. Keep the existing gate and fast-forward checks. `--assume-green` bypasses only the green gate. A dry run validates its current candidate without invoking numbering. An up-to-date result performs no publication. Only destination main receives the new invariant; retain other branch behavior.

Extend `we:scripts/guard-git-push.mjs` rather than adding a second stdin consumer. Keep the existing pure lane-policy decision and lease protection; the CLI additionally parses complete four-field ref records and verifies every non-deletion main source SHA, even with `MAIN_PUSH_OK=1`. Do not change the pure `mainPushRefs` compatibility parser into the evidence validator. Reject malformed nonempty records because their destination cannot be trusted; valid non-main records do not trigger tree reads. Read failures must no longer turn into empty stdin. Fix payload capture in `we:.githooks/pre-push` so failed stdin capture exits nonzero before either guard; keep forwarding the same payload to the prototype guard.

This covers the sanctioned raw Git callers in `we:scripts/pr-land.mjs:795` and `we:scripts/merge-ai-prs.mjs:4646` and `we:scripts/merge-ai-prs.mjs:4673` through the installed hook. `we:scripts/lane-drain.mjs:1329` calls the checked CLI with `--assume-green`. Hooks-disabled or `--no-verify` admin pushes remain Rung 1 residuals, not a claimed guarantee. No new setting, config loader, numbering policy or history rewrite is introduced.

## MVP

Must: shared exact-tree verifier, immutable-source CLI wiring, main-scoped hook enforcement independent of the main override, fail-closed evidence handling, retained direct-filing numbering, and A1–A6 tests. Include hook capture failure and caller-shaped overrides in this delivery. Could: broader server enforcement and configurable bounds, deferred below. No runtime standard/API changes are involved.

## Test plan

Use hermetic temporary repositories under the task TMPDIR and injected Git runners; no real remote, fetch or push is required. Record publication attempts in a fake Git transport. Use the same hash-named/numbered fixture pair across CLI and hook tests, including a rename whose old hash remains in an ancestor. Hook subprocess tests must execute `we:.githooks/pre-push`, not merely call its decision helper. Simulate failed capture and ensure neither downstream guard runs. Existing tests in `we:scripts/__tests__/guard-git-push.test.mjs` retain override and pinned-lease behavior; add adapter-level tests showing the new independent tree veto. Update CLI Git stubs to return tree evidence explicitly rather than treating unknown commands as successful empty output.

For A6, feed deterministic hostile path and Git-error fixtures directly to the helper and assert the diagnostic UTF-8 byte length and forbidden-control regex, including oversized multibyte input. Assert the truncation marker, refusal status and retained recovery text independently so truncation cannot hide the operator fallback.

Run only the five scoped test files through the host heavy queue. Command notation: from the WE root, invoke `node` with `we:scripts/readiness/heavy-admission.mjs` (remove the `we:` locus when executing), arguments `run -- npx vitest run`, then the five scoped test paths with their locus prefixes removed. If busy, use one queue-owned wait, then report. The runner owns the standards/preparation checks.

## Proof plan

Builder records RED for each A1–A6 named test before implementing, then GREEN for the same tests and existing scoped controls. Capture exit status, refusal reason, selected tree SHA and fake transport log: rejected cases have zero push calls, accepted numbered cases carry exactly the checked SHA. For hook cases capture both guard results, including POC-only and mixed destinations. Compare the unchanged fixture pair with the separate backlog-id check when that sibling delivery exists; this card does not pretend that a missing required-check implementation already supplies a reusable detector. Preparation itself is source research only; no runtime success is claimed here.

## Edge cases

Empty/no-op input versus unreadable input; deletion zero SHAs; mixed destinations; detached source; clean HEAD with dirty selected SHA and the inverse; branch movement after validation; numbered tip with hash-bearing history; no backlog directory; numbering success with residual hashes; hostile filenames; truncated, oversized or timed-out evidence. A1–A6 cover these at the boundary that consumes the evidence.

## Follow-ups

- #3532 owns closing raw admin/hook-bypass residuals with the enforcement-rung knob.
- The separate required PR check and producer-numbering stories retain their own scope; do not remove direct-filing numbering here.
- Configurable tree-read bounds may be designed separately if observed repositories exceed the explicit limit. No automatic fallback to unchecked publication.

## Progress

- Preparation premise correction: the old scope named only `we:scripts/push-if-green.mjs`, `we:scripts/guard-git-push.mjs` and a broad test directory, implying a new hook beside the guard. The hook already exists at `we:.githooks/pre-push:14-16` and forwards one captured payload to two guards. It needs capture-error handling, not replacement.
- Source evidence: `we:scripts/push-if-green.mjs:195` excludes `--sha` from numbering; `we:scripts/push-if-green.mjs:208-210` publishes without a final tree check and uses a moving branch for ordinary publication. `we:scripts/guard-git-push.mjs:75` returns on the override; `we:scripts/guard-git-push.mjs:87` turns stdin read errors into empty input. The goal is not already delivered.
- Corrected scope adds the shared verifier, existing hook and exact matching tests. Size changes from 3 to 5: roughly 90 helper lines, 40 CLI lines, 55 guard lines, 5 hook lines, and 220 test lines across four files (~410 changed lines). This estimate follows the separate boundaries above, including immutable source selection and fail-closed capture, rather than treating numbering alone as sufficient.
- Existing dependency #4985 is resolved in its card and its resolver exists in `we:scripts/lib/backlog-id-settings.mjs:1-17`. No frontmatter edge was changed. No preparation stamp, implementation, commit, push or PR was performed.

- Validation repair: the previous scope assigned helper coverage only to the hook integration suite and omitted the matching helper test path. Add planned `we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs` to scope, Design and A4; retain all four adapter suites. Current source evidence still supports the original goal: `we:scripts/push-if-green.mjs:195-211` publishes after optional numbering without tree validation, and `we:scripts/guard-git-push.mjs:75-87` permits the override and swallows stdin read errors. The helper and its matching test are planned, not existing files. Size remains 5: redistribute the estimated 220 test lines across five files (about 60 helper, 60 CLI, 35 numbering, 20 existing guard and 45 hook integration lines); the approximately 410-line total and implementation scope are unchanged. No stamp or dependency edit made.

- Pre-review coverage repair: added A6 in the already-scoped `we:scripts/lib/__tests__/assert-numbered-push-tree.test.mjs` for hostile-path and Git-error diagnostics. Design now makes the existing bounded-output guarantee measurable (2,048 UTF-8 bytes, no C0/DEL/C1 controls, truncation marker and retained recovery instruction), with matching deterministic assertions in the Test plan. Scope and size remain unchanged.

## Proposed blockedBy changes

- remove 4985 — settings prerequisite is delivered; the resolver and built tip-tree default exist (we:scripts/lib/backlog-id-settings.mjs:1-17). Independent reviewer confirmation required.
