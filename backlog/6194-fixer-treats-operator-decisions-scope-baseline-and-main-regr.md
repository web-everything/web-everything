---
bornAs: xkt0ix9
kind: story
size: 8
status: open
scope: ["we:scripts/conveyor/fix-brief-inputs.mjs", "we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs", "we:scripts/lib/operator-send-backs.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs", "we:scripts/conveyor/repeated-finding-reset.mjs", "we:scripts/conveyor/__tests__/repeated-finding-reset.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-resume.test.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/conveyor/__tests__/fix-context-pack.test.mjs", "we:skills-src/conveyor/fix-agent-brief.md"]
dateOpened: "2026-10-17"
preparedDate: "2026-10-17"
preparedAgainstSha: "b6cbab938215165c684d7e6a64adafc39a070ac8"
tags: []
---

# Fixer treats operator decisions, scope baseline and main-regression checks as binding brief input

Operator 2026-10-17: "we have to keep improving the fixer", meaning no direct Codex passes on conveyor PRs except in emergencies. Preserve that goal: a repair round must receive the operator's complete ruling, its allowed scope and explicit exclusions, all current blocked findings, and a requirement to preserve main's deny behavior when repairing a guard or gate.

The original incident account names PR #5403 (13 rounds), PR #5461, a repeated-finding reset associated with PR #5463, and a joined round associated with PR #5465. These are historical PR references, not dependencies on same-numbered backlog cards. The round counts and PR #5465 delivery are not independently verified by this preparation. Current implementation evidence, rather than those incident claims, defines the remaining work below.

## Acceptance

The named `6194 A<n>` cases below are **planned additions** to existing suites or the new suite explicitly identified below. Each must fail against the pre-build implementation and pass after the build; existing green tests alone do not discharge these guarantees. Run the suites through the queued commands in Test plan.

- [A1] **Executable** — `6194 A1 complete binding decisions` in we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs and we:scripts/lib/__tests__/operator-send-backs.test.mjs: an authenticated sanctioned send-back longer than 4,000 characters, followed by a mechanical bounce and a linked stand-down answer, retains the complete published decision text, attribution and comment identities. Fake authors, quoted ceremonies and unlinked answers cannot become binding input. Existing resolution/supersession and disposition semantics remain intact.
- [A2] **Executable** — `6194 A2 exclusions constrain reset` in we:scripts/conveyor/__tests__/repeated-finding-reset.test.mjs: a sanctioned baseline plus an excluded file inside an otherwise allowed directory prevents that file's later commit from replaying. Mixed allowed/excluded commits are not partly replayed. Missing/non-ancestor baselines, unsafe or foreign-repository paths and an excluded change already in the baseline refuse before tree mutation. Existing projection onto current main and published ancestry are preserved.
- [A3] **Executable** — `6194 A3 joined obligations` in we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs and we:scripts/operations/__tests__/fix-run.test.mjs: two blocked referrals, an unresolved operator send-back and a current review produce one complete round checklist; a newer mechanical comment cannot replace them with a singular latest-only ask. Every obligation has an evidence slot and the brief forbids a successful hand-back until all blocked findings are repaired in that round; genuinely incompatible instructions require escalation, not selection of one convenient subset.
- [A4] **Executable** — `6194 A4 main regression required` in we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs and we:scripts/conveyor/__tests__/fix-context-pack.test.mjs: guard/gate changes default to a mandatory pinned-main comparison, one deny test per identified main-denied shape, and a before/after evidence matrix. The brief explicitly covers source, documentation, configuration and data inputs and error refusals. Ordinary changes receive no guard-specific step; unknown/incomplete file classification cannot silently take that ordinary branch. Turning the optional context pack off cannot disable these requirements.
- [A5] **Executable** — `6194 A5 every fixer entry` in we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs, we:scripts/conveyor/__tests__/fix-resume.test.mjs, we:scripts/operations/__tests__/dispatch-lane-io.test.mjs and we:scripts/operations/__tests__/fix-run.test.mjs: fresh, borrowed, conflict-resume, round-resume, operation-dispatched and direct-launcher repairs carry the same required input section. A resume with reset obligations routes to the existing mechanical launcher instead of patching around the reset. CI-heal-only dispatch remains its separate mode.
- [A6] **Executable** — `6194 A6 incomplete input refuses` in we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs and we:scripts/operations/__tests__/fix-run.test.mjs: failed pagination, changed PR head, oversized mandatory content, malformed sanctioned reset metadata or unavailable required main evidence cause no provider spawn, reset or push. Optional code excerpts may be omitted; mandatory decisions and blocked findings may never be silently clipped. A complete empty decision set still permits an ordinary authenticated review repair.

