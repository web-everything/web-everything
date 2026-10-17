---
kind: story
size: 3
status: active
scaffoldedBy: "fix-5485"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/codex-worker.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/conveyor/concurrent-baseline-comparison.mjs", "we:scripts/lib/__tests__/codex-caller-policy.test.mjs"]
scopeRationale: "we:scripts/codex-direct-task.mjs is named only as the CLI whose invocations the new test lists; the change is in its callers."
dateOpened: "2026-10-17"
tags: []
---

# Decide Codex self-review and gate per caller class

PR 5485 turned on the full gate and the capped self-review by default in codex-direct-task. Three callers inherit them without an explicit choice: codex-worker (gate standards; self-review notes never reach its PR body; a reviewer outage now fails the codex step), the probation launchers (gate none; extra Codex repair turns credited to the worker before their own checker), and concurrent-baseline-comparison (no gate, so the Codex side now runs the full unit tier and self-review while Gemini does not, which skews the comparison). Each caller should pass an explicit gate and --no-self-review or carry the notes, with a test that lists every caller and its explicit choice.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/codex-caller-policy.test.mjs` fails before this item lands (no such test) and passes after: it lists every `codexDirectTask` caller and `we:scripts/codex-direct-task.mjs` CLI invocation and asserts each passes an explicit gate and an explicit self-review choice.
- [A2] Where a caller keeps self-review on, its remaining notes reach the PR or report it publishes (`renderSelfReviewNotes`); a reviewer outage stops that caller with a named outcome, never a silent pass.

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
