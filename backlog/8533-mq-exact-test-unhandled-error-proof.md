---
bornAs: x02qun8
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: []
---

# Reinforce exact-test MQ retry: prove no unhandled error beside the sole failed test

Prove that the exact-test merge-queue retry cannot overlook an unhandled error beside its sole failed test. Vitest's JSON report omits global unhandled errors; annotations and the final log summary provide partial mitigation today. Add complete, run-bound producer evidence for global errors and refuse retry when that evidence is missing or inconsistent. Also prevent unfinished backlog digests and Acceptance placeholders from entering new cards.

## Acceptance

- [A1] **Executable** — `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs` includes named tests `holds when a sole failed test has a global unhandled rejection`, `holds when a sole failed test has an uncaught exception`, and `allows a sole failed test with complete zero-global-error evidence`. The first two must hold even when JSON, annotations, and the final summary otherwise look eligible. They fail before the producer/consumer proof lands and pass after it.
- [A2] **Must** — refuse missing, truncated, expired, ambiguous, mismatched, or unreadable global-error evidence; never fall back to the JSON report's absent runtime-error counter as proof of zero global errors.
- [A3] **Must** — treat test output, reports, annotations, logs, configuration, and artifact metadata as untrusted data; bind the proof to the repository, run, attempt, shard, and merge-group SHA. Keep existing retry caps, identity checks, and call/output limits.
- [A4] **Prevention owed by PR #6936** — add a `check:standards` rule rejecting new backlog cards containing unfinished `TODO` placeholders in either their digest or Acceptance. Extend `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` with named cases `rejects a new backlog digest placeholder`, `rejects a new backlog Acceptance placeholder`, and `accepts a completed backlog digest and Acceptance`. Run the commands below from the WE repository root.

```bash
npm run test:unit -- scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs
npm run test:unit -- scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs
npm run check:standards
```

The commands and named tests above are future acceptance, not claims that this follow-up has shipped. No receive/write endpoint is added: body caps, CSRF/origin checks, and reset-trigger rate limits do not apply. Existing bounded GitHub reads and rerun claims remain required.

## Non-goals

- [N1] Do not loosen same-head retry caps, classify arbitrary job logs as flakes, redesign CI sharding, or treat annotations and a summary alone as complete global-error proof.

## Edge cases this change must handle

1. **Untrusted text** — assertion text resembling an error counter cannot forge the producer's structured result; never execute report/log contents.
2. **Truncated reads** — missing artifacts, incomplete pagination, truncated summaries, oversized reports, or exhausted call budgets retain the hold for manual inspection.
3. **Shared state files** — n/a: no new shared mutable state; preserve the existing rerun claim mechanism.
4. **Fail closed** — unknown producer schema, absent counters, nonzero global errors, and disagreement between sources retain the hold.
5. **Identity scoping** — reject a proof from another repository, SHA, run, attempt, or shard; require one complete proof per expected shard.
6. **State over time** — reject expired artifacts and stale main evidence; re-read CLEAN and the PR head immediately before authorization.
7. **Who wrote it** — require evidence emitted by the selected CI workflow's test process; comments or uploaded lookalike metadata cannot substitute for bound producer evidence.

## Risks

- [R1] Unhandled rejections and uncaught exceptions may occur outside assertion results or after the test summary. A JSON counter alone cannot establish completeness.
- [R2] A missing or stale producer report could be mistaken for zero errors, or a report from another attempt could be reused.
- [R3] Text printed by a test could imitate evidence; extra reads could exceed the shared budget or delay admission.
- [R4] New cards can look ready while digest or Acceptance still contains scaffold placeholders.

## Test plan

- [R1 → A1] Run both named global-error refusal tests with otherwise eligible annotations/summary, plus the zero-global-error positive control. Include an error after the final summary.
- [R2 → A2/A3] Add `holds when global-error proof is missing or from another attempt`; table-test absent, unreadable, expired, incomplete, duplicate, and mismatched repository/run/SHA/shard evidence.
- [R3 → A3] Add `test output cannot forge zero-global-error proof` and exercise the existing `holds when the shared retry-evidence budget is exhausted` regression. Oversized evidence retains the operator-inspection fallback.
- [R4 → A4] Run the three named backlog-integrity tests against both digest and Acceptance placeholders, including a completed-card positive control; wire the rule into the actual standards command.

## Duplicate admission

R825/R953 residual: Vitest JSON omits global unhandled errors. Current annotations and the bounded final summary are partial mitigation; this card requires explicit complete producer proof before claiming the residual is resolved.
