# Generalising probation: one registry, one watcher, operator exit

**Date**: 2026-10-25 (ET)
**Point**: Source-grounded preparation of #4010; evidence isolation is the proposed invariant; its lossless encoding is an implementation choice.
**Research page**: `/research/probation-registry-generalisation/`
**Decision**: `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md`

## Question

How can model probation become a subject registry for models, systems, and rulings without inventing parallel watchers or diluting model trust? The planner design supplies the first non-model case. This report proposes a shape; it neither enrolls a subject nor ratifies an exit.

## Recommendation

Preserve subject identity, revision and evidence scope regardless of encoding. Multiple representations may coexist when they preserve those distinctions; typed records and the JSON shape are illustrative. Keep one logical registry and one scheduled review sweep, with metric/eligibility adapters per subject type and a model compatibility facade. The proposed watcher reports findings and recommends review. Planner probation exit remains the operator's act under its existing rule; applying that governance to other systems and rulings is this proposal.

The proposed planner entry in the card starts in shadow with a collecting baseline. Activation freezes baseline range/digest and starts the 30-day ET review clock. No activation date or passing baseline is fabricated.

## Survey: shipped code versus ratified requirements

| Source | Finding | Consequence |
| --- | --- | --- |
| we:scripts/lib/model-probation.mjs:87 | Identity is provider/model; role validation is explicit at :159. | Synthetic providers for systems would change the identity contract, not merely reuse it. |
| Same module, :97 and :123 | Entries require provider/model/since/owner/roles; duplicate identity keeps the first and reports the dropped row. | Generic migration must diagnose duplicates and pin deliberate compatibility behavior. |
| Same module, :212 and :228 | Read errors yield an empty registry; writer persists declarations without validating them first. | Preserve fail-closed model reads and validate the new schema before publication. Do not claim the old writer already provides that guarantee. |
| Same module, :458 | Graduation progress consumes scorecard evidence by exact triple. | Lifecycle status and graduation eligibility are distinct; a generic subject state must not replace this evaluator. |
| we:scripts/lib/model-probation.json:1 | Persisted version-1 model declarations. | Migration needs old-state fixtures, not only brand-new schema examples. |
| we:scripts/operations/review-pr.mjs:257; we:scripts/conveyor/run-quality-record.mjs:51 | Live status callers import the model facade. | Compatibility matters to seats and recorded run metadata. |
| we:docs/agent/platform-decisions.md:5011 | Model graduation has trial mix, calibration veto, role scaling and a uniform floor; numbers at :5056. | Do not apply the model delivery bar to planner design outcomes. |
| we:docs/agent/platform-decisions.md:5679 | Planner design ships on probation; weekly tripwires file review, 30-day review follows activation, exit is operator-controlled. | The watcher cannot switch off a system or rewrite a ruling. |
| we:backlog/4011-planner-build-probation-metrics-record-and-probation-entry.md:6 | Planner evidence producer/entry remains open, blocked by #4004/#4010. | A real baseline is a build dependency, not a fact to assert during preparation. |

Historical lineage was checked in #3922's probation section and #3383's model-rollout entry (we:backlog/3922-decision-the-planner-build-g2-a-planner-splits-a-build-into.md:269; we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md:2554). Settled authority comes from the named statute anchors, not these historical work logs.

## Known occurrences and scheduler comparison

| Existing occurrence | Reusable shape | Boundary |
| --- | --- | --- |
| Model probation | Declaration, normalized identity, evidence report, operator promotion | Model trust remains subject-specific. |
| Planner design probation | Baseline, periodic tripwire, dated review, operator exit | Ratified requirement, not proof of a shipped generic watcher. |
| Conveyor pass daemon | Allowlisted pass, interval, lease (we:skills-src/conveyor/pass-daemon.mjs:77; we:skills-src/conveyor/daemon-manifest.mjs:142) | One probation pass across subjects, not one daemon per registry row. |
| launchd/systemd schedulers | Pure renderers over common configuration (we:scripts/lib/converge-daemon-schedulers.mjs:59) | Both can host the same review routine; placement is not an either/or decision. |
| Durable sampler job | Refuses corrupt job evidence and maintains one current job (we:scripts/conveyor/resource-sampler-daemon.mjs:33) | Reuse job ownership and bounded retry for slow sweeps. |
| Scheduled sweeps | Named review/report entry point (we:scripts/operations/scheduled-sweep.mjs:26) | Existing job list does not establish that probation is already installed. |

No external probation framework is needed to determine these local authority and identity contracts. Browser APIs do not implement operator-governed release probation. This work adds no web-standard entity.

## Standing test and classification

