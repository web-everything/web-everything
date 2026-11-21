---
bornAs: xw26745
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "1a9467e1184bec1fb2a9df78f3f52d13c40dd0c1"
tags: []
---

# Prevention — Cover CI-heal routing refusals and retain ownership until wrapper termination

Filed from the approval of chalbert/web-everything#3577. Preserve both prevention goals: cover refusal propagation through `routeAvailableCiHeal`, and prove that the age ceiling cannot release ownership or permit another launch while the original wrapper remains alive.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3577@e23f1963f2a7bef4d772ad99fd4ced26a33c3c43

## Progress

- Original premise/scope: a routing matrix at the historical `we:scripts/operations/ci-heal-pr-dispatch.mjs:182` and an observer/provider regression, across the two source files and their two matching tests. Corrected premise: the routing boundary now starts at `we:scripts/operations/ci-heal-pr-dispatch.mjs:189`; it calls `resolveDispatchRoute` from `we:scripts/lib/dispatch-routing-policy-io.mjs:71`, which reaches the private legacy router through `we:scripts/lib/dispatch-contracts.mjs:1361`. The legacy router is not directly exported. Size-policy validation is at `we:scripts/lib/dispatch-contracts.mjs:1162`, profile validation at `we:scripts/lib/dispatch-contracts.mjs:1220`, and router refusal propagation at `we:scripts/lib/dispatch-contracts.mjs:1231`.
- Existing coverage is partial, not delivery of this goal: `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs:664` covers quota routing, empty scope, critical scope and unreadable evidence, but not the requested full refusal matrix. The production boundary only forwards kind, scope and reason, so profile/size-policy faults require controlled dependency fixtures rather than claiming ordinary callers can supply those options.
- The ownership premise needs an implementation correction, not tests alone: `we:scripts/operations/probation-heal-run.mjs:192` settles over-age rows before probing liveness; `we:scripts/operations/probation-heal-run.mjs:152` releases the claim during settlement. Existing expectations at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:717` explicitly resolve an aged live PID or foreign host. The unreadable-row branch at `we:scripts/operations/probation-heal-run.mjs:230` also removes a known PR's hold based only on age; its expectation at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:739` must change.
- Corrected touch set remains the four scoped files: add a small routing dependency seam, correct age-based observer/poll behavior, and extend both matching tests. Read-only callers are `we:scripts/operations/dispatch-lane-io.mjs:2911` (provider observer), `we:scripts/operations/ci-heal-pr-dispatch.mjs:260` (direct launch hold), and `we:scripts/operations/ci-heal-pr-dispatch.mjs:581` (reconcile hold). Exercise these callers rather than changing their defaults.
- Retain size 3: approximately 10–20 changed lines in the routing boundary, 25–45 in observer/poll logic, 70–100 in routing tests, and 100–150 in ownership tests, grounded in the seams and existing harness at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:451`. This is a story; no estimatedLoc field. No stamp is authored by this preparation worker.

## Design

Add an optional injected route resolver to `routeAvailableCiHeal`, defaulting to its current imported resolver. Preserve production arguments and quota reads. Build a table of empty scope, invalid profile, no candidate model, and invalid size policy. Exercise real routing wherever the boundary's inputs reach the branch; for otherwise unreachable configuration faults, inject a resolver that invokes the public `decideDispatchRoute` with the specific invalid options/profile. A synthetic no-candidate refusal may test boundary propagation, but label it explicitly and pair it with the real router's refusal contract; do not claim a fabricated result traverses the private branch.

Keep the existing empty-scope native fallback after checking native quota; nonempty-scope refusals stay refused and become held at `dispatchCiHeal`, with no provider call. Pin routing policy/builder state in fixtures. Preserve the current builder-dependent native fallback for exhausted probation candidates; do not invent a new routing policy.

For nonterminal attempts with a bound wrapper, age is diagnostic evidence only. Check ownership and liveness before synthesizing an orphan failure: same-host live stays running; unknown liveness, failed probes, or foreign-host ownership stay unresolved. Only a positively dead owned wrapper past startup grace can settle as an orphan. Preserve explicit terminal publication and confirmed no-process launch failures. Do not add automatic process killing or treat sending a signal as termination evidence.

For unreadable persisted rows whose repo/PR can still be recovered, retain that PR's unresolved hold regardless of age. Keep the warning as the operator-visible escalation: inspect/terminate the owned wrapper and restore evidence before retrying. Do not infer an owner for unidentifiable corrupt data or widen this item into a recovery protocol. Existing valid settled rows remain history; do not reopen them or migrate their status.

## MVP

1. Extend the existing quota suite in `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` with named refusal rows, the default-resolver control, and end-to-end held/native sink assertions. Add only the injection seam needed in `we:scripts/operations/ci-heal-pr-dispatch.mjs`.
2. Correct observer and recoverable corrupt-row age handling in `we:scripts/operations/probation-heal-run.mjs`. Forward the poll's injected clock into observation so deterministic time controls both layers.
3. Extend the real attempt/claim harness in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`: bind a wrapper, advance beyond the ceiling, observe via the provider adapter and poll, attempt a second dispatch, then change liveness to confirmed dead and repeat. Replace the explicitly contrary aged-row assertions with the new ownership expectations.

