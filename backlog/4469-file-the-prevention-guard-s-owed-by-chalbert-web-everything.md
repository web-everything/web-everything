---
bornAs: x4lc8cv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-mutation-check.mjs", "we:scripts/conveyor/__tests__/build-dispatch-mutation-check.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-14"
preparedAgainstSha: "308b7213023446e7cf6e4e8146a99f6fe922da77"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2924's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-policy.mjs:254` (current mutation target; the original test citation has drifted) — A deterministic mutation testing gate (e.g. Stryker) that automatically mutates RHS assignments like `busy = running.length` to `busy = 0` and demands at least one test redden.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2924@0909cb6c87580dcf2f4ff3c8f28af30af3910b2d

## Design

Add a focused, deterministic mutation gate at planned `we:scripts/conveyor/build-dispatch-mutation-check.mjs`. Follow the injected runner / structured Vitest report approach in `we:scripts/conveyor/guard-1c-mutation-check.mjs`, without expanding it into a general mutation framework or adding Stryker. The default manifest contains one required mutation: replace the unique `const busy = running.length;` with `const busy = 0;` in `we:scripts/conveyor/build-dispatch-policy.mjs:254`.

Run the selected behavioral tests unmodified first, then run the same tests against the mutated module. Require all selected baseline tests to pass and at least one specifically named behavioral assertion to fail in the mutant. A process exit alone is not proof of a kill. Missing/duplicate mutation anchors, unreadable source, missing/skipped tests, malformed reports, import errors, spawn failure and timeout all refuse success with a diagnostic and nonzero exit. A surviving mutant also fails.

Keep scratch source, config and JSON output under task `TMPDIR`, with cleanup in finally. Resolve the original module's relative imports to their original locations and alias only the policy module to its scratch mutant; never rewrite the checkout. Use argv spawning, sequential baseline/mutant execution, a 120-second child timeout and 4 MiB output bound. On either bound, report incomplete evidence and instruct the operator to investigate and rerun through heavy admission; never count termination as a kill. Inject child execution and source/report IO for hermetic gate tests.

No production defaults, persisted state or dispatch callers change. The new gate defaults to the single required mutant and refuses an empty manifest. The existing executor-class scheduling behavior remains authoritative; this mutation guards reported `busy`, not the separate capacity calculation.

## MVP

1. Add the gate and its direct CLI entry point, exporting the manifest and injectable orchestration for tests.
2. Add explicitly named `busy mutation witness` cases in `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs`: one running build reports one, duplicate records report one, and distinct executors report the total distinct builds. Assert returned values through the real planner, not copied arithmetic. Retain existing capacity and external-building cases.
3. Add `we:scripts/conveyor/__tests__/build-dispatch-mutation-check.test.mjs` covering orchestration, manifest defaults, negative evidence and scratch cleanup. The CLI is the focused executable gate; broad CI rollout is outside this item.

## Acceptance

Commands below run from the WE repository root. Repo-qualified variables identify paths; shell prefix removal converts them into runnable repository-relative arguments.

- [A1] **Executable** — Run the gate command below. Before implementation its entry point is absent; afterward it reports a passing baseline and the default `busy = 0` mutant killed by a named witness, exiting zero. The unchanged/no-op mutant must survive and be rejected by the named `rejects surviving and no-op mutants` test.
- [A2] **Executable** — Run the unit command below: planned cases `requires exactly one anchor and a nonempty default manifest`, `refuses unreadable source and incomplete reports`, and `rejects load errors skipped witnesses and failed baseline` must pass. These new cases fail before the gate implementation exists; they ensure the default target and every evidence refusal cannot silently pass.
- [A3] **Executable** — Run the unit command below: planned cases `bounds child runtime and output`, `cleans scratch after success and failure`, and `aliases only the target and preserves checkout bytes` must pass. They fail before implementation and verify diagnostics, cleanup and source isolation, including timeout and oversized-output paths.
- [A4] **Executable** — Run the unit command below: planned `busy mutation witness` cases must pass on real source (they are green before the build, so they are supporting evidence only; the existing assertion at `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:429` already kills this mutant). The red-before-build proof is A1–A3; A1 must show the mutant killed with a non-empty failed-assertion title and message in the structured report. Include `preserves existing policy defaults and executor capacity` in the gate tests to verify baseline execution uses the repository configuration without changing planner defaults or callers.

Gate command:

