---
bornAs: x1tkiy5
kind: story
size: 1
status: resolved
scope: ["we:.github/workflows/soak-replay-gate.yml", "we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-15"
dateResolved: "2026-10-15"
preparedDate: "2026-10-15"
preparedAgainstSha: "edb8055073a75ec1efa998a6d9778476e7437d4d"
tags: []
---

# soak-replay-gate diffs against the current main tip, not the stale pull_request.base.sha

Held finding 251 (2026-10-12; workflow edit, needs a human verdict on the implementation PR). For main-targeted pull requests, use a freshly fetched main tip as the input to the existing merge-base diff. An event captured before inherited commits reached main must not attribute those now-shared commits to the PR. The originally reported incident was #4992/#4993 versus 865db38; this preparation verifies the current wiring, not that historical run's verdict.

## Progress

- Old premise/scope: the workflow diffs against `pull_request.base.sha`; change only `we:.github/workflows/soak-replay-gate.yml` to use current main.
- Corrected premise: `we:.github/workflows/soak-replay-gate.yml:79` still binds the event base SHA, and lines 100–105 pass it to either the modern CLI or legacy merge-base calculation. The diff already uses a merge-base; the stale **input** is the defect. `we:scripts/lib/soak-gate-merge-base-diff.mjs:59` resolves that basis and line 89 computes name-status. No helper or evaluator rewrite is needed.
- Corrected scope: the workflow plus its existing executable-shell transport test, `we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs:25`. That test currently asserts the old environment and argv at lines 75–105 and must change with the transport. It can also host a real-Git workflow replay, so every source entry has a matching test in scope.
- Current boundaries: `we:.github/workflows/soak-replay-gate.yml:38` accepts stacked lane targets as well as main; lines 127–133 already retrieve each merge-group member's live base/head. Preserve those paths rather than substituting main for an open stack's base or changing merge-group attribution.
- Size remains 1: approximately 20–35 changed workflow lines plus 100–150 test lines in the existing shell harness (two files). The latter supplies current-main resolution stubs, error cases, and a real-Git ancestry regression. This is a story; no estimatedLoc field is added. No stamp is authored by this worker.

## Design

In `we:.github/workflows/soak-replay-gate.yml`, bind the event base branch name through an environment variable alongside the existing SHA. After the bootstrap guard, for main-targeted PRs explicitly fetch main into its remote-tracking ref with full ancestry, resolve that ref to a commit SHA, and replace the local BASE_SHA value with that immutable result. Fetch the event head with full ancestry as today. Feed the resolved SHA into both the modern CLI invocation and the legacy inline merge-base path. Log the selected base and head SHAs so a rerun is auditable.

Use a fixed main refspec, not shell interpolation of a PR-supplied ref. Keep the event base SHA for lane-targeted PRs. Retain trusted-main checkout, live-body retrieval, permissions, event head selection, waiver semantics, rename detection, and the existing merge-base helper's conservative base-tip fallback. A main fetch or commit-resolution failure must exit nonzero; never continue with the stale event SHA or an empty file list. The script-absent bootstrap behavior remains unchanged.

Fresh means the main snapshot fetched during this execution, not a promise to follow later concurrent main commits. Merge-base removes inherited commits only when their ancestry is shared with fetched main; patch-equivalent squash/cherry-pick detection is outside this change.

## MVP

1. Update the pull-request transport and its explanatory comments in `we:.github/workflows/soak-replay-gate.yml` to resolve current main only for a main target, with explicit failure handling and SHA diagnostics.
2. Extend `we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs` to execute the actual YAML shell with the new bindings, checking modern and legacy CLI paths, stacked targets, fresh reruns, and failed fetch/resolution.
3. Add a real-Git fixture in that same test: event base A; inherited daemon commit B; PR head C adding only documentation; main has advanced to B plus an unrelated commit D. With a fix-shaped title and no waiver, the stale A basis includes B and refuses; the fetched-main merge-base B excludes B and clears. Then add a PR-owned daemon fix E and require refusal. Run the real CLI in this fixture rather than the existing node stub that always supplies a daemon path.

## Acceptance

- [A1] **Executable** — the workflow test's real-Git regression fails with the current event-base wiring and passes after the change; the paired PR-owned daemon fix still refuses without replay or waiver.
- [A2] **Must refuse on error** — main fetch failure, missing/invalid resolved commit, head fetch failure, live-body retrieval failure, and diff execution failure yield nonzero, never a synthetic clean result. Preserve the existing merge-base-to-base-tip fallback when both commits remain usable.
- [A3] **Must retain all input kinds** — source, docs, config, and data remain in the name-status diff without a new extension filter. The existing evaluator decides applicability; docs-only can clear, but config/data or renamed/deleted paths in daemon scope must not disappear merely because they are not source code.
- [A4] Lane-targeted PRs retain their event base, and merge-group member evaluation remains unchanged. Both CLI compatibility branches receive the same selected main snapshot on main-targeted runs.

## Test plan

In `we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs`, update exact environment/argv expectations and add: main versus lane selection; two executions with main advanced between them; modern and legacy paths; main fetch/rev-parse/head-fetch failure; no evaluator invocation after failed resolution; and the real-Git fixture described above. Exercise docs, config, data, deletion and rename name-status entries to ensure transport remains unfiltered. Keep existing live-waiver red/clear/red and shell-metacharacter cases.

Run the affected test through the host queue (commands below are shell syntax, relative to WE):

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/soak-gate-merge-base-diff.test.mjs scripts/__tests__/soak-replay-gate-cli.test.mjs scripts/lib/__tests__/soak-replay-gate.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

The latter suites are regression checks, not additional implementation touch points. Preparation itself does not claim those future cases exist or pass; runner-owned checks follow this card edit.

## Proof plan

Capture the real-Git fixture's A/B/C/D/E SHAs, selected workflow base, changed-file list, and CLI exit codes. Demonstrate old wiring red versus new wiring clear for inherited B, and red for the PR-owned E control. Execute the YAML's shell, not a reimplementation of its selection logic. Show the same result through the legacy compatibility branch and a failed-fetch nonzero control.

After implementation reaches trusted main, observe a main-targeted workflow run/rerun with a stale event base and compare its logged selected SHA to the fetched main snapshot. Record the run URL and verdict; do not claim this hosted proof from local stubs. The implementation PR runs scripts from main, so bootstrap/version behavior must be accounted for when interpreting its pre-merge checks.

## Non-goals

- No change to daemon applicability, waiver policy, required-check administration, merge-group membership, stacked-PR policy, or patch-equivalence accounting for squash merges.
- No new endpoint, shared state store, or dispatch infrastructure. Body-size caps, CSRF, rate limits, and state-reset abuse controls are not applicable to this read-only CI transport change.

## Edge cases this change must handle

1. **Untrusted text** — keep quoted environment transport and existing metacharacter tests; the main fetch refspec is fixed.
2. **Truncated reads** — failed Git/API operations stay nonzero; never interpret missing output as an empty successful diff.
3. **Shared state files** — none introduced; ref updates occur in the isolated CI checkout and test fixtures.
4. **Fail closed** — resolution/fetch/diff failure refuses; existing bootstrap and merge-base fallback semantics are explicitly retained.
5. **Identity scoping** — resolve main from the base repository's origin; retain PR number/repository API scoping and event head identity.
6. **State over time** — refresh once per execution and freeze that SHA; reruns can observe newer main. Open lane bases retain their existing comparison semantics.
7. **Who wrote it** — executable gate code remains checked out from trusted main; PR content supplies metadata and history, not gate implementation.

## Follow-ups

No prerequisite or blockedBy change is proposed. If ancestry-only comparison still overcounts squash/cherry-picked inherited patches, capture a separate concrete reproduction before proposing patch-equivalence policy. Hosted run evidence belongs to implementation delivery; this preparation neither changes branch protection nor grants the workflow PR its human verdict.
