---
bornAs: xufxie2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/probation-routing.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "9120f36477d4e19d13d46eada0162ebbd9b2e7d6"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2994's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Add the missing bugfix statute-path, over-envelope and veto regression cases beside the existing selector cases at `we:scripts/lib/__tests__/probation-routing.test.mjs:90-99`. Retain the roster-wide matrix as a follow-up, with explicit per-task exceptions.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2994@3c2d71e69003338e32d7e6f60f8d6745f1d2a3e2

## Design

This is test debt, not a routing-policy change. Extend only `we:scripts/lib/__tests__/probation-routing.test.mjs`, exercising the real `selectProbationWorker` and its `selectProvider` caller without mocking their guards. Reuse the existing `open` context and imported worker/model constants. Give every negative case an eligible positive control so an unrelated refusal cannot satisfy the assertion.

The current bugfix envelope is 250 LOC and four files (`we:scripts/lib/provider-routing.mjs:206`). Assert acceptance at both limits, then independently exceed LOC and file count. Statute fixtures must reach the selector as repo-relative runtime strings; use the statute path represented by `we:docs/agent/platform-decisions.md`, removing the locus prefix in the fixture. Assert the specific refusal reason as well as a null worker.

For vetoes, use `simple: true` to make all three bugfix workers eligible. Resolve Claude's model at the explicit Sonnet tier, use `CODEX_MODEL` for Codex and `AGY_GEMINI_SIMPLE_MODEL` for Gemini. Veto each exact provider/model/taskType triple individually and prove another eligible worker is selected; veto all three and require null plus the exhaustion reason. Change one triple coordinate at a time to prove unrelated vetoes do not suppress the original candidate. Assert the vetoed candidate audit entry, not merely a different winner.

At the caller, pass vetoes through `criticalMisses`, as production does. Confirm statute, over-envelope, all-vetoed, missing verdict and missing critical-miss evidence yield no probation worker and retain the Claude recommendation. Check the refusal audit for selector failures. No defaults, persisted state, worker order, models, or production callers change.

## MVP

**Must:** add three named bugfix regression groups described in Acceptance, covering direct selector guards and caller propagation. Keep existing positive bugfix and critical-work assertions intact. One test-file change; no runtime changes or new infrastructure.

**Could:** generalize the refusal cases over the whole roster after these targeted guards land; this is outside the MVP.

## Acceptance

Use the command in Test plan with the corresponding group name. Its discovery assertion fails on the current tree because the named regression group is absent; after implementation both discovery and behavioral tests must pass. A passing baseline suite alone is not evidence of new coverage.

- [A1] **Executable** — group `4543 bugfix statute refusal`: eligible ordinary scope selects a worker; statute scope returns null with a statute reason, and the caller retains Claude with a refusal audit.
- [A2] **Executable** — group `4543 bugfix envelope boundaries`: exactly 250 LOC/four files is eligible; 251 LOC and five files independently refuse with an envelope reason, both directly and through the caller, which retains Claude.
- [A3] **Executable** — group `4543 bugfix veto and closed caller`: each exact triple is excluded with a veto audit; mismatched triples remain eligible; all eligible workers vetoed returns null and an explanatory reason. Caller forwarding of `criticalMisses` preserves the refusal and Claude fallback; missing verdict or missing miss-list evidence also closes probation. Existing default Codex/full-review behavior remains covered.

## Test plan

Run from the WE checkout, substituting each Acceptance group for the final argument. Prefixes are stripped only at command execution, so authored file references retain their repository locus. The first command asserts discovery and prevents a filtered run with no matching new tests from being mistaken for proof.

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; import assert from "node:assert/strict"; assert(readFileSync(process.argv[1].replace(/^we:/, ""), "utf8").includes(process.argv[2]), "missing regression group")' we:scripts/lib/__tests__/probation-routing.test.mjs '4543 bugfix statute refusal'
queue=we:scripts/readiness/heavy-admission.mjs
tests=we:scripts/lib/__tests__/probation-routing.test.mjs
node "${queue#we:}" run --wait-ms=60000 -- npx vitest run "${tests#we:}"
```

Run the complete affected file once after all groups are added. Use only the host queue; if admission remains busy after the single bounded wait, stop and report. No full suite is needed for this isolated test addition. The runner owns standards checks and preparation stamps.

## Proof plan

Record the pre-build missing-group discovery failures and post-build affected-file result with test counts. Since production already enforces these guards, do not claim the existing implementation fails the new behavioral tests before the build. Prove sensitivity during implementation with temporary mutations in a disposable copy under the task TMPDIR, never the delivery checkout: bypass statute refusal, bypass envelope refusal, disable exact-triple veto filtering, and omit caller veto forwarding, one at a time. Each corresponding new group must fail; restore every mutation and obtain a final green affected-file run. Mutation source is `we:scripts/lib/provider-routing.mjs:402-405`, `we:scripts/lib/provider-routing.mjs:391`, and `we:scripts/lib/provider-routing.mjs:965`; locate by symbol before editing if lines move. No mutation is part of the delivery diff.

## Follow-ups

A table-driven matrix over every `PROBATION_ROSTER` key should automatically include new rows. Design it with valid per-row fixtures and positive controls: `test-fix` requires test-only paths, Argon needs explicit injected settings, and `ci-heal` deliberately defers envelope enforcement to the launcher. Do not make all rows refuse oversized pre-run estimates: that would contradict `we:scripts/lib/provider-routing.mjs:403`. Pair the later ci-heal matrix exception with the existing launcher envelope implementation at `we:scripts/lib/probation-launcher.mjs:379`. This follow-up does not block the targeted bugfix guards.

## Progress

- Historical premise: the approval requested bugfix statute, envelope and veto tests at `we:scripts/lib/__tests__/probation-routing.test.mjs:84`, with a later uniform roster matrix. Original scope was the single test file; original size was 3.
- Corrected premise: the cited line is inside Gemini eligibility coverage, not the refusal block. Current ci-heal veto coverage is at `we:scripts/lib/__tests__/probation-routing.test.mjs:90-93`, doc-fix refusal coverage at lines 95-99 of that same file, and bugfix positive/critical coverage at lines 126-136. The bugfix-specific negative trio is still owed; no already-delivered conclusion is supported.
- Scope remains the existing test file. Runtime guards already exist at `we:scripts/lib/provider-routing.mjs:399-408` and the exact-triple branch at `we:scripts/lib/provider-routing.mjs:391`; caller propagation is at `we:scripts/lib/provider-routing.mjs:964-970`. The expanded roster at `we:scripts/lib/provider-routing.mjs:355-362` includes prepare and test-fix. The ci-heal exemption makes a uniform over-envelope refusal matrix factually wrong.
- Size remains 3: one test file × approximately 100–150 added/adjusted lines for boundary fixtures, per-worker veto assertions, and caller cases, using existing imports and context helpers. This is a story, so no estimatedLoc field is added.
- Preparation inspected source and existing assertions; no behavior was changed or runtime test result claimed. Runner-owned stamps remain untouched.