## Design

### One required input section, composed from existing readers

Add we:scripts/conveyor/fix-brief-inputs.mjs with a pure builder/renderer and an injectable read boundary. Its input is a repository/PR/head identity, complete ordered comments, complete changed paths, declared scope, current block-ruled referrals and optional main comparison evidence. Its output is either a structured refusal or a versioned required section containing decisions, obligations, reset constraints and regression instructions. Keep explanatory code snippets in the existing optional context pack.

Reuse the sanctioned send-back reader in we:scripts/lib/operator-send-backs.mjs and the answer reader/linkage/disposition rules in we:scripts/conveyor/stand-down-answer-core.mjs. Add an opt-in complete-body mode to the send-back reader; existing compact display callers retain their current default. Preserve published decision prose verbatim inside a data fence whose delimiter cannot be closed by the prose. Carry comment id, author, time, repository, PR and observed head separately; neither a body assertion nor viewer ownership authenticates a new operator ceremony. Retain the existing distinction between a trusted posting principal and a claim that a human personally typed the words. Do not expand the set of authorized principals.

The required section states that operator rulings settle the specified repair questions while review gates and ratified decisions remain in force. Aggregate unresolved send-backs, the applicable stand-down answer, current block-ruled referrals and the current trusted review finding set into one round. Deduplicate by source comment/finding identity, not matching prose. Preserve source boundaries and include a checklist row for each blocked finding. Require one repair pass addressing the entire set, with per-finding change/test evidence before successful hand-back; if any cannot be repaired within the authorized scope, report that blocker rather than claim the round complete. Do not resurrect resolved requests or historical findings merely because round history mentions them. Conflicting current obligations cause a stand-down with the conflicting sources cited; this item does not invent precedence between contradictory operator policies.

### Reset constraints

Reuse we:scripts/conveyor/repeated-finding-reset.mjs and its corrective-commit reset path. Recognize a standalone `scope-baseline: <40 lowercase hex characters>` line and zero or more `out-of-scope: <repo-qualified path>` lines in the decoded, sanctioned decision body. A path names an exact file or a directory ending in `/`; no shell/glob interpretation, absolute paths, traversal or foreign repository prefix. A later applicable baseline decision replaces the earlier baseline/exclusion bundle; do not mix exclusions from a superseded baseline. Exclusion-only active decisions narrow the current scope and cannot authorize a reset by themselves. Multiple differing baseline values within one decision refuse.

Preserve existing operator-authored standalone baseline markers as legacy input; new exclusion metadata must come from a sanctioned decision. The reset switch and repeated-finding trigger keep their current semantics: a marker alone does not trigger a reset. Exclusions subtract from the existing scope, never enlarge it. Validate the baseline contribution and every prospective replay path; a baseline already containing excluded contribution refuses rather than silently rewriting the operator's baseline. Reject malformed sanctioned metadata instead of falling back to an older usable marker. Preserve dirty-lane, ancestry, merge/conflict and main-projection checks. Continue using an ordinary corrective commit, never force-push. Following a reset, the next repair receives the same unresolved obligation set; a mechanical reset alone is not evidence that every finding was fixed.

### Main-regression requirement

