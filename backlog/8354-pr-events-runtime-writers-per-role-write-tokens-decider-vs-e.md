---
bornAs: xsj9xu7
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# pr-events runtime writers: per-role write tokens (decider vs executors) so the writer role is proven, not claimed

Follow-up to #5453: POST /runtime-events uses the shared PR_EVENTS_BOOTSTRAP_TOKEN, so the recorded writer role is claimed, not proven. Per-role write tokens need new secret bindings in we:scripts/conveyor/pr-events-worker/worker.mjs; secret storage is an operator decision (rule 14).

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. The codex-correctness card suggestion requests a name for A1's planned test. The name below specifies that future test; it does not claim role-specific tokens or bindings have been implemented.

## Acceptance

- [A1] **Executable** — add the planned test 'runtime writer tokens reject a mismatched claimed role' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Post a runtime event with the decider token claiming an executor role and expect 401; the scenario fails today (one shared token).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Provisioning the secrets themselves: new secret bindings are an operator decision (rule 14).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new free-text fields.
2. **Truncated reads** — n/a: write path only.
3. **Shared state files** — n/a: the Durable Object stays the single writer.
4. **Fail closed** — a missing role token answers 503; a token for a different role answers 401.
5. **Identity scoping** — each token is bound to one role.
6. **State over time** — n/a: token rotation belongs to the operator.
7. **Who wrote it** — the recorded writer role comes from the token, not the body.