```sh
admission=we:scripts/readiness/heavy-admission.mjs
gate=we:scripts/conveyor/build-dispatch-mutation-check.mjs
node "${admission#we:}" run -- node "${gate#we:}"
```

Unit command:

```sh
gateTests=we:scripts/conveyor/__tests__/build-dispatch-mutation-check.test.mjs
policyTests=we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs
npm run test:unit -- "${gateTests#we:}" "${policyTests#we:}"
```

## Test plan

Map A1–A4 to the named cases above. Inject structured baseline and mutant reports to cover passing, failed, skipped, missing and malformed evidence separately. Inject source with zero/two anchors and an empty manifest. Inject spawn errors, timeout and output overflow; assert nonzero refusal and an operator-visible rerun diagnostic. Exercise actual scratch setup and cleanup with a stub child, checking original source bytes and non-target import resolution. Run the real gate separately through heavy admission to prove the runner reaches the production planner and observes an assertion failure rather than a module-load failure.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no LLM, PR or card text reaches argv, a path or a regex; the manifest is static and child argv is a fixed array.
2. **Truncated reads** — child output is bounded at 4 MiB; overflow is an incomplete-evidence refusal, never a kill (A3 `bounds child runtime and output`).
3. **Shared state files** — n/a: scratch lives in a per-run `TMPDIR`; no shared state is written.
4. **Fail closed** — duplicate/missing anchor, unreadable source, malformed/missing report, skipped witness, load error, failed baseline, timeout and spawn failure all exit nonzero with a named reason (A2, A3).
5. **Identity scoping** — the alias targets only the policy module path; other imports resolve to originals (A3 `aliases only the target`).
6. **State over time** — scratch removed in `finally` after success and failure; no state survives a restart (A3 `cleans scratch`).
7. **Who wrote it** — n/a: no comment, label or ref grants trust.

## Proof plan

Record the focused unit command and real gate command, exit statuses, baseline witness names and mutant assertion failure. Demonstrate red/green for the gate's own acceptance by supplying a no-op mutant in its hermetic test: baseline stays green, mutant survives, gate refuses. Save the real mutation result with the exact source revision. Verify checkout bytes are unchanged by both successful and failed runs. A pre-existing behavioral assertion alone is not evidence that automatic mutation is delivered. Preparation changes only this card; the runner owns preparation stamps and checks.

## Follow-ups

Consider additional independently justified mutation targets and wider CI integration after measuring this focused gate's runtime. Neither framework adoption nor repository-wide mutation coverage is required here. No dependency-edge change is proposed.

## Progress

- Original premise/scope: the historical citation at line 58 of `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs` implied that a test-only change could supply an automatic RHS-mutation gate.
- Corrected premise: `we:scripts/conveyor/build-dispatch-policy.mjs:254` still assigns `busy = running.length`, but lines 256–259 calculate executor capacity independently. The existing test at `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:426` already asserts a positive busy count at line 429. Thus behavioral coverage exists; automatic mutation execution and trustworthy kill classification remain the deliverable. The current line 58 belongs to the open-PR-count test, not this guard.
- Source precedent: `we:scripts/conveyor/guard-1c-mutation-check.mjs` implements targeted baseline/mutant runs and structured assertion checks; `we:scripts/conveyor/__tests__/guard-1c-mutation-check.test.mjs:34` and line 65 cover survivors and load failures. This is an implementation pattern, not evidence that the dispatch mutation is already delivered. The separate incident scenario in `we:scripts/conveyor/soak/breaks/builder-cap-counts-machine-wide-building.mjs` uses zero own in-flight builds, so it cannot distinguish this zero-assignment mutant.
- Corrected scope: add the focused gate plus its matching unit test, and extend the existing policy test with named witnesses. The production policy module is read/mutated in scratch only, so it is not in the edit touch set. Retain size 3: approximately 120 changed lines for the gate, 110 for gate tests and 25 for policy witnesses (255 total across three files). This is a story; no estimatedLoc field is added.
- No runtime tests were run during this card-only preparation. All cited behavior above is source evidence; actual mutation proof is explicitly owed by the build.
- Re-verified (2026-11-06, 11-10, 11-14; latest origin/main 432c945266): `busy = running.length` still at `we:scripts/conveyor/build-dispatch-policy.mjs:254`, gate file still absent, policy, its test and guard-1c precedent unchanged since the prior stamp. Design/MVP/Acceptance stand; stamp refreshed.