Classify the complete actual touch set, not just the card's predicted scope. The initial deterministic classifier covers we:scripts/guard-*.mjs, we:scripts/check-standards.mjs, source basenames containing a hyphen-delimited `gate` token, files under a `gates` directory, and gate-named workflow/config files. Treat both rename sides as touched. Repo prefixes are normalized against the requested repo before matching; no WE-only assumption in sibling dispatches. Explicitly enumerate positive/negative fixtures in the classifier tests. Unreadable/incomplete paths refuse classification.

For a positive match, pin the observed main commit, stage the relevant main source/diff or an immutable readable reference, and require the fixer to enumerate main's denied shapes and add a denial case for each. The evidence matrix has input shape, main refusal, candidate refusal, test and outcome. A missing/error input must still refuse; documentation/configuration/data entry points remain cautious alongside source code. An intentional weakening inconsistent with the recorded ruling is escalated. This is a required brief/test obligation, not a new authorization policy or an automatic proof that the model found every semantic shape.

Update we:skills-src/conveyor/fix-agent-brief.md so read-only main comparison is explicitly permitted without merging main or changing the PR's base. Respect we:docs/agent/platform-decisions.md#local-gate-never-full-suite-by-default: request scoped tests through heavy admission, preserving the existing proof-only rule and using the verify gate for candidate after-evidence. No repeated local green runs or broad default suite. Main's preserved-denial pins are non-regression evidence; the newly added brief/classifier tests supply this item's red-to-green proof.

### Callers, budgets and defaults

Append required input after optional packing and token filling, so we:scripts/conveyor/fix-context-pack.mjs cannot trim it or interpret quoted template tokens. Correct that pack's singular-authority wording. Use one mandatory-content ceiling of 128 KiB UTF-8; exceeding it refuses, never summarizes away obligations. Keep the optional pack's existing budgets unchanged.

Wire we:scripts/conveyor/reconcile-fix-dispatch.mjs at fresh/borrowed and both resume boundaries. Mandatory reads must not sit inside the existing best-effort history catch. Wire the fix-kind provider boundary in we:scripts/operations/dispatch-lane-io.mjs as well. In we:scripts/operations/fix-run.mjs, re-read complete comments and head and rebuild the required input immediately before reset/spawn, replacing the current singular authoritative section. The final launch must not trust a serialized earlier section after the head changes. Match repo/PR/head across the inputs; retry through the existing caller on mismatch. Required instructions default on for repair, independently of optional context-pack settings. Do not change provider choice, review labels, round caps, reset-switch defaults or CI-heal policy.

## MVP

**Must:** deliver A1–A6 together: complete sanctioned decisions, one blocked-finding checklist, authenticated reset exclusions, mandatory main-regression instructions and fail-closed caller integration. Keep existing parsers, reset machinery and lifecycle handling; implement one shared required-input module rather than a second repair engine.

Implementation order: add the pure input model and discriminating fixtures; extend complete-body and reset handling; wire every launch/resume path; update optional-pack/template wording; run the scoped tests and execute the proof below. Each source in scope has its paired test listed; we:skills-src/conveyor/fix-agent-brief.md is exercised by we:scripts/conveyor/__tests__/fix-context-pack.test.mjs.

**Could, after MVP:** machine-validate the evidence matrix against executed tests, or infer additional gate dependencies beyond the explicit classifier. Neither is needed to establish the brief-input contract, and neither may be claimed as delivered here.

## Test plan

Add the named A1–A6 cases before implementation. Reuse rendered verdict/answer fixtures rather than hand-authoring look-alike comments. Include an operator decision beyond the old 4,000-character boundary, a blocked finding beyond the old 12,000-character launcher boundary, embedded fences/markers/template tokens, an untrusted newer comment, resolved/superseded requests, an unlinked disposition, REST/GraphQL author shapes and multiple repositories with the same PR number.

