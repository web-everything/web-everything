---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/coroner-sample.mjs", "we:scripts/operations/__tests__/coroner-sample.test.mjs", "we:skills-src/coroner/SKILL.md"]
dateOpened: "2026-10-08"
tags: []
---

# Coroner LLM sample: schema-checked summaries of the worst sessions, with a stability-stepped sample size (card 130 S3)

Card 130 S3. Each coroner run picks the worst N sessions by minutes lost (S1 signals), has a cheap model summarise each friction into a worker-result-shaped record (outcome, blocker.kind, evidence, proposedFix), validates and drops invalid ones with a count. Knob coroner.sampleSize defaults 25-30; when the top-5 friction ranking is unchanged for 3 runs, N halves (floor 5); a change resets to large. Ranking persisted beside the perf snapshots; cost per run reported. Code: we:scripts/operations/coroner-sample.mjs.

## Done when

1. **Executable** — `npx vitest run` on we:scripts/operations/__tests__/coroner-sample.test.mjs (module absent on old code, so red; 26 tests green after), and we:scripts/operations/coroner-sample.mjs with `--hours=12 --sample-size=25` prints the top-5 frictions, the dropped count and the cost per run.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the model sees only the S1 record, passed through `redact` and capped at 6000 chars, under a mandate that says it is data; every kept model string is redacted again.
2. **Truncated reads** — n/a: no new transcript read; S1's bounded tail reads feed the sample, and the ranking history is read as a 256 KiB tail with a torn first line dropped.
3. **Shared state files** — the ranking JSONL is append-only (one line per run); torn or foreign-version rows are skipped on read.
4. **Fail closed** — a model error or a schema-invalid answer is dropped and counted, never guessed; a run with no valid records writes no ranking row and leaves N unchanged.
5. **Identity scoping** — the session id on a record comes from S1, never from the model's answer (the shape has no session field).
6. **State over time** — the stability state is replayed from the JSONL on every run, so a changed knob takes effect at once; halving restarts the count at the new N.
7. **Who wrote it** — n/a: the sample is read-only analysis; it files nothing and opens no PR.
