---
kind: story
size: 5
status: resolved
scope: ["we:scripts/operations/worker-wrapper.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-08"
dateResolved: "2026-10-08"
graduatedTo: worker-contract-s3a
tags: []
---

# Worker result contract S3a: unified detached worker wrapper, build path migrated behind a knob

117 D7 FINAL: every worker uses ONE pattern, run-to-completion through a detached wrapper. This slice adds that wrapper (explicit pid and timeout, stdin closed, result from stdout structured_output or a result file, resume with the schema, its own job record in the completion record v2) and moves the mechanical build path onto it first behind a knob that is off by default. Downstream build behaviour is unchanged apart from the record format.

## Done when

1. **Executable** — vitest on `we:scripts/operations/__tests__/worker-wrapper.test.mjs` and `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` passes: the wrapper writes a started v2 record with pid and timeout before the child exits and a done record after; a missing or invalid structured_output becomes unparseable with kind contract-violation; a Codex child gets stdin closed; a timeout kill is contract-violation and an operator stop is aborted; with the knob on, the build path gets the same report shape it got from a delivery-report, and with the knob off the argv is byte-identical to before.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — The wrapper redacts the stdout prose tail and the failure text before they enter the record; stdout is parsed as data only.
2. **Truncated reads** — Over-long or truncated stdout fails the max-buffer guard and the JSON parse, and is unparseable, never success.
3. **Shared state files** — One record per session slug, written under the existing completion lock; the wrapper owns it from started to done.
4. **Fail closed** — No structured output, invalid output, timeout and reaper kill all fail closed to contract-violation; stdin is closed so a Codex child cannot hang.
5. **Identity scoping** — The record carries the pid and the child's sessionId; a late done from another pid is refused by the existing owner rule.
6. **State over time** — The knob is off by default; the record has startedAt, endedAt, pid and a deadline so a dead wrapper reads as stale.
7. **Who wrote it** — The wrapper writes the envelope; the agent only emits the result object (or, while the legacy brief is in place, its old delivery-report, which the wrapper maps).