Use temporary Git repositories for A2: baseline, excluded-only commit, allowed commit, mixed commit, advanced main, conflicting main and foreign ancestor. Snapshot HEAD/index/worktree before refused resets. Test renamed paths, directory exclusions, documentation, configuration and data files and the unchanged disabled-reset setting. Inject read/spawn/write seams for A5–A6; assert zero provider/reset/push calls on refusal and parity of the required section across entry points. Exercise fresh main evidence and a head change between reads. No live comment posting is needed for unit tests.

From the WE checkout, run only through the host queue. This shell helper strips the displayed repository prefix from each argument before execution:

```bash
we() { local argv=() arg; for arg in "$@"; do argv+=("${arg#we:}"); done; "${argv[@]}"; }
we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/fix-brief-inputs.test.mjs we:scripts/lib/__tests__/operator-send-backs.test.mjs we:scripts/conveyor/__tests__/repeated-finding-reset.test.mjs
we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs we:scripts/conveyor/__tests__/fix-resume.test.mjs we:scripts/operations/__tests__/dispatch-lane-io.test.mjs we:scripts/operations/__tests__/fix-run.test.mjs we:scripts/conveyor/__tests__/fix-context-pack.test.mjs
we node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

## Proof plan

Before building, save the named new tests' failing output against the starting implementation. Capture the actual produced provider prompt using the existing injected dispatch/provider seams, not just the pure renderer: demonstrate the old truncated decision/latest-only ask and absent main-regression step, then the complete joined section after the change. Record the tested commit, repository/PR/head, comment identities, main SHA and exact command/output. Use synthetic fixtures labelled as such unless the historical PR threads are actually retrieved; do not represent a fabricated #5403 transcript as live evidence.

Execute the real reset implementation in the temporary Git history and inspect the resulting diff: excluded post-baseline work gone, retained scoped work present, advanced-main content preserved, published HEAD still an ancestor of the corrective commit. Capture no-mutation evidence for refusal cases. For a guard fixture, run the same representative source, documentation, configuration, data and error denial inputs against pinned main and the candidate; preserve each denial while showing the intended repair succeeds. Use queued scoped execution and candidate verify output, not a second unscoped suite.

For production adoption after review, observe one authorized conveyor repair carrying a sanctioned decision and one guard/gate repair; record the launched brief and resulting evidence matrix. A dry fixture proves wiring, not live daemon adoption. Do not manufacture a production reset or send a decision comment merely to test preparation.

## Non-goals

- [N1] No new operator-authentication policy, review bypass, cap reset, provider preference, automatic merge or lifecycle-field permission.
- [N2] No semantic oracle for all guard behavior, arbitrary prose-to-path inference, or automatic resolution of conflicting operator decisions.
- [N3] No changes to the generic worker renderer in we:scripts/worker-brief.mjs; its shared handoff rules are not the PR repair input boundary.

## Edge cases this change must handle

1. **Untrusted text** — authenticate before parsing; quote decision bodies as data. Never execute prose, marker values or a path as a shell command.
2. **Truncated reads** — complete paginated comments and file lists are mandatory; failed reads or the mandatory-content ceiling refuse. Optional excerpts remain dispensable.
3. **Shared state files** — no new mutable ledger; derive from the scoped PR snapshot and use existing claim/private-prompt cleanup. Reset only the acquired repair lane.
4. **Fail closed** — unavailable main evidence, unsafe reset metadata, unresolved conflicting instructions or changed head cannot degrade to a plain patch brief.
5. **Identity scoping** — bind repo/PR/head and comment ids; reject foreign-repository exclusions and unlinked answers.
6. **State over time** — apply existing request resolution and answer supersession; rebuild on each round/head and retain unresolved obligations across a mechanical reset.
7. **Who wrote it** — use existing posting-principal checks and sanctioned envelope parsing; attributed actor prose is not cryptographic human presence.
8. **Receive/write endpoint abuse** — no new endpoint. Existing readers, GitHub ceremonies and repair claims remain in use. The mandatory-section byte cap bounds prompt assembly; repeated reset authorization still requires the existing repeat trigger and valid operator baseline. HTTP CSRF/origin checks and new rate limits are not applicable to this internal reader/brief change.

## Follow-ups

- Extend the classifier using observed missed gate entry points, with a fixture for each addition; dependency-graph inference is a separate increment.
- If prompt compliance remains insufficient, design machine-checked regression evidence as a separate work item using the recorded matrices. Do not silently turn brief preparation into a new merge gate.
- Verify the historical joined-round claim associated with PR #5465 before citing it as delivered coordination infrastructure. No dependency edge is proposed from an unverified PR/backlog-number collision.

## Progress

- Preparation inspected checkout `b6cbab938215165c684d7e6a64adafc39a070ac8`. No prepared stamp is written; the runner owns stamping and review.
- **Old premise/scope:** add operator parsing and baseline resets under broad we:scripts/conveyor/ and we:scripts/operations/ plus we:scripts/worker-brief.mjs; coordinate with bare #5463/#5465; size 5.
- **Corrected premise:** operator handling and reset are partially delivered, so this is integration/completeness work. we:scripts/lib/operator-send-backs.mjs:18 parses authenticated ceremonies, but line 30 caps bodies at 4,000 characters. we:scripts/conveyor/stand-down-answer-core.mjs:52 validates the encoded answer; line 147 selects linked answers and line 156 renders the ruling. we:scripts/conveyor/reconcile-fix-dispatch.mjs:1184 already composes those inputs with blocked referrals, and lines 941, 1106, 1537 and 1586 cover multiple dispatch routes.
- **Remaining evidence:** we:scripts/operations/fix-run.mjs:373 selects one finding and line 383 caps it at 12,000 characters; lines 598 and 775 already invoke repeat planning/reset. we:scripts/conveyor/repeated-finding-reset.mjs:87 reads operator baseline markers and line 121 starts the existing corrective reset, with no explicit exclusion argument. we:scripts/conveyor/fix-context-pack.mjs:254 clips finding bodies, while line 449 makes pack read failures optional. Those are unsuitable as the sole carrier of binding obligations. we:skills-src/conveyor/fix-agent-brief.md:276 restricts touching main to conflict handling, so the new read-only comparison needs explicit wording.
- **Corrected touch set:** replace broad directories/generic worker renderer with the exact helper, readers, launchers, reset, context pack and repair template above plus matching tests. Include the alternate provider boundary at we:scripts/operations/dispatch-lane-io.mjs:1600, which currently forwards the payload prompt without this required section. we:scripts/worker-brief.mjs:4 describes generic worker handoff rules; it is not the missing fixer template.
- **Reference correction:** commit `9e3d7874f` explicitly names PR #5463 and modifies the reset implementation. Same-numbered backlog cards are unrelated: we:backlog/5463-prevention-add-a-card-lint-rule-in-check-standards-an-accept.md and we:backlog/5465-prevention-use-r-marked-length-0-here-also-add-a-small-test.md. They are not prerequisite edges. No claim that the whole goal is already delivered follows from these partial implementations.
- **Sizing:** old size 5 → new size 8. Expected changed lines: new helper ~220; complete-body reader ~25; reset ~60; reconcile launch/resume wiring ~90; operation dispatch boundary ~35; launcher ~80; context pack ~20; repair template ~40; eight test files ~500 total: approximately 1,070 changed lines across 16 paths. The additional entry points and failure tests are grounded in the citations above. This remains a story, so no estimatedLoc field is added.

- **Observed preparation checks:** queued existing suites we:scripts/conveyor/__tests__/repeated-finding-reset.test.mjs, we:scripts/lib/__tests__/operator-send-backs.test.mjs and we:scripts/conveyor/__tests__/fix-context-pack.test.mjs passed: 3 files, 93 tests. These verify the reused behavior, not the planned A1–A6 additions. Queued `npm run check:standards` exited 0 with 0 errors and 6,296 warnings; `git diff --check` passed.
