---
bornAs: xf3tgxh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-backlog-submissions.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs", "we:scripts/audit-backlog-health.mjs", "we:scripts/__tests__/audit-backlog-health.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "d9d646fc7fc3631ed0f3a41cd986b11093e99921"
tags: []
---

# Prevention — reject uncodified decision resolutions and unfinished backlog submissions

Filed mechanically on approval of chalbert/web-everything#3229. Preserve the three prevention goals: catch direct-edit decision resolutions without codification in `check:standards`; make the literal unfinished acceptance placeholder a hard A1 failure; reject unmodified submission boilerplate in new stories.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3229@8fc41e30e1645e2e012804afba147899419b6c15

## Progress

Premise rechecked on 2026-11-19. Original preparation assumed no unfinished-acceptance standards guard and that the scaffold owned the acceptance sentence. Corrected premise: partial protection already exists, but the three prevention goals are not fully delivered. Keep the original implementation scope and add the existing content-lint regression suite; the submission integration suite remains planned. Size remains 3: three production files, three focused regression suites, and existing entry-point/content-lint compatibility coverage; no runtime or standard API changes.

- `we:scripts/check-standards-rules.mjs:1343-1371` already has a fence-aware unfinished-acceptance detector. Its callers at lines 1447–1457 reject prepared open cards under the executable-acceptance policy and open cards with mutation-proof claims. The old blanket absence claim was incorrect. Extend/reuse this detector without removing either existing guard.
- `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:944-1012` pins the claim-specific behavior, including valid scaffold drafting without a claim. Keep those pure rendering expectations; submission validation is a separate changed-card check.
- `we:scripts/backlog/task-agreement.mjs:57` now produces the labeled executable placeholder; `we:scripts/backlog/scaffold.mjs:164-169` composes it and inserts `GUARD_RELAXATION_HINT` (defined at line 19). Cover both current labeled and historical numbered scaffold lines.
- `we:scripts/check-standards.mjs:1051-1059` already calls `localChangedSet` and fails closed when it cannot compare against origin/main. Reuse that selection, not the provenance pass. `we:scripts/lib/verify-lane-gate.mjs:576-589` returns changed/deleted/untracked paths but no added classification: a bounded name-status diff against the same pinned base is still needed for tracked additions.
- `we:scripts/audit-backlog-health.mjs:281-296` accepts any executable token or exemption before considering unfinished text. Its scoped flags are partitioned at lines 620–642; reporting at lines 685–693 does not set a failing exit status. `we:package.json:81` exposes that CLI as `npm run check:health`. The changed exit default must be tested through this caller as well as the pure detector.
- `we:scripts/backlog/frontmatter.mjs:174-183` already validates codification at resolution. Authority remains `we:docs/agent/platform-decisions.md#promotion-discipline-enforced`; direct editing bypasses that operation.
- The original examples still support the goal: `we:backlog/4673-model-routing-strategy.md:3-4` is a resolved decision without codification; `we:backlog/4679-routing-pilot-one-capped-hosted-open-weight-trial.md:18` and `we:backlog/4681-routing-pilot-stage-0-join-every-model-call-to-its-card-step.md:18` retain the acceptance placeholder. They are evidence, not migration targets.

Repair verification on 2026-11-19 found the Design paragraph truncated at an inline acceptance-heading reference, with MVP and Test plan absent and the acceptance cases lacking their own heading. Restored those sections without changing the goal, scope, size, or completed proof and follow-up sections. The source evidence above still supports the corrected scope: the existing prepared/claim checks are narrower than submission validation, and the health reporter still has no placeholder-specific failing exit.

No preparation stamps were changed; the runner owns stamping and checks.

## Design

Add pure submission validation in `we:scripts/check-standards-rules.mjs`, with explicit inputs for the current card, body, and change classification (added versus modified). Return file-attributable errors using the existing standards diagnostic shape.

For added or modified cards, reject `kind: decision` plus `status: resolved` when `codifiedIn` is absent, null, empty, or whitespace-only. Accept the existing `one-off` sentinel; retain existing pointer validation rather than defining a different codification syntax. Read raw frontmatter. Reuse `validateCodifiedIn` from `we:scripts/backlog/frontmatter.mjs` for pointer syntax; reject non-string values before calling it. Unreadable or malformed changed cards must fail, never disappear through loader filtering.

For added stories, reject the exact scaffold acceptance sentence and the exact `GUARD_RELAXATION_HINT` as standalone unmodified lines outside fenced examples. Reuse the exported hint and the existing fence-aware acceptance detector; ignore quoted examples and inline-code discussions. Match the sentence after stripping the current `[A1]` or historical numbered list marker. Do not ban arbitrary TODO prose or quoted discussions of the defect. For open executable cards, detect the literal unfinished acceptance phrase inside the canonical Acceptance section or its legacy Done when alias before considering executable tokens or exemptions. Scan all matching sections, including subordinate headings, outside fenced examples. Give this defect a distinct A1 reason. In the health CLI, fail only for that reason within the selected audit scope after writing the normal report and JSON; preserve candidate-only behavior for other A1 reasons and G6. The standards submission rule applies the same defect check to changed open executable cards, irrespective of preparation stamps or proof claims. Preserve the existing prepared-card and proof-claim guards.

In `we:scripts/check-standards.mjs`, reuse the existing local changed-set selection against the pinned origin/main merge base, then classify tracked additions with a bounded name-status diff against that same base. Include committed branch changes, staged and unstaged edits, and untracked additions; exclude deleted paths and evaluate renamed destinations. Restrict candidates to the explicit local file list when supplied, before linked-file expansion. Default invocation checks all changed backlog candidates, not every historical card. Keep other whole-repository validators unchanged.

