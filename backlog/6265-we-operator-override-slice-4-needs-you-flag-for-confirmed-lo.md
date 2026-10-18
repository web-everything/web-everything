---
bornAs: x9ryzme
kind: story
size: 3
parent: "6268"
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs", "we:scripts/operations/delivery-metrics.mjs", "we:scripts/operations/__tests__/delivery-metrics.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 4 - needs-you flag for confirmed loosening overrides

Show every confirmed loosening operator override in the needs-you feed, per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer), so a guard is never off without the operator seeing it.

The live producer is `runOnce` in we:scripts/operations/needs-you-feed.mjs, run by we:scripts/conveyor/needs-you-feed-job.mjs. Today it reads only the operator-queue report. This slice makes `runOnce` also read the override layer directly, through slice 1's `readOperatorOverrides` and slice 3's safe-direction table, and add one item per confirmed loosening override to the same `diffFeed` call. The operator-queue report is not changed.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/operations/__tests__/needs-you-feed.test.mjs and we:scripts/operations/__tests__/delivery-metrics.test.mjs. Every feed test below drives `runOnce` with an injected queue report and override layer, and asserts on the lines in the feed file. Named tests, one per guarantee:
  - `runOnce publishes a confirmed loosening override to the feed file with its key, expiry, actor, time and instruction`
  - `runOnce does not publish a non-loosening override or an unconfirmed loosening entry`
  - `an expired override emits NEEDS-YOU-CLEARED on the next run, and the PR items in the same run still publish`
  - `an override feed key round-trips through the state file, so a later clear never throws`
  - `an unreadable override layer marks the run incomplete: earlier override entries stay open, no clear is emitted, and PR items still publish`
  - `parseFeedLine reads an override line and an override cleared line`
  - `delivery-metrics counts override entries apart from PR needs-you episodes`

## Non-goals

- [N1] Does not change the guard floor or the store; display only.
- [N2] Does not change we:scripts/operations/operator-queue.mjs or its report.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the operator instruction goes through `sanitizeForFeed` and is shown in the same `(untrusted)` JSON-quoted field as a PR title, never in the 100-character `reason` field and never rendered as markup.
2. **Truncated reads** — an unreadable or unparseable layer logs a note and marks the run incomplete. As with an incomplete queue report today, earlier open keys are kept, so no false clear tells the operator a guard is back on.
3. **Shared state files** — override keys live in the same feed state file, written under the existing feed lock. The key has its own shape (no PR number), and the state-key parser accepts it, so one bad key can never make every later run throw inside the lock.
4. **Fail closed** — a failure to read the layer never hides other entries: PR items from the queue report still publish in the same run, and earlier override entries stay open.
5. **Identity scoping** — n/a: no identity decision is made here.
6. **State over time** — an override that expires is cleared on the next complete run, with a `NEEDS-YOU-CLEARED` line.
7. **Who wrote it** — each feed line names the actor and time from the store's log entry.
8. **Downstream readers** — `parseFeedLine`, we:scripts/operations/delivery-metrics.mjs, we:scripts/conveyor/health-watch.mjs and the session bootstrap read feed lines. An override line must parse in all of them. Delivery metrics must not count it as a PR needs-you episode or a PR wait.
