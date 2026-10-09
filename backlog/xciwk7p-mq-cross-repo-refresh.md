---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/sibling-clone.mjs", "we:scripts/lib/merge-queue-hook.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-09"
tags: []
---

# Drain merge-queue refresh: provision the missing cross-repo sibling clone (plateau-app #217 never merged)

plateau-app PR #217 (accepted, CLEAN) was skipped every drain pass: merge-queue refresh -> skipped-remote, no plateauapp/plateau-app clone in the resident drain's pool. Fix: the refresh provisions the sibling clone on demand (we:scripts/lib/sibling-clone.mjs), named mq-* skip kinds, per-repo nonCodePaths (plateau-app: docs/, reports/). Clone not update-branch API because the acceptance re-check on the moved head needs a checkout. PR lane/mq-cross-repo-refresh, stacked on #4624.

Also: `we:scripts/lib/daemon-clone-registry.mjs` seeded only `.lanes/we-drain-daemon/lane-1`, so every overlay CLI call dropped the drain code clone's (`.lanes/we-drain-daemon/code`) overlay record as "a pool lane" — the list never held more than one overlay. Seeded.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` over we:scripts/lib/__tests__/sibling-clone.test.mjs, we:scripts/lib/__tests__/drain-skip-reasons.test.mjs, we:scripts/lib/__tests__/merge-queue-hook.replay.test.mjs and we:scripts/lib/__tests__/daemon-clone-registry-drain-code-clone.test.mjs fails before, passes after.
- [A2] **Live** — on the drain edge, plateau-app #217's skip changes from `skipped-remote … no clone provisioned` (kind `unrecognized-reason`) to a provisioned clone + `mq-refreshed`; CI re-runs on the new head and the drain merges it. No hand merge or push.

## Non-goals

- [N1] No GitHub update-branch API path: the moved head still needs a local checkout for the acceptance re-check.
- [N2] No merge-gate guard is loosened; refresh stays once per head, recorded only on success.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the clone URL comes only from the drain clone's own origin plus a slug matched against `owner/repo`; other URL shapes give null and nothing is cloned.
2. **Truncated reads** — git runs through proc-read with a bounded buffer; a failed read means no clone and a named skip.
3. **Shared state files** — the clone goes at `../<name>` only when that path is absent; a non-git dir there is left alone and reported.
4. **Fail closed** — a failed clone removes its partial dir, the PR is skipped with the reason, and it retries next pass.
5. **Identity scoping** — pushes use the same transport and credentials as the drain clone's origin.
6. **State over time** — the clone is created once and reused; refreshes fetch what they need.
7. **Who wrote it** — n/a: no authored content is trusted; the existing acceptance re-stamp rules apply unchanged.
