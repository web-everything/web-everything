---
bornAs: xamy1gk
kind: story
size: 3
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "fb6c76988b0daba1f16e4f895934716da9222e21"
tags: []
---

# Standalone prepare runs are discarded as card tampering without naming the key, and the allowed prepare keys are too narrow

Standalone prepare still refuses forbidden frontmatter edits with a generic message and discards the worker diff. Preserve inspectable evidence and name every forbidden changed key with before/after values. The allowed-key expansion is already implemented: retain the ratified size permission and proposal-only blockedBy rule while fixing diagnostics and evidence retention.

## Acceptance

- [A1] **Executable** — Add `4670 reports forbidden key changes` in `we:scripts/lib/__tests__/probation-launcher.test.mjs`: enumerate additions, removals and changed values, including multiline values and CRLF, while ignoring permitted edits. The new diagnostic assertions fail before implementation.
- [A2] **Executable** — Add `4670 preserves rejected prepare evidence` in `we:scripts/operations/__tests__/probation-build-run.test.mjs`: a prepare changing size plus status reports only the forbidden status change, retains a readable patch before cleanup, and never stamps, commits or publishes. Include blockedBy and lifecycle edits, and the post-stamp check. Evidence assertions fail before implementation.
- [A3] **Executable** — Add `4670 fails closed when evidence cannot be saved` in `we:scripts/operations/__tests__/probation-build-run.test.mjs`: missing/malformed card evidence, failed diff capture and failed artifact writes escalate without publication; capture/write failure preserves the working diff and explicitly requires operator inspection. Include oversized diagnostics with an explicit truncation marker and full retained artifact. These explicit diagnostic/fallback assertions fail before implementation.
- [A4] **Executable** — Add `4670 prepare callers retain permission boundaries` in `we:scripts/operations/__tests__/probation-build-run.test.mjs`: exercise direct, builder-shaped and grouped requests; valid scope/size/task estimatedLoc edits still stamp, blockedBy remains proposal-only, and rejected members carry the diagnostic/artifact location in their reason. Assert build-mode card rejection stays strict. The rejected-run diagnostic assertions fail before implementation; existing positive permission assertions remain green.

Run these named cases through the host queue using the two test files listed in Test plan.

## Design

Keep `PREPARE_OWNED_FRONTMATTER_KEYS` unchanged. Add a structured frontmatter-change diagnostic beside the existing boolean helper in `we:scripts/lib/probation-launcher.mjs`; preserve that helper's default claim allowlist and existing callers. Diagnostics distinguish absent keys from empty values and preserve multiline field contents. Unknown keys remain forbidden. Missing or malformed frontmatter must be an explicit invalid-evidence refusal rather than an empty successful comparison. Keep formatting-only detection conservative; when a difference cannot be attributed safely, report an unattributed frontmatter difference instead of silently accepting it.

At both prepare checks in `we:scripts/operations/probation-build-run.mjs:543` and `we:scripts/operations/probation-build-run.mjs:719`, produce a bounded, control-character-sanitized and secret-redacted operator message naming forbidden keys and before/after values. Retain the complete worker patch and structured diagnostic in a unique per-run evidence directory under the lane git directory before `abandon` cleans the worktree. Use the existing git-directory artifact pattern at `we:scripts/operations/probation-build-run.mjs:1049`, with unique names so later runs cannot overwrite evidence. Report the repository-relative artifact location in the result detail and settlement; a cleaned worktree may still truthfully set resultDiscarded while explicitly identifying retained evidence.

Capture the full tracked diff against baseSha, including the card, with the existing diff IO; capture the card's raw before/after text separately so deletion or unreadable post-worker state is diagnosable. Do not execute or publish the patch. Limit inline diagnostics to 2,000 characters with an explicit truncation notice; retain full local evidence. If capture or persistence fails, skip destructive discard, retain the lane for operator inspection, and report that evidence is incomplete. Never let artifact failure route to stamping or publication. Existing hook-security refusal precedence remains intact.

Builder prepare already selects the same runner through `we:scripts/operations/dispatch-providers/probation-worker.mjs:46`; grouped preparation re-enters the same per-card runner at `we:scripts/operations/prepare-batch.mjs:28`. No separate builder policy or allowlist is needed. Put the artifact location in detail so grouped refusal reasons retain it without a new batch result schema.

## MVP

Implement the structured diagnostic, wire both prepare refusal sites, and persist rejection evidence before cleanup with the explicit failure fallback. Add focused unit and runner tests, including one real filesystem/git fixture for patch survival. Preserve existing allowed keys, independent blockedBy review, successful prepare defaults and strict build-mode checks. No live card reruns, policy expansion, new settings or batch coordinator changes are required to implement this slice.

## Test plan

