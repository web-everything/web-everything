---
bornAs: xt30u37
kind: task
status: open
scope: ["we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Wire feature probation through the dispatcher and build runner

PR #5370 class sweep found existing feature launch blockers outside its repair scope: we:scripts/operations/dispatch-providers/probation-worker.mjs rejects and fails to forward build-new-feature; we:scripts/operations/probation-build-run.mjs rejects that task type and applies simple-only metadata and checker language to all Gemini workers; we:scripts/lib/probation-launcher.mjs describes feature work as bugfix work. Connect the feature route while preserving full review, Codex approval, critical-work refusals, and bounded scope. Prove the actual dispatcher argv reaches the runner and checker for a non-simple Argon feature, and retain Flash restrictions.

PR #5370's subsequent review repair implements this wiring, including the production feature policy, raw-scorecard holds, worker identity through explicit policy fallbacks, and the runner's feature/checker hand-off. Verification remains pending; this card stays open until that evidence is available.

Prevention coverage added in the repair: dispatcher tests exercise backend and checker holds from production scorecards; an invariant accounts for every roster task type as launchable or explicitly record-only; settings and runner tests reject Flash/Pro under the non-simple Argon identity. The soak case `argon-feature-dispatch` replays the production routing and launch boundary without starting a worker.

## Acceptance

- [A1] **Executable** — Add a regression in we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs that routes a non-simple feature to Argon, captures the real probation provider argv, and passes it through the real runner parser with taskType and Codex checker preserved. Run that file with the scoped unit-test command; it must fail before the wiring repair and pass after it.
- [A2] **Executable** — In we:scripts/operations/__tests__/probation-build-run.test.mjs, exercise the feature build arc with an injected worker and checker: APPROVE permits the normal verification path; REJECT prevents commit and PR creation. Confirm the feature prompt describes the requested feature and does not reject it merely for being non-simple.
- [A3] **Must** — Unknown workers, disallowed models, unsupported task types, checker failures, and invalid scope must still refuse safely; retain critical-work and statute-tier refusals.
- [A4] **Must** — Documentation, tests, configuration, and data must remain subject to their existing task envelopes and scope restrictions. The Argon exception must not remove Gemini Flash's simple-only restriction.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Change no probation graduation, critical-work, provider quota, or human review policy.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Preserve model catalogue validation and argv-array transport of worker JSON; refuse malformed models and workers.
2. **Truncated reads** — n/a: no new external read or output parser is needed for the task-type wiring.
3. **Shared state files** — n/a: retain existing runner state and lock owners; introduce no shared writer.
4. **Fail closed** — Checker REJECT, unsupported task types, and out-of-envelope changes must stop delivery.
5. **Identity scoping** — Preserve worker provider/model/taskType identity through the actual dispatcher argv and recorded trial.
6. **State over time** — Worker/checker holds and critical-miss vetoes must still prevent selecting Argon; do not retry a refused launch as a different task type.
7. **Who wrote it** — Preserve full review and independent Codex checking before the runner commits or opens a PR.
