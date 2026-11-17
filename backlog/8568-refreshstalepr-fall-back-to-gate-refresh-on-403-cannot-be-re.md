---
bornAs: xvqoyvh
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
  - we:backlog/8568-refreshstalepr-fall-back-to-gate-refresh-on-403-cannot-be-re.md
---

# refreshStalePr: fall back to gate:refresh on 403 cannot-be-retried; don't burn catch-up budget

When a PR branch already contains main, `refreshStalePr` tries to rerun its required workflow.
GitHub refuses startup failures with HTTP 403, “This workflow run cannot be retried”.
Use the existing bounded `gate:refresh` label trigger instead, preserving the judged head.
Only verified merge-gate startup failures skip the impossible rerun and use the label trigger.
Other runs keep their rerun errors, including HTTP 403 cannot-be-retried refusals.
The claim and ledger bounds count a confirmed refresh. A definite denial before any watched
label transition releases the claim without spending catch-up budget. Unknown outcomes retain
the claim for label reconciliation, including failures after removing an existing label.

Implementation lives in [we:scripts/lib/merge-queue-hook.mjs](../scripts/lib/merge-queue-hook.mjs),
[we:scripts/lib/merge-queue-enqueue.mjs](../scripts/lib/merge-queue-enqueue.mjs), and the shared trigger in
[we:scripts/lib/merge-gate-refresh.mjs](../scripts/lib/merge-gate-refresh.mjs).

## Acceptance

- [A1] **Executable** — The scoped regression command passes:

  ```bash
  node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/merge-queue-hook.replay.test.mjs scripts/lib/__tests__/merge-queue-enqueue.test.mjs scripts/lib/__tests__/merge-gate-refresh.test.mjs
  ```
- [A2] **Must** — Verified merge-gate `startup_failure` runs use the shared label toggle without rewriting the branch. Other runs retain rerun errors, including HTTP 403 cannot-be-retried. Defended in `we:scripts/lib/__tests__/merge-queue-hook.replay.test.mjs` by `triggers gate:refresh for an identified startup_failure without changing the head` and `a non-gate run 403 cannot-be-retried with conclusion %s never toggles the label`.
- [A3] **Must** — Missing, moved or unreadable head evidence refuses label mutations; unrelated rerun errors remain failures. Defended by the head-evidence and rerun-error cases in `we:scripts/lib/__tests__/merge-queue-hook.replay.test.mjs`.
- [A4] **Must** — Definite failures before watched label events write no catch-up record and release the claim; confirmed triggers retain the once-per-head bound. Unknown outcomes hold the claim through non-dispatch passes and reconcile without another add. Defended in `we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs` by `retains pending claims on non-dispatch exit: %s` and `holds the head after an existing-label removal dispatch even if label creation fails`.
- [A5] **Executable** — The standards command passes:

  ```bash
  node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
  ```

## Non-goals

- [N1] Change enqueue, approval, same-repository or CI admission rules; alter workflow definitions; add settings or remote endpoints.

## Edge cases this change must handle

1. **Untrusted text** — Verified run conclusion selects the fallback; all commands use argument arrays, never shell interpolation.
2. **Truncated reads** — Live PR evidence uses bounded transport and JSON parsing; unreadable evidence refuses mutations.
3. **Shared state files** — Keep atomic claims and existing ledger preflight; only definite failures release claims. Uncertain attempts retain pending state and re-read labels under an expiring reader lock.
4. **Fail closed** — Missing repo/PR/head or mismatched live head refuses the toggle; operator fallback is explicit.
5. **Identity scoping** — Trigger only the judged repository, PR and head; existing same-repository guard remains required.
6. **State over time** — A definite denial can retry on a later pass; unknown attempts reconcile without another add, including repeated restamps. Restamp state covers the same stale gate until newer gate evidence appears.
7. **Who wrote it** — n/a: no new authorship evidence or trust rules; existing approval checks remain unchanged.

No receive endpoint is added; body caps, CSRF and origin policy do not apply. Existing throttled GitHub
transport, bounded label retries and per-head claims bound the recovery trigger.