Extend `we:scripts/lib/__tests__/probation-launcher.test.mjs` for A1 and invalid frontmatter handling. Extend the standalone prepare fixtures beginning at `we:scripts/operations/__tests__/probation-build-run.test.mjs:934` for A2–A4. Parameterize forbidden status, dateStarted, dateResolved, blockedBy and unknown keys; cover allowed size/scope edits alongside forbidden ones. Preserve existing proposal DAG and test-scope cases.

For the real IO test, create an isolated git repository under the task temporary directory, author a rejected card edit, capture evidence through production IO, clean the worktree, and read the patch back byte-for-byte. Inject capture/write failures separately. No network or real backlog mutation is needed. Run only these affected suites:

```sh
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/probation-launcher.test.mjs scripts/operations/__tests__/probation-build-run.test.mjs
```

The executable paths in that command refer to `we:scripts/readiness/heavy-admission.mjs`, `we:scripts/lib/__tests__/probation-launcher.test.mjs` and `we:scripts/operations/__tests__/probation-build-run.test.mjs`. Show the new cases failing against the pre-build implementation and passing after; do not count the already-green allowlist tests alone as proof.

## Proof plan

Use the real git/filesystem fixture to prove retained evidence survives cleanup, and injected runner traces to prove no stamp/commit/PR on every rejection and capture failure. Record the diagnostic, retained artifact location and cleanup outcome together. Reproduce the reported #3996/#4003 failure class with synthetic cards: legitimate size corrections stamp; forbidden lifecycle corrections refuse with evidence. The historical live runs are context, not permission to rerun or alter those cards. After implementation, run the scoped suites above and the queued standards gate; this preparation itself leaves checks and stamping to the runner.

## Follow-ups

A human may separately authorize live reruns of #3996/#4003 if those cards still need preparation. Broader evidence retention for worker crashes, hook tampering, non-prepare builds or unrelated envelope failures is outside this slice. Do not widen blockedBy ownership without a new ruling.

## Progress

- Original premise/scope: only scope and prepare stamps were allowed; size and blockedBy needed widening; three files were listed without the library test. The old refusal citation around line 398 and allowlist citation at line 208 are stale.
- Corrected premise: `we:scripts/lib/probation-launcher.mjs:219` already permits scope, size, estimatedLoc and the two stamps. `we:scripts/lib/__tests__/probation-launcher.test.mjs:268` already pins size acceptance and blockedBy/status refusal. The ratified blockedBy proposal rule remains binding; it is not an unresolved fork.
- Remaining defect observed in source: `we:scripts/operations/probation-build-run.mjs:543` still returns the generic refusal; `we:scripts/operations/probation-build-run.mjs:354` discards changes; `we:scripts/operations/probation-build-run.mjs:719` has a second generic post-stamp refusal. Neither retains diagnostic evidence on these paths. This is partial delivery, not already-done.
- Corrected scope adds `we:scripts/lib/__tests__/probation-launcher.test.mjs`. Builder and batch share the runner, evidenced by `we:scripts/operations/dispatch-providers/probation-worker.mjs:46` and `we:scripts/operations/prepare-batch.mjs:28`; those callers need coverage rather than source edits.
- Size stays 3: approximately 60–90 changed lines in `we:scripts/lib/probation-launcher.mjs`, 70–100 in `we:scripts/operations/probation-build-run.mjs`, 50–70 in `we:scripts/lib/__tests__/probation-launcher.test.mjs`, and 120–160 in `we:scripts/operations/__tests__/probation-build-run.test.mjs`. The helper at line 309, two refusal sites and existing standalone fixture bound the touch set. This is a story, so no estimatedLoc field is added.
- Preparation is source-based; no implementation or runtime-success claim is made. No lifecycle fields or preparation stamps were changed.

## Operator ruling — 2026-10-03 (ratified, verbatim)

No ruling operation exists for a non-decision card (checked `we:scripts/operations/` and the `we:scripts/backlog.mjs` verbs), so the ruling is recorded here in the body; no lifecycle field was touched.

Question: may a prepare worker change a card's `size` and `blockedBy`?

1. Operator answer: "Seems that it would need to be"
2. Operator refinement: "Blocked by, maybe with a confirmation from another agent?"

Resulting rule:
- `size`: the prepare worker may change it directly, grounded in file:line evidence and stated in `## Progress`. Implemented by adding `size` to `PREPARE_OWNED_FRONTMATTER_KEYS` (we:scripts/lib/probation-launcher.mjs).
- `blockedBy`: the worker may only PROPOSE edge changes in a `## Proposed blockedBy changes` section (add/remove, with file:line grounds); the frontmatter stays unchanged, and a direct `blockedBy:` edit is still refused as tamper. Confirmation mechanism: the parked prepare PR's independent review is the second actor (a different session from the preparer); the runner lists the proposed edges in the PR body. No existing juror pattern was reused because the review already is an independent actor. An add may never target a resolved or missing card or create a cycle (`validateProposedBlockedBy`, the same rules as check:standards "6d-ter"); the runner refuses the run otherwise.