Evidence isolation survives as a correctness invariant; the encoding remains an implementation choice. Typed subjects, namespaced keys and compatibility adapters are acceptable when they preserve subject identity, revision and evidence scope. A stable display alias may point to an immutable evidence key. Reject representations that erase these distinctions or route non-model evidence through model graduation. At zero implementation cost, the merit distinction remains between isolated and conflated evidence.

Registry file partition, metric adapters and scheduler platform are configuration/placement details. Models, systems and rulings coexist in one registry. The tripwire action is settled for planner probation: file review, never disable. The model graduation statute supplies narrower precedents for exact model identity, role-specific criteria and each tuple's own eligible evidence; it does not prescribe generic system/ruling revision encoding. Under the [no-borrowed-evidence rule](../docs/agent/platform-decisions.md#supervision-no-borrowed-evidence), a recorded equivalence assessment cannot authorize cross-model or cross-triple graduation credit. [Planner clause 9](../docs/agent/platform-decisions.md#planner-build-plan-and-execute) supplies the planner's review and exit process only; extending that governance to other subjects remains this proposal. These concerns are recorded as Supported by default rather than padded into a fork table.

## Proposed state and review flow

Enrollment declares subject kind/id/revision, owner, metrics adapter and scope, baseline, tripwires, review timing, exit adapter and authority. Versioned policy lives in the repository, proposed beside the existing registry at we:scripts/lib/probation-registry.json; the operations coordination root holds cursors/filing receipts. A single source of truth backs the old model facade; no dual editable model declarations.

The deterministic sweep reads bounded evidence, evaluates allowlisted adapters and emits a report. A collector baseline may enroll but cannot produce a comparative pass. Unknown revisions, truncated reads, absent criteria and missed deadlines produce explicit review findings. Bounds proposed for the first build are 100 subjects and 8 MiB input per sweep; excess remains pending with a continuation cursor, never counted as reviewed. Evaluation makes no remote calls. Filing uses the shared backlog writer and stable subject/revision/criterion/window identity; a retry reconciles an already-filed card before creating another. A failed filer retains pending work.

The shared operator review routine consumes the same report, recommends continue/revise/exit, and records the explicit disposition. It preserves model graduation's independent critical-miss veto. The subject's operational setting, the ruling's status and probation disposition are separate writes, none performed by the watcher.

## Statute compatibility and related work

- [Model graduation](../docs/agent/platform-decisions.md#model-probation-graduation-criteria) and [no borrowed evidence](../docs/agent/platform-decisions.md#supervision-no-borrowed-evidence): preserve model-specific role criteria and exact provider/model/task-type eligibility. The 20-trial delivery threshold is not a system/ruling threshold; a recorded equivalence assessment cannot authorize cross-model or cross-triple graduation credit.
- [Planner build clause 9](../docs/agent/platform-decisions.md#planner-build-plan-and-execute): retain the planner's shadow baseline, weekly review tripwires, 30-day review after activation and operator exit. This clause authorizes planner review/exit only, not generic policies for every system or ruling.
- [Daemon jobs](../docs/agent/platform-decisions.md#daemon-jobs): slow reviews become durable jobs; ticks do not wait on them. This rejects putting the complete sweep inside build dispatch, without inventing a new scheduler fork.
- #6782 proposes an advisory-seat deadline pause and remains open. Its spending-control action is not authority for a generic watcher to disable systems; any such extension requires a distinct ruling. The two can share evidence/reporting.
- #6163 concerns feature dispatch through a probation worker. It does not generalise subject identity or replace the graduation bar.

## Follow-on verification

Keep old model status, graduation and trial tests; add persisted v1 migration, duplicate/version rejection, distinct model/system/ruling identity, and new-revision evidence isolation, equivalent encodings preserving subject/revision/scope, and no cross-model/triple graduation credit despite a recorded equivalence assessment. Watcher tests need incomplete/oversized data, bounded continuation, activation-date persistence, concurrent manual/scheduled dedup, crash-after-filing recovery, and no authority mutations on tripwire. The planner's first real dry sweep must expose insufficient evidence until its metrics/baseline exist. These are proposed acceptance tests, not assertions that tests were implemented during authoring.

## Files created or modified

| File | Action |
| --- | --- |
| we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md | Rewrite body; preserve frontmatter. |
| we:src/_data/researchTopics/probation-registry-generalisation.json | Add topic and relatedReport. |
| we:src/_includes/research-descriptions/probation-registry-generalisation.njk | Publish findings. |
| we:reports/2026-10-25-probation-registry-generalisation.md | This session artifact. |

## Verification boundary

Pure authoring; no registry migration, watcher installation, status change or promotion occurred. Fresh-context skeptic review retained evidence isolation with the encoding-independent and precedent-scope amendments above; the amended fork clears the two-confusion screen. Orchestrator stamping remains separate. The delivery response records the standards-check outcome, which does not prove runtime probation behavior.
