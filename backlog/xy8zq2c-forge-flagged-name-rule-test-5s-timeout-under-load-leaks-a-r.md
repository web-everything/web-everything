---
kind: task
status: open
scope: ["we:scripts/readiness/__tests__/forge-flagged-name-rule.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# forge-flagged-name-rule test: 5s timeout under load leaks a refused file into the next test

we:scripts/readiness/__tests__/forge-flagged-name-rule.test.mjs: the credential-name test that writes we:scripts/__tests__/token-sample.test.mjs then calls buildManifest uses the default 5000ms timeout. On a loaded CI runner (merge-queue run 44957821931, test-shard 2, PR 7315) it timed out after the write+commit, so the shared temp repo kept the refused file and the next test failed with unshipped-test-file. Passes alone locally (143/143). Give both tests an explicit timeout and make the refused-file step clean up (or isolate per test) so one timeout cannot cascade.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
