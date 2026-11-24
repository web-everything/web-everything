---
bornAs: xk8rem0
kind: story
size: 3
parent: "3383"
status: open
blockedBy: ["4985"]
scope: ["we:scripts/push-if-green.mjs", "we:scripts/guard-git-push.mjs", "we:.githooks/pre-push", "we:scripts/lib/check-main-backlog-tree.mjs", "we:scripts/__tests__/push-if-green*.test.mjs", "we:scripts/__tests__/guard-git-push*.test.mjs", "we:scripts/lib/__tests__/check-main-backlog-tree*.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-11-24"
preparedAgainstSha: "faa92e3aabd32d45ec9ab4ea2c6b146118b01d9c"
tags: []
---

# Refuse a hash-bearing tree at every scripted push of main

Enforce the outgoing main tip-tree invariant from we:docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish at publication, including explicit `--sha` publication. Retain direct-filing numbering, then verify its result. The raw admin push and hook bypass remain accepted Rung 1 residuals until #3532; this is local enforcement, not server-side protection or a history rewrite.

## Done when

Acceptance tests below are planned, not reported as passing. Each named regression must fail before implementation and pass after; paired positive controls preserve existing permitted behavior.

- [A1] **Executable** — `we:scripts/__tests__/push-if-green-hash-tree.test.mjs`, test “checks the final numbered tip before publishing”: numbering that reports success but leaves a hash path refuses with no push; the identical fixture renamed to a numbered path publishes. Exercise default gate, explicit gate and `--assume-green`; none bypasses this check.
- [A2] **Executable** — same file, test “checks and publishes the exact selected SHA”: a hash-bearing ancestor selected with `--sha` refuses even with a clean HEAD; a clean selected ancestor with a hash-bearing HEAD passes this invariant. Neither case runs numbering. A moving branch after validation cannot substitute an unchecked tip.
- [A3] **Executable** — `we:scripts/__tests__/guard-git-push-hash-tree.test.mjs`, test “hook guards sanctioned main pushes and preserves other refs”: invoke the actual hook with `MAIN_PUSH_OK=1`; hash-bearing main fails, numbered main passes, mixed main/POC payload fails on main, and POC-only payload never invokes the tree reader. Cover the sanctioned caller refspecs from we:scripts/pr-land.mjs and we:scripts/lane-drain.mjs's publisher. Preserve the separate prototype-tracker guard.
- [A4] **Executable** — same guard test file, test “incomplete evidence refuses publication”: unreadable stdin, malformed nonempty ref records, missing source objects, failed tree enumeration, timeout and output overflow all refuse with actionable diagnostics. The publisher test file applies the same tree-read failures and asserts zero push calls. A simulated hook payload capture failure also refuses.
- [A5] **Executable** — same publisher test file, test “tip-tree default checks every hash carrier without scanning ancestors”: hash paths of different card kinds and carriers all fail, while a clean tip with historical hash paths and a repository with no backlog pass. `--dry-run` refuses a hash-bearing selected main tree without numbering or pushing; existing wrong-branch, up-to-date and fast-forward guards remain intact.

## Design

Add the shared, read-only helper we:scripts/lib/check-main-backlog-tree.mjs, exercised directly in we:scripts/lib/__tests__/check-main-backlog-tree.test.mjs and through both new entrypoint test files. It accepts repository cwd and an immutable commit OID plus injectable Git execution. Resolve/verify the commit, enumerate its complete tip tree with NUL-delimited Git output, and classify backlog basenames using the existing temporary-ID grammar (`x` plus six lowercase alphanumeric characters followed by a hyphen). Do not inspect the checkout or index as evidence of the published tree, filter by card metadata, or walk commit history. A complete empty backlog is valid; an unsuccessful read is not an empty backlog. Bound Git execution to 5 seconds and 16 MiB output; timeout/overflow refuses, naming the bound and advising inspection/reduction of the tree or an explicitly reviewed bound change before retry. Pass argv, never interpolate filenames into a shell command. Diagnostics escape control characters and bound the displayed offender list while reporting the total.

In we:scripts/push-if-green.mjs, retain numbering for ordinary main publication and its existing error handling. After numbering, resolve the final main commit, check it, and publish that exact OID to the destination ref. For `--sha`, check the already-resolved source OID without numbering. Run the read-only validation before a successful dry-run report as well; dry-run still performs no mutation. `--assume-green` skips only the existing gate, not the tree check. Emit a distinct structured refusal reason and exit 3 for tree rejection/read failure. Non-main publication keeps its existing behavior. The guarantee is about the published tip, so a clean numbering commit may retain hash-bearing ancestors.

In we:scripts/guard-git-push.mjs, preserve lease and strict-main authorization checks. Independently of `MAIN_PUSH_OK`, validate each non-deletion source OID whose destination is main. Parse the whole payload before allowing anything; malformed records or unreadable input refuse. An empty, successfully read payload is a no-op. A valid all-zero deletion OID has no tree to check and remains subject to the existing authorization policy. Non-main refs receive no new tree inspection. Keep the existing POC tracker enforcement intact.

Use the existing hook rather than adding an unwired parallel hook. In we:.githooks/pre-push, make payload capture errors fatal before forwarding the same payload to both guards. The main tree validator runs inside the first guard, so sanctioned internal pushes are covered even when they do not call the publisher. Hook bypass remains the stated administrative residual.

The existing `tip-tree` default is not changed and this card introduces no new setting, config loader or policy override. Alternate reach semantics and real config loading remain separate work; do not imply that the pure resolver in we:scripts/lib/backlog-id-settings.mjs currently loads project configuration.

## MVP

Implement the shared tree reader, publisher check with immutable refspec, existing hook guard integration and fatal payload-read handling. Add behavioral tests at both entrypoints and update affected publisher fixture expectations for the extra Git reads and OID refspec. Retain direct-filing numbering and all current authorization/lease checks. No server configuration, numbering allocator changes, merge-method changes or history rewriting.

## Test plan

Add we:scripts/lib/__tests__/check-main-backlog-tree.test.mjs for direct helper coverage of A4–A5: hash-bearing versus numbered tip trees, all supported hash carriers, clean tips with hash-bearing ancestors, absent backlog, missing objects, failed enumeration, timeout and output overflow. Assert refusal diagnostics include the bound and operator fallback for timeout/overflow. Use real temporary Git trees for classification and injected execution for deterministic read failures; retain entrypoint assertions that these failures prevent publication.

Add we:scripts/__tests__/push-if-green-hash-tree.test.mjs and we:scripts/__tests__/guard-git-push-hash-tree.test.mjs. Reuse one fixture factory within the publisher test file (or duplicate the small literal fixture inputs in the guard file) so both exercise the same hash/numbered trees; do not add an unscoped fixture module. Use isolated repositories under the task temporary directory for real commit/tree reads and injected Git/process adapters for publication. Never contact a remote. Exercise hook stdin with the real hook process and controlled executables. Assert the checked OID equals the publication OID, not merely that a check function was called.

Update we:scripts/__tests__/push-if-green.test.mjs and we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs for new reads/refspecs while preserving their gate and numbering expectations. Retain we:scripts/__tests__/guard-git-push.test.mjs's override and pinned-lease coverage; the override remains permission to attempt publication, not permission to publish hashes. New guard tests supply valid OIDs rather than treating old pure permission fixtures as tree evidence.

Run only these affected files through the host heavy-admission runner. Command recipe: invoke Node on we:scripts/readiness/heavy-admission.mjs with `run -- npx vitest run`, followed by the six repository-relative test paths named above (strip the documentation `we:` locus prefix when executing). For a busy queue, use its supported bounded wait once, then report the result; never poll.

## Proof plan

First run the new A1–A5 regressions against the pre-build implementation through heavy-admission and retain the failing assertions. After implementation, rerun the same affected files through that queue and record the passing results. Capture the publisher's refusal JSON, hook exit status/diagnostic, and intercepted push calls: hash/read-error cases must have no publication, while numbered controls must reach the intended destination with the checked OID. Use real Git tree reads for the hash-versus-numbered fixture, not only mocked classifier output. Run the standards check through heavy-admission as the build's final consistency gate. The preparation worker performs no publication probes or build claims; the runner owns preparation checks and stamping.

## Follow-ups

- #3532 owns closing the raw admin/hook-bypass residual; this card adds no server-side guarantee.
- #4988 owns collision/land-route work. Reconcile overlapping publisher edits when implementing, without removing direct-filing numbering here.
- Share the classifier/fixture with the required PR check when that check is available; do not make this local full-tip-tree check depend on a diff-only PR check.
- Project config loading and non-default reach implementations remain outside this touch set.

## Progress

- Prepare-validation repair: old scope included we:scripts/lib/check-main-backlog-tree.mjs but omitted its matching helper test scope. Add we:scripts/lib/__tests__/check-main-backlog-tree*.test.mjs and the concrete helper suite to the test plan; preserve the completed design and entrypoint coverage. Current source still lacks outgoing-tree validation (we:scripts/push-if-green.mjs:209; we:scripts/guard-git-push.mjs:75). Size remains 3 (old 3, new 3): the additional helper suite is approximately 80 changed lines in one file, alongside the existing touch-set estimate below. No implementation or stamp is added.
- Premise checked against current source: not delivered. Old scope named only the publisher, authorization guard and an undifferentiated test directory. Corrected scope adds we:.githooks/pre-push, the planned shared tree reader and explicit matching test patterns. No source has moved; the missing coverage is inspection of the actual outgoing tree.
- Evidence: we:scripts/push-if-green.mjs:195 skips numbering for `--sha`; we:scripts/push-if-green.mjs:209 constructs a mutable branch refspec for ordinary publication, and line 211 pushes without a tree check. we:scripts/lib/number-pending-hashes-before-push.mjs:61 checks tracked files and can no-op when numbering modules are absent; numbering is therefore not proof about a selected commit tree.
- Evidence: we:scripts/guard-git-push.mjs:75 returns early for the authorization override; line 87 converts a stdin read failure to empty input. we:.githooks/pre-push:13 captures stdin without checking capture status and forwards it to both existing guards. These require explicit fail-closed tests.
- Caller evidence corrects the old “one shared choke point” premise: we:scripts/pr-land.mjs:795 has its own sanctioned push wrapper, called at lines 1591, 1676 and 1708. we:scripts/lane-drain.mjs:1329 calls the publisher with `--assume-green`. The existing hook covers the former; the unconditional publisher check covers the latter.
- Existing-test evidence: we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs:155 explicitly requires skipping numbering for `--sha` and dry-run; keep that behavior while adding read-only validation. The two new behavioral suites supply the previously missing tree-level proof.
- Size stays 3 (old 3, new 3): estimated touch set is publisher ~35 lines, guard ~55, hook ~5, helper ~80, two new suites ~240 total and existing suite adjustments ~30. This is one shared invariant with two entrypoints, not a new policy or server gate. As a story, it receives no estimatedLoc field.
- No tests were run for this card-only preparation; no prepared stamp or implementation claim is authored.

## Proposed blockedBy changes

- remove 4985 — settings declaration is resolved and the pure resolver is present; the prerequisite no longer blocks implementation (we:scripts/lib/backlog-id-settings.mjs:5). Independent reviewer confirmation is required; frontmatter is unchanged.
