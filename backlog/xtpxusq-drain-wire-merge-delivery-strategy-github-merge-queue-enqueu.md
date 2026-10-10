---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue.json", "we:scripts/merge-gate-check.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# drain: wire merge-delivery strategy github-merge-queue (enqueue instead of merge, enqueue clearance, queue follow-ups)

Modules + tests landed with the merge-gate PR (we:scripts/lib/merge-delivery-policy.mjs, we:scripts/lib/merge-queue-enqueue.mjs, we:scripts/lib/merge-gate-ci.mjs). The wiring into we:scripts/merge-ai-prs.mjs is deferred because that file is held by #4624 (review:changes + review:human) and #4631. Wire: (1) resolve the policy once per pass via loadMergeDeliveryPolicy and log formatMergeDeliverySourcesLine every pass; (2) at the merge site, when mergeActionFor(policy) is enqueue, strip the transient manifest first (needsManifestStripBeforeMerge), then enqueuePr with the pinned head instead of mergePr, and skip the drain freshness refresh (the queue owns freshness); (3) stamp a trusted drain enqueue-clearance marker comment for the head so merge-gate's couple-whole/blocked-by gates (fail closed today for manifest couples) can read it, and teach we:scripts/merge-gate-check.mjs to read it; (4) each pass run the existing post-land follow-up (numbering, regen, resolve-on-land) for planQueueFollowUps(merged-by-queue PRs); (5) retire or alias the drain-internal mergeQueue.strategy in we:scripts/settings/merge-queue.json (held by #4689) so the cascade has one strategy key. Keep drain-direct byte-identical. Proof: live enqueue of one accepted PR, merged by GitHub, follow-up run.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.
- [A2] **Must** — the drain enqueues ONLY through `enqueuePr` in we:scripts/lib/merge-queue-enqueue.mjs, which refuses (human-only) a PR whose diff touches `.github/workflows/**` or `.github/actions/**` and holds retryably on an unreadable change list (PR 4708, the we:.github/workflows/merge-gate.yml gate-YAML finding); we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs fails on any other caller of the enqueue mutation.

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
