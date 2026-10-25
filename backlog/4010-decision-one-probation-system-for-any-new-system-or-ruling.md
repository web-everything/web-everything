---
bornAs: xzce0e8
kind: decision
parent: "3383"
status: open
dateOpened: "2026-09-23"
preparedDate: "2026-10-25"
preparedAgainstSha: "b19c459fd7ceb2705cde89206bcc02920ab83539"
tags: []
---

# One probation registry for models, systems, and rulings

## Digest

Generalise model probation into one subject registry, scheduled watcher, and review routine. The [research survey](/research/probation-registry-generalisation/) grounds one identity fork with **subject, revision, and evidence-scope isolation independent of encoding** as its default. Registry placement, scheduler adapters, system/ruling subjects, and tripwire reporting compose and are supported by default. Existing model graduation rules remain model-specific; the planner build is the first non-model subject. This is an authoring proposal, not a promotion, settings change, or ratification.

The axes are **subject identity** (we:scripts/lib/model-probation.mjs:87), **evidence eligibility** (:458), and **review scheduling/authority** ([planner probation clause 9](../../docs/agent/platform-decisions.md#planner-build-plan-and-execute)). The session artifact is `we:reports/2026-10-25-probation-registry-generalisation.md` (the topic's `relatedReport`).

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — evidence identity | (a) preserve subject + revision + evaluation scope across encodings | (b) synthetic model identities / (c) mutable subject ID that conflate evidence | High on isolation; illustrative wire shape requires migration validation |

## Fork 1 — What identifies the subject whose evidence earns trust?

**Fork-existence:** treating a system as a synthetic model violates the current model identity contract, while reusing an unversioned identity lets a changed subject inherit old evidence; either loses the distinction needed to justify an operator's exit decision.

Today `identityKey({provider, model})` is a provider/model pair, `statusFor` validates a role, and graduation groups exact provider/model/task-type evidence (we:scripts/lib/model-probation.mjs:87, :159, :458). A planner implementation revision and the ruling that requires it are distinct subjects: one can regress while the other remains sound. The [model graduation statute](../../docs/agent/platform-decisions.md#model-probation-graduation-criteria) supplies the non-inheritance precedent for models; extending revision isolation to systems/rulings is this proposal, not an assertion that the model-only rule already covers everything.

The [no-borrowed-evidence rule](../../docs/agent/platform-decisions.md#supervision-no-borrowed-evidence) keeps graduation credit inside the exact trust tuple's own record: a recorded equivalence assessment cannot authorize cross-model or cross-triple graduation credit. The model statute is a narrower precedent for identity isolation, not a generic subject policy. Likewise, [planner clause 9](../../docs/agent/platform-decisions.md#planner-build-plan-and-execute) authorizes the planner's review tripwires and operator exit only; extending that routine to other systems or rulings requires the subject-specific policies proposed here, not authority borrowed from the planner ruling.

- **(a) Preserve subject identity, pinned revision, and evidence scope independently of encoding. Recommended default.** A discriminated subject (`model`, `system`, `ruling`) is one suitable representation; other encodings may preserve the same distinctions. Preserve provider/model/role/task-type distinctions through a model adapter. A system names an immutable build or declared behavior revision; a ruling names its decision ID and ratified revision. Different revisions start separate evidence populations. Tradeoff: cross-revision comparisons require an explicit, recorded equivalence assessment; any non-model evidence reuse needs its own authorized subject policy, and the assessment never grants cross-model or cross-triple graduation credit.
- (b) Put every subject in the existing model shape, e.g. `provider: "system", model: "planner-build"`. It preserves the current file parser unchanged. **Rejected when distinctions are lost:** `roles` is limited to delivery/advisory-review, and the provider/model lookup has no system/ruling revision semantics (we:scripts/lib/model-probation.mjs:97). Widening those fields into tagged subjects is a migration to (a); a reversible namespaced encoding preserving subject/revision/scope is also valid under (a), provided it keeps non-model evidence outside model graduation.
- (c) One free-form subject ID whose baseline and definition are edited in place. It offers continuous history under a friendly name. **Rejected as the evidence key:** it silently compares new behavior against trials of an old definition; a passing aggregate can conceal a new revision's failures. A stable display alias may point to successive (a) records, but it cannot confer trust across them.

**Composability probe:** a compatibility facade can map model calls to typed model records and retain the old results. It cannot map a system into the old provider/model identity without either losing kind/revision/scope or changing that contract. Adding a revision discriminator to (c) yields (a). The invariant is encoding-independent: multiple representations may coexist as long as they preserve subject, revision, and evidence-scope distinctions, including the model adapter's exact identity and role/task-type distinctions. Display aliases and adapters can therefore coexist without conferring trust across records.

**Classification (seven-question pass):** (1) operational governance tooling, not standard runtime; (2) neither a browser protocol nor a UX intent; (3) support all subject kinds and kind-specific evidence adapters; (4) evidence isolation is an invariant, storage partition and metric choices are dimensions; (5) inject source readers, clock, and filer IO, keeping evaluation pure; (6) admit any well-described subject without weakening existing eligibility rules; (7) lifecycle reporting, model dispatch eligibility, and operator authority remain distinct. The identity defect persists if every alternative is free to build and maintain.

**Fork 1 (a), illustrative registry wire shape** — one schema instance preserving the invariant for the already-ratified planner shadow phase, not the only permitted encoding, a shipped API, or a claim that metrics exist:

```json
{
  "version": 2,
  "entries": [{
    "subject": {
      "kind": "system",
      "id": "planner-build",
      "revision": "planner-build-shadow-v1"
    },
    "owner": "4011",
    "state": "probation",
    "phase": "shadow",
    "metrics": { "adapter": "planner-build-records", "scope": "build" },
    "baseline": { "phase": "shadow", "state": "collecting" },
    "tripwires": [{ "id": "checker-miss", "metric": "confirmedCheckerMisses", "op": ">", "value": 0 }],
    "review": {
      "onEvent": "planBuild-on",
      "afterDays": 30,
      "timeZone": "America/Toronto"
    },
    "exitCriteria": { "adapter": "planner-build-review", "authority": "operator" }
  }]
}
```

Bind this declared behavior revision to the evaluated implementation commit in its evidence manifest; a behavior-changing build starts a new subject revision. On explicit activation, persist its event ID/time, freeze the shadow baseline's record range and digest, and derive a dated review 30 calendar days later at the same local time in `America/Toronto`, including daylight-saving offset changes. Never reset that date or recompute the frozen baseline on watcher restart or appended evidence. A collecting baseline is valid enrollment but insufficient evidence for a comparative verdict; file an evidence-gap finding instead. The example's zero-tolerance confirmed checker miss is a proposed review trigger, not automatic disabling. Other planner metrics (files, overruns, rework, panel findings, time, cost, delegation) are tracked by #4011; comparative thresholds are declared in the entry and require a pinned baseline before evaluation.

**Fork 1 (b), real compatibility constraint:** both shipped call shapes below must continue to mean model eligibility only. The new registry must not make a system's probation status satisfy either seam.

```js
import { liveStatusFor, readRegistry, statusFor } from './scripts/lib/model-probation.mjs';
const identity = {
  provider: 'codex', model: 'gpt-6-astra', role: 'delivery',
};
const status = statusFor(readRegistry(), identity);
const liveStatus = liveStatusFor(identity);
```

Keep both facade seams while migrating the model source of truth once. Verify persisted v1/v2 fixtures through `statusFor(readRegistry(io), identity)` and `liveStatusFor(identity, io)`. The live callers import `liveStatusFor`: we:scripts/operations/review-pr.mjs:257 aliases it as `liveProbationStatusFor`, and we:scripts/conveyor/run-quality-record.mjs:51 imports it directly. Preserve pair/role status separately from the graduation triple; neither may be inferred from the other's aggregate.

Skeptic: SURVIVES-WITH-AMENDMENT -- Subject, revision, and evidence-scope isolation survives independently of encoding; equivalence assessments cannot lend model graduation credit, and the model and planner precedents authorize only their narrower policies.

Screen: clear

## Supported by default (not decisions)

- **Registry location/shape:** use a versioned data registry, proposed `we:scripts/lib/probation-registry.json`, beside the existing model registry. One logical registry can be partitioned by subject kind; JSON versus per-kind JSON is an authoring/storage dimension, not a merit fork. Keep mutable watcher cursors and dedup receipts in the resolved operations coordination store, outside checked-in policy. The migration moves model declarations once; the old module becomes a facade or generated view, never a second editable authority. Reject conflicting duplicates and unsupported versions visibly; unknown identities remain unvalidated. Corrupt, truncated, missing or unreadable v1/v2 registry data must yield `unvalidated` through both model facade seams and a visible read diagnostic, never trust or an error-free empty-policy success.
- **Systems and rulings both qualify:** `kind` and revision keep their evidence distinct. A system's rollback, a settings change, and reopening a ruling have different authorities. Link a planner system entry to ruling #3922; do not couple their exits. The planner's already-ratified design probation provides the first system precedent; generic system/ruling enrollment and subject policies are this proposed extension, not a new mandatory probation ceremony for every historical ruling.
- **One scheduled watcher, portable scheduling adapters:** reuse the allowlisted pass mechanism (we:skills-src/conveyor/daemon-manifest.mjs:142) to schedule one probation sweep across subjects. Manual invocation calls the same sweep and shares its singleton/dedup state. launchd and systemd are adapters, not rival subjects or review engines (we:scripts/lib/converge-daemon-schedulers.mjs:59). A sweep too slow for a tick runs as a durable job under [daemon-jobs](../../docs/agent/platform-decisions.md#daemon-jobs); it must not block build dispatch or run once per lane.
- **Tripwire-fired action:** file or update one review card keyed by subject/revision/criterion/evidence window; include measurements, baseline, provenance, and proposed review disposition. Never toggle a setting, disable a system, promote a model, or reopen a ruling automatically. Planner clause 9 settles review and exit for the planner only; adopting this generic routine requires explicit subject policies. Due-date expiry also requests review; silence is not a successful trial or an automatic exit.
- **One review routine with subject adapters:** produce `continue`, `revise`, or `exit` recommendations and evidence-gap findings; only the operator records the disposition. Model eligibility still requires the model statute's trial mix, independent veto, role authority, and exact identity. Its delivery numbers (20 verified trials, one informative trial, zero critical misses, comparable rating) do not become universal thresholds for systems/rulings. Registry adapters are allowlisted identifiers, never executable strings from metrics or card text.
- **Incomplete evidence:** missing, stale, truncated, wrong-revision, or unreadable evidence cannot produce a pass or exit recommendation. Report `insufficient-evidence` with the failing source and a manual re-run/repair action. Continue unrelated subjects within a bounded batch; retain a cursor and expose backlog/overdue age. Proposed bounds are 100 subjects and 8 MiB input per sweep, zero remote calls in evaluation; enforce the byte budget at the reader, including oversized single records, rather than reading the full source before deferring. Overflow defers visibly and cannot be marked reviewed. Filing uses the shared backlog writer and an atomic receipt so retries do not duplicate cards. Validate cursors and receipts against the current subject/revision/window and reconcile claimed filings against matching backlog cards. Missing, corrupt, stale or inconsistent state visibly rebuilds from a safe pending position within the same bounds; an unverified receipt or cursor cannot suppress due review. Reuse the shared durable-job record reader's corruption refusal where applicable. Existing runtime eligibility is not changed by watcher failure.

## Context

### Known occurrences and current limits

| System | Shipped or ruled evidence | Consequence |
| --- | --- | --- |
| Model probation | we:scripts/lib/model-probation.mjs:123 normalizes declarations; :212 reads malformed data as empty; :458 reports graduation progress. we:scripts/lib/model-probation.json:1 persists v1 declarations. | Reuse validation/status/report seams; do not infer generic subject support from the module name. |
| Planner design probation | we:docs/agent/platform-decisions.md:5679 requires shadow baseline, weekly tripwires, review 30 days after activation, and operator exit. Historical call: we:backlog/3922-decision-the-planner-build-g2-a-planner-splits-a-build-into.md:269. | First non-model subject; #4011 is still open and blocked by #4010/#4004, so no invented baseline or activation date. |
| Dispatcher model rollout | we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md:2554 records the original provider/model registry rollout. | History corroborates the seam; the named statute anchor, not the epic log, governs authority. |
| Pass daemons and durable sampler job | we:skills-src/conveyor/pass-daemon.mjs:77 defines per-pass leases; we:scripts/conveyor/resource-sampler-daemon.mjs:33 refuses corrupt job records and enforces one current sampler job. | Reuse scheduled work and durable ownership, not a bespoke polling process per subject. |
| Advisory-seat exit proposal | we:backlog/6782-probation-exit-report-scheduled-job-that-proposes-promote-ke.md:12 proposes report-and-pause at a deadline; status remains open (:5). | Its automatic pause is not standing authority. Reuse report evidence, but keep any seat-specific spending pause separate from the generic watcher and require its own ruling. |

No browser primitive supplies operator-governed probation. This is repository operations tooling, not a new plug, block, intent, or vocabulary entry in the web standard. No external framework comparison is needed to override the stronger in-repo lifecycle and job precedents.

The current model reader's empty fallback is fail-closed because `statusFor` defaults to `unvalidated` (we:scripts/lib/model-probation.mjs:159), and `liveStatusFor` composes that lookup with the reader (:239). Empty declarations do not mean exemption from probation. The proposed v2 reader must preserve this result and add a visible read diagnostic; the current fallback alone is not evidence that v2 corruption handling has been implemented.

### Proposed delivery and review boundary

Predicted touch-set: `we:scripts/lib/model-probation.mjs`, proposed `we:scripts/lib/probation-registry.json`, model migration/tests, a shared probation evaluator/sweep, `we:skills-src/conveyor/daemon-manifest.mjs`, and #4011's metrics producer. Keep the generic registry/sweep build separately scoped from that planner producer. Draft reusable rule for later codification: subject identity and revision bind evidence; the shared watcher proposes review; subject-specific rules determine eligibility; only an explicit operator disposition ends probation. Extend the existing probation anchors rather than duplicating or weakening them.

## Risks

The migration can regress live seat eligibility even when the pure lookup passes; test both facade seams with old and new persisted state. Moving baselines or reusing a behavior revision for another commit can contaminate comparisons; pin activation and provenance independently. One broken subject or a damaged cursor/receipt can silently stop review of healthy or overdue subjects; require mixed-subject fixtures and visible reconciliation. Reading an entire oversized source before rejecting it defeats the bound; assert actual IO ranges and byte counts. Planner records depend on open #4011, so real integration is that producer's later acceptance, separate from the fixture-based watcher build gate.

## Test plan

Done when #3 is the guarantee-to-test manifest: every entry names the proposed file/case and its observable assertion. These are planned follow-on tests, not existing coverage. The generic watcher uses injected readers, clock, filer and a temporary coordination store, plus one CLI dry-run fixture using real temporary files. This allows acceptance before #4011. The producer's real-record integration is owned by #4011 and cannot be claimed from the generic fixture. The authoring gate checks this preparation only.

Review prevention is filed as #xezensp: caller-symbol citations, normative guarantee mappings, two-subject isolation, independent activation-state assertions, dependency-safe acceptance and corrupt scheduled-job state. It reuses the existing #5473/#3528 gate work; these checks are not claimed implemented here.

## Done when

1. **Authoring executable:** use `we:scripts/readiness/heavy-admission.mjs` to check this card and its research artifacts; a green authoring gate implies no runtime graduation.

   ```sh
   node scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards
   ```

2. **Ratification result:** record the operator's identity choice, codify only the approved extension, and scope the registry/watcher build plus #4011's planner entry. No stamp or status change is part of this preparation.
3. **Migration executable:** the follow-on runs `we:scripts/lib/__tests__/model-probation.test.mjs`, `we:scripts/lib/__tests__/model-probation-graduation.test.mjs`, and `we:scripts/lib/__tests__/model-probation-trials.test.mjs` against persisted v1/v2 fixtures, then adds scoped registry/sweep tests. Planned named cases (not existing coverage):

   ```sh
   npm run test:unit -- scripts/lib/__tests__/model-probation.test.mjs scripts/lib/__tests__/model-probation-graduation.test.mjs scripts/lib/__tests__/model-probation-trials.test.mjs
   ```

   - `we:scripts/lib/__tests__/probation-registry.test.mjs::new-revision-inherits-no-trust` — a new revision receives no prior revision's baseline, trust or eligible evidence.
   - `we:scripts/lib/__tests__/model-probation-graduation.test.mjs::equivalence-assessment-grants-no-cross-model-or-triple-credit` — adding a recorded assessment leaves other models' and task triples' eligible trial counts unchanged.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::aliases-confer-no-trust-and-lossy-facades-are-rejected` — alias lookup grants no credit and an encoding losing kind/revision/scope is rejected.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::v1-v2-facade-parity-system-status-never-satisfies-model-eligibility` — persisted v1/v2 fixtures give identical model results through both `statusFor(readRegistry(io), identity)` and `liveStatusFor(identity, io)`, including probation/trusted/unvalidated, both supported roles, unknown identities, and a same-display-ID system with trusted state that grants no model eligibility. Exercise the actual imported live seam, not a status stub.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::pair-role-and-triple-status-never-inferred-from-each-other` — changing one role's status or one triple's evidence leaves the others' results unchanged.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::equivalent-encodings-preserve-subject-revision-scope-and-ruling-system-separation` — lossless encodings evaluate identically; equal display IDs across model/system/ruling remain separate populations.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::migration-leaves-one-editable-authority` — migrating v1 once leaves the old source as a facade/generated view and later reads use only the canonical declarations.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::conflicting-duplicates-rejected-visibly` — conflicting rows produce a diagnostic and no eligibility grant.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::unsupported-schema-rejected-visibly-and-unknown-identities-unvalidated` — unsupported versions produce a diagnostic; unknown identities return `unvalidated` through both seams.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::corrupt-registry-read-fails-closed-not-empty` — malformed JSON, truncated JSON, missing files and thrown read/permission errors for v1/v2 yield a visible read diagnostic and `unvalidated` through both seams for previously declared and unknown models; no case yields trusted/probation eligibility or error-free empty-policy success. A valid empty registry also leaves unknown identities unvalidated.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::activation-freezes-baseline-and-derives-review-date` — persist the activation event ID/time, exact baseline record range/digest and initial deadline; `2026-10-25T12:00:00-04:00` derives `2026-11-24T12:00:00-05:00`. Appending records and restarting leaves each persisted field unchanged.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::restart-never-resets-activation-review-date` — repeated restarts and activation-event replay preserve the original deadline without extending probation.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::revision-manifest-binds-evaluated-commit` — matching revision/commit manifests admit only their scoped evidence; a different implementation commit using the same behavior revision yields an evidence-gap diagnostic and no pass, requiring a new revision for changed behavior.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::cursor-and-receipts-live-outside-checked-in-policy` — capture every state write during progress, filing and restart; destinations are under the resolved temporary coordination store, and both policy files' bytes remain unchanged with no cursor/receipt fields added.
   - `we:scripts/lib/__tests__/probation-registry.test.mjs::planner-links-ruling-with-independent-exits` — the planner entry references #3922; an operator disposition on the system leaves the ruling's probation unchanged and vice versa.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::singleton-sweep-never-blocks-dispatch-or-runs-per-lane` — concurrent manual/scheduled runs in separate lane fixtures share one lease; a slow sweep becomes a durable job while dispatch returns without waiting.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::tripwire-writes-review-card-only-no-settings-disable-promote-or-reopen-authority` — a fired tripwire writes measurements, baseline, provenance and disposition proposal under its subject/revision/criterion/window key; spies observe no setting, system-disable, model-promotion or ruling-status writes.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::deadline-or-silence-never-exits-probation-without-operator-disposition` — expiry files review with overdue age; silence leaves probation unchanged, and only a recorded operator disposition can exit.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::metrics-and-card-text-never-execute-adapters` — unknown adapter identifiers and executable strings in metrics/card text are refused; execution spies stay untouched.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::model-trial-veto-role-and-identity-rules-not-universal-thresholds` — model fixtures retain their trial mix, critical-miss veto and role/exact-identity gates; system/ruling fixtures use their own authorized criteria rather than the model's 20-trial bar.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::missing-stale-truncated-wrong-revision-unreadable-or-collecting-baseline-yields-insufficient-evidence-with-repair-not-pass-or-exit` — each failure variant reports its source, `insufficient-evidence` and manual repair/re-run action, without pass/exit or a completed-review marker.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::failed-subject-preserves-unrelated-results` — for each evidence-failure variant above, put the bad subject first and a healthy due model/planner subject second within the budget, then reverse the order; assert both the bad subject's finding and the healthy subject's completed evaluation and proposed review card in the same batch.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::101-subjects-or-over-8MiB-defers-visibly-with-cursor-and-overdue-age-never-reviewed` — exactly 100 subjects/8 MiB fit; excess remains pending with a continuation cursor, deferred count and overdue age, and no reviewed marker; resuming evaluates the deferred work.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::bounded-read-never-exceeds-8MiB` — instrument actual bytes returned and requested read ranges across all sources, including one oversized file and one oversized single record; total input read is at most 8 MiB (8,388,608 bytes), with no unbounded full-file read, and deferred work is visible rather than reviewed. A chunk ending mid-record yields insufficient evidence, not a partial pass.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::evaluation-makes-zero-remote-calls` — injected network-call spies record zero calls while evaluating every subject kind.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::manual-scheduled-and-crash-after-filing-before-receipt-dedup` — retry after a crash between filing and receipt persistence, plus concurrent entry points, finds one matching card and one reconciled receipt per key.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::corrupt-receipt-or-cursor-reconciles-against-backlog-not-trusted` — missing, malformed, stale and inconsistent state, including a syntactically valid receipt naming a nonexistent or wrong-key card and a cursor past a due subject, produces a visible diagnostic and bounded reconciliation/rebuild. The due subject still gets review; an existing matching card is reused, no duplicate is filed, and failed reconciliation stays pending. Exercise the shared job-record reader's corruption refusal where used.
   - `we:scripts/lib/__tests__/probation-sweep.test.mjs::watcher-failure-preserves-runtime-eligibility` — evidence-read/evaluation/filer failures leave model declarations and both facade results unchanged, report pending work, and do not block dispatch.
4. **Watcher executable, generic build:** the follow-on runs the scoped sweep test through `npm run test:unit`, including planned `we:scripts/lib/__tests__/probation-sweep.test.mjs::dry-run-fixture-exposes-evidence-and-pending-planner-without-writes`. That case runs the real manual sweep CLI against temporary on-disk model/planner fixtures and a temporary coordination root. Assert evidence source, frozen baseline range/digest, explicit deadline for an activated fixture, awaiting-activation for a shadow fixture, proposed review card, and zero policy/backlog/operator-action writes in dry-run mode. An absent planner producer yields `insufficient-evidence` with repair action while the healthy model still evaluates. This build gate is runnable without #4011.

### Planner integration handoff (owned by #4011)

After its producer lands, planned `we:scripts/lib/__tests__/planner-probation-integration.test.mjs::real-planner-records-dry-sweep` runs the same CLI over the producer's real records and asserts source/commit binding, baseline range/digest, dated review or awaiting-activation, and proposed card without operator writes. Until #4011 supplies those records this acceptance is explicitly pending on #4011; it is not a Done-when requirement or a claim of verified planner integration for the generic watcher build.

### Review jury (provisional — pre-registered #2638)

Care level: `high`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| correctness#2 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| security#2 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| simplicity#2 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| standards-conformance#2 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
| claim-accuracy#2 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
