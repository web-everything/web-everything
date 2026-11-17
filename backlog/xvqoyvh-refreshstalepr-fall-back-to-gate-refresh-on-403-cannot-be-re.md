---
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: [merge-queue]
scope:
  - we:scripts/lib/merge-queue-hook.mjs
  - we:scripts/lib/merge-queue-enqueue.mjs
  - we:scripts/lib/merge-gate-refresh.mjs
  - we:scripts/lib/__tests__/merge-queue-hook.replay.test.mjs
  - we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs
  - we:backlog/xvqoyvh-refreshstalepr-fall-back-to-gate-refresh-on-403-cannot-be-re.md
---

# refreshStalePr: fall back to gate:refresh on 403 cannot-be-retried; don't burn catch-up budget

When a PR branch already contains main, `refreshStalePr` tries to rerun its required workflow.
GitHub refuses startup failures with HTTP 403, “This workflow run cannot be retried”.
Use the existing bounded `gate:refresh` label trigger instead, preserving the judged head.
Known startup failures skip the impossible rerun; other runs fall back only for that specific 403 refusal.
The existing claim and ledger bounds count a successfully triggered refresh, while a failed trigger
releases its claim and leaves catch-up budget available for a later attempt.

Implementation lives in [we:scripts/lib/merge-queue-hook.mjs](../scripts/lib/merge-queue-hook.mjs),
[we:scripts/lib/merge-queue-enqueue.mjs](../scripts/lib/merge-queue-enqueue.mjs), and the shared trigger in
[we:scripts/lib/merge-gate-refresh.mjs](../scripts/lib/merge-gate-refresh.mjs).

## Acceptance

- [A1] **Executable** — The scoped regression command passes:

  ```bash
  node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/merge-queue-hook.replay.test.mjs scripts/lib/__tests__/merge-queue-enqueue.test.mjs scripts/lib/__tests__/merge-gate-refresh.test.mjs
  ```
- [A2] **Must** — Startup failures and HTTP 403 cannot-be-retried refusals trigger the shared label toggle without rewriting the branch.
- [A3] **Must** — Missing, moved or unreadable head evidence refuses label mutations; unrelated rerun errors remain failures.
- [A4] **Must** — Failed infrastructure triggers write no catch-up record and release the atomic claim; successful triggers retain the once-per-head bound.
- [A5] **Executable** — The standards command passes:

  ```bash
  node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
  ```

## Non-goals

- [N1] Change enqueue, approval, same-repository or CI admission rules; alter workflow definitions; add settings or remote endpoints.

## Edge cases this change must handle

1. **Untrusted text** — Error text selects only the specific refusal fallback; all commands use argument arrays, never shell interpolation.
2. **Truncated reads** — Live PR evidence uses bounded transport and JSON parsing; unreadable evidence refuses mutations.
3. **Shared state files** — Keep atomic claims and existing ledger preflight; failure releases the claim without recording success.
4. **Fail closed** — Missing repo/PR/head or mismatched live head refuses the toggle; operator fallback is explicit.
5. **Identity scoping** — Trigger only the judged repository, PR and head; existing same-repository guard remains required.
6. **State over time** — A failed trigger can retry on a later pass; a successful trigger remains bounded once per head.
7. **Who wrote it** — n/a: no new authorship evidence or trust rules; existing approval checks remain unchanged.

No receive endpoint is added; body caps, CSRF and origin policy do not apply. Existing throttled GitHub
transport, bounded label retries and per-head claims bound the recovery trigger.