## Acceptance

- [A1] Executable — Proposed test `4944 routing refusal matrix` in `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` must fail without the injection seam and pass after: empty scope uses native only when its quota is available; invalid profile, no-candidate and size-policy refusals for nonempty scope are held with no sink call. Assert refusal reasons and acquired-claim cleanup. Include source, docs, config, data and mixed scope fixtures; no nonempty refusal gains an empty-scope exemption.
- [A2] Executable — Proposed test `4944 default routing and unreadable evidence` in `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` validates omitted resolver versus explicit production resolver, held native quota, and throwing/malformed evidence. Run it with A1 as the red/green routing suite: the pre-build suite fails A1; the completed suite passes both. Existing routing defaults and full supervision remain intact.
- [A3] Executable — Proposed test `4944 aged live wrapper blocks observer and relaunch` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs` fails against current age settlement and passes after: at the ceiling and beyond it, repeated provider observation and polling retain the claim, publish nothing, and both direct dispatch and reconcile make zero additional launches. A subsequent confirmed-dead observation settles and releases once; repeating observation does not republish or release again.
- [A4] Executable — Proposed test `4944 aged uncertain ownership remains held` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs` fails against current age settlement/hold removal and passes after: unknown/throwing liveness, foreign host and recoverably corrupt persisted rows remain unresolved beyond the ceiling, retain ownership, block relaunch and expose a diagnostic. Include old persisted rows without optional fields; preserve explicit terminal and no-process failure controls.

## Test plan

Run only the two matching suites through the host heavy queue. From the WE root, use the following shell form to keep every authored path repo-qualified while passing real relative paths to Node/Vitest:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
routing=we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs
ownership=we:scripts/operations/__tests__/probation-heal-run.test.mjs
node "${queue#we:}" run -- npx vitest run "${routing#we:}" "${ownership#we:}"
```

Use temporary state beneath the task TMPDIR and injected clocks, liveness probes, routing settings, publication and launch sinks. Never spawn a real worker, call GitHub, or kill a host process. Keep original non-age settlement and quota controls. If admission is busy, wait once using the queue's supported bounded wait, then report rather than poll.

## Proof plan

During implementation, first add A3/A4 against the unchanged observer and record their failing ownership/launch assertions. Add A1 against the old boundary to demonstrate the missing seam, then implement and capture passing results for A1–A4 with the queued command above. Report exact selected test names and counts, not a green run that selected no tests. For test-only coverage of already-correct routing defaults, demonstrate sensitivity by temporarily removing the refusal/quota guard and observing the new matrix fail, then restore it; do not claim those controls were production defects.

Review the final diff against the four-file scope and prove retained claim ownership using the real temporary claim store, not only a settlement spy. Run the runner-owned standards/preparation checks after the card edit; this worker does not stamp or run a second review loop.

## Follow-ups

Automatic termination, cross-host process identity recovery, and repair of completely unidentifiable corrupt attempt rows are separate work if needed. This item retains ownership and emits actionable evidence while termination cannot be confirmed. No routing roster, quota policy, release protocol, or already-settled history changes are proposed.