Treat missing base history, failed Git enumeration, output exceeding the existing 64 MiB subprocess bound, and unreadable or malformed changed-card evidence as attributable gate errors. Diagnostics must tell the operator to restore readable evidence/base history or reduce the oversized comparison and rerun; none of these paths may substitute an empty passing set. Test those refusal paths through injected Git/filesystem seams in the integration harness. Keep scaffold generation usable for drafting; submission is the new enforcement boundary.

## MVP

1. Add pure submission checks in `we:scripts/check-standards-rules.mjs` and their codification/boilerplate matrices in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`. Reuse the current codification validator and scaffold hint; extend the existing acceptance detector without weakening prepared/claim checks.
2. Wire candidate classification, raw-card reads, and diagnostics into `we:scripts/check-standards.mjs`. Add `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs` with disposable Git repositories and injectable failure seams. Preserve existing entry-point expectations in `we:scripts/__tests__/check-standards.test.mjs`.
3. Update `we:scripts/audit-backlog-health.mjs` to detect the distinct placeholder reason before token/exemption acceptance and apply the nonzero exit after scope partitioning and reporting. Introduce an injectable main seam for isolated report destinations and CLI fixtures; keep imports side-effect-free. Cover the existing package-script caller in `we:scripts/__tests__/audit-backlog-health.test.mjs` without changing `we:package.json`.
4. Retain compatibility coverage in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. Do not rewrite historical example cards or change scaffold generation.

## Test plan

- Unit: author A1 and A2 matrices in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`; test both scaffold generations, valid codification controls, non-string values, and quoted/fenced examples.
- Integration: author A3 and A4 in `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs`. Exercise actual CLI output and status for tracked/untracked changes, renames, deletes, explicit lists, defaults, and linked unchanged cards. Inject enumeration, buffer-limit, read, and parse failures; assert an actionable refusal and no false success.
- Audit: author A5 and A6 in `we:scripts/__tests__/audit-backlog-health.test.mjs`. Cover multiple acceptance sections, subordinate headings, executable tokens and exemptions beside unfinished text, selected and external scope, missing claim fallback, report/JSON output, and CLI/package-script exit status.
- Compatibility: run `we:scripts/__tests__/check-standards.test.mjs` and `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` alongside the new tests. Existing draft-rendering and prepared/claim expectations must stay intact; do not weaken fixtures to pass the new submission check.

## Acceptance

Each named regression below is to be authored red against the current implementation and green after the build; names are proposed test cases, not claims of existing coverage.

- [A1] **Executable** — `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`, “submission codification matrix”: changed resolved decisions reject absent/null/blank/non-string/invalid pointers, accept a valid pointer or one-off, and leave other kinds/statuses alone.
- [A2] **Executable** — `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`, “submission boilerplate matrix”: new stories reject both scaffold generations and the standalone hint; changed open executable cards reject acceptance placeholders without requiring preparation or a proof claim. Completed text, fenced/quoted examples, and discussion outside acceptance do not trigger the new rule.
- [A3] **Executable** — `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs`, “working-tree submission boundary”: actual CLI diagnostics cover committed/staged/unstaged/untracked additions and modifications, renamed destinations and deleted exclusions, default invocation and explicit file lists, while unchanged legacy and linked cards are not promoted into submissions.
- [A4] **Executable** — `we:scripts/__tests__/check-standards-backlog-submissions.test.mjs`, “incomplete submission evidence refuses”: missing base, failed Git enumeration, oversized output, malformed frontmatter and unreadable changed files produce nonzero exit with actionable diagnostics, never a green empty candidate set.
- [A5] **Executable** — `we:scripts/__tests__/audit-backlog-health.test.mjs`, “placeholder outranks proof and exemptions”: all accepted acceptance headings and multiple sections reject the literal unfinished phrase even beside commands/exemptions; fenced examples remain excluded. Run alongside the unchanged content-lint controls from `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` to preserve existing prepared/claim behavior.
- [A6] **Executable** — `we:scripts/__tests__/audit-backlog-health.test.mjs`, “health caller exit and scope”: the CLI and `npm run check:health` emit normal report/JSON and exit nonzero for an in-scope placeholder, then clear on correction. Other A1/G6 candidate flags stay non-failing; claimed scope excludes external placeholders, and missing claim evidence retains the current whole-backlog fallback. Import remains side-effect-free and default report destinations remain unchanged.

## Proof plan

Run the scoped suites through the host heavy-run queue only, including the existing entry-point and content-lint suites. Use `we:scripts/readiness/heavy-admission.mjs` with its `run --wait-ms=60000 --` wrapper and `npx vitest run`, supplying the scope test paths with their `we:` documentation prefix removed for shell execution. Wait once if busy, then report without polling. In an isolated fixture checkout with a known origin/main baseline, demonstrate the actual standards CLI red/green pair for each defect, preserving stdout, stderr and exit code. Include an unchanged legacy defective card to prove the change-sensitive boundary. Run the injectable health main and an isolated CLI/package-script fixture with output directed inside the task temporary directory, record the placeholder failure, replace it with concrete proof, and record the cleared result. Never mutate production audit reports for the demonstration. Finish with `npm run check:standards` through that same queue; distinguish unrelated baseline findings from these regression results. Preparation itself does not claim that these future guards pass.

## Follow-ups

Existing G6 and A1 debt remains visible for separate card-specific remediation. Do not bulk-add `one-off`, manufacture acceptance commands, broaden the placeholder lexicon, or change queue eligibility in this item. Broader quality judgments require separately specified rules; this MVP enforces the concrete defects named by the approval.
