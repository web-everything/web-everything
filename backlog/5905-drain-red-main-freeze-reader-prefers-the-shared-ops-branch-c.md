---
bornAs: x09e2bn
kind: story
size: 2
status: resolved
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/red-main-remediation.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-12"
tags: []
---

# drain: red-main freeze reader prefers the shared ops branch copy

Follow-up to 5805. The freeze is now published to the shared ops/red-main-freeze branch (mergeDelivery.redMainFreezeBranch) by we:scripts/readiness/red-main-remediation.mjs freeze/unfreeze, and CI's merge-gate reads it; the drain's own reader (isDispatchFrozen/readFreeze in we:scripts/merge-ai-prs.mjs) still reads only the local marker. Make the drain prefer the shared copy (readSharedFreeze in we:scripts/lib/red-main-freeze-shared.mjs), falling back to the local marker, and treat frozen-in-either as frozen (never fail open). Blocked on PR #4624 (card xx7ckd6), which holds both files and moves the local marker to the coordination root. (No `blockedBy:` edge yet: card xx7ckd6 exists only on #4624's branch, and an edge to a card not on main fails the gate — add `blockedBy: ["xx7ckd6"]` once #4624 lands, or simply start after it.)

Also owed here (from the PR #4715 review, the residual of the "stale clear after a failed publish" finding): per the operator ruling of 2026-10-11, CI's merge-gate now reads main's OWN CI status from GitHub (`readMainCiFact` in we:scripts/merge-gate-check.mjs; unreadable ⇒ hold), so a red main can never hide behind a failing publisher, and the shared copy carries MANUAL freezes only. `freeze` writes the local marker first and then publishes (retried with a fresh fetch, every git call timed); a clear refuses to wipe a different freeze it finds on the tip. The residual is a MANUAL freeze whose every publish attempt fails (origin unreachable, a push policy that refuses each time): the shared copy stays at its previous (clear) state while the local marker is frozen, and CI has no way to see the local marker. Close that window on the drain side: when the drain finds a local freeze marker whose state the shared copy does not carry (shared clear or unreadable), it must say so loudly and retry the publish (or refuse to land) rather than assume CI is holding.

Also owed here (PR #4715 round-3 self-review, the same auto/manual class one file over): the drain's own red-main hold in we:scripts/merge-ai-prs.mjs passes ANY local marker to `redMainSignal` as `manualFreeze`, ignoring `kind`. So a local AUTOMATIC freeze (`decide --apply`, or a kind-less legacy marker whose reason is `decide --apply`) still holds the main-fix PR in the drain, which CI's merge-gate no longer does. Classify the local marker with `freezeKindOf` (we:scripts/lib/red-main-freeze-shared.mjs), the same rule the CLI and the writer use, and let only a MANUAL marker hold the main-fix PR.

## Acceptance

Prerequisite update: the historical blocker above is satisfied; the local marker already resolves through the coordination root in we:scripts/readiness/red-main-remediation.mjs.

- [A1] **Executable** — shared manual freezes hold every PR by default; unreadable shared state always holds every PR; both clear releases; local-only restores the local reader. All five settings report default/platform/settings/env sources.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/red-main-freeze-drain.test.mjs -t A1
  ```
- [A2] **Executable** — unpublished manual freezes warn and retry once per pass; refuse holds every PR and dequeues the local queue. Successful retry, warn, dequeue-off, dry-run and API failures are covered.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/red-main-freeze-drain.test.mjs -t A2
  ```
- [A3] **Executable** — explicit and legacy automatic markers exempt only the published fix; manual markers and the manual compatibility setting hold it. Hold OFF stops on every freeze.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/red-main-freeze-drain.test.mjs -t A3
  ```
- [A4] **Executable** — the real CLI observes shared freezes in ON/OFF paths and preserves automatic fix exemption.

  ```bash
  npm run test:unit -- scripts/__tests__/merge-ai-prs-red-main-hold-wiring.test.mjs
  ```
- [A5] **Executable** — `redMainManualFreezeFixPr` cascades default/platform/settings/env (`WE_DRAIN_RED_MAIN_MANUAL_FREEZE_FIX_PR`): `hold` (default) holds the published fix PR under a manual freeze; `exempt` restores only the published fix PR landing under hold ON. Unreadable shared state and unpublished manual freezes with `redMainUnpublishedFreeze=refuse` always hold it. All settings log their source; OFF retains revert/unfreeze guidance and unreadable-copy checks.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/red-main-freeze-drain.test.mjs scripts/__tests__/merge-ai-prs-red-main-hold-wiring.test.mjs
  ```
- [A6] **Executable** — the shared `flatText` helper sanitizes every string returned by `readSharedFreeze`, including source and errors, plus merge-gate source/reason/error printing and verdict paths. Newlines, CR and U+2028 cannot inject a workflow-command line.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/red-main-freeze-shared.test.mjs
  ```
- Must refuse on unreadable shared state, including malformed or truncated JSON.
- Must hold docs, configuration, data and code PRs equally; there is no file-kind exemption.

## Non-goals

- [N1] No heartbeat or background publisher. CI cannot see an unpublished local freeze when the GitHub API is unreachable too; the drain cannot enqueue then either, and already-queued PRs remain the stated residual when dequeue fails.
- [N2] No new web endpoint: CSRF/origin checks and request rate limits do not apply. Existing authenticated git/gh transports retain bounded output and call timeouts. Dry runs do not publish or dequeue; they report intended actions.

## Edge cases this change must handle

1. **Untrusted text** — the ONE shared `flatText` helper flattens and caps every shared-reader string (including source, mergeSha and git/branch errors) on read, and merge-gate source/reason/error at printing and verdict composition. Marker reason/at and revert SHA are sanitized too; CR/LF and U+2028 cannot start an injected `::error::` line.
2. **Truncated reads** — `readSharedFreeze` uses maxBuffer and validates JSON plus boolean frozen; read failures hold closed. Queue reads validate data and pagination.
3. **Shared state files** — ops branch plus coordination-root marker; frozen in either source holds, and local-only is an explicit rollback setting.
4. **Fail closed** — unreadable shared state holds every PR; unpublished refuse retains the manual hold even if publishing or dequeue fails.
5. **Identity scoping** — dequeue queries only the local repository and its default branch when that repository uses github-merge-queue.
6. **State over time** — re-read once per pass, reuse across stop/hold, and retry publication once per pass followed by a fresh shared read; queue pagination visits all entries. No heartbeat.
7. **Who wrote it** — shared documents retain publishedBy/kind provenance; `freezeKindOf` classifies local explicit/legacy automatic markers, with unknown kinds treated as manual.
