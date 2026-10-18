---
bornAs: x9ryzme
kind: story
size: 3
parent: "6268"
status: open
blockedBy: ["6266", "6269"]
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs", "we:scripts/operations/delivery-metrics.mjs", "we:scripts/operations/__tests__/delivery-metrics.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 4 - needs-you flag for confirmed loosening overrides

Show every confirmed loosening operator override in the needs-you feed, per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer), so a guard is never off without the operator seeing it.

The live producer is `runOnce` in we:scripts/operations/needs-you-feed.mjs, run by we:scripts/conveyor/needs-you-feed-job.mjs. Today it reads only the operator-queue report. This slice makes `runOnce` also read the override layer directly and add one item per confirmed loosening override to the same `diffFeed` call (changed as below). It uses slice 1's `readOperatorOverrides` (its `readable` flag and each entry's `entryId`, actor, time, instruction and expiry) and slice 3's `isLooseningOverride`. The operator-queue report is not changed.

**Key shape.** An override item uses `repo: "operator-override"`, `pr: 0`, `head: <entryId>` and `kind: "override-loosening"`, so its state key is `operator-override#0@<entryId>:override-loosening`. The `entryId` is limited to `[A-Za-z0-9-]`, at most 128 characters (the feed's `head` limit), so `fromKey`'s greedy pattern cannot misparse it. That key already parses with the current `fromKey`, so an older producer reading the same state file during a revert never throws. (An older producer does emit `NEEDS-YOU-CLEARED` for override keys during a revert, since it does not publish them; the next run of this producer reopens them.) A new value or expiry is a new log entry with a new `entryId`, so it publishes a new line.

**Invalid identity is visible.** Validate the entire id against `^[A-Za-z0-9-]{1,128}$`, including type and length, and check uniqueness across current entries. A missing, non-string, malformed, over-long or duplicate id publishes the fixed fallback `operator-override#0@invalid-entry:layer-unreadable`, with a static reason and sanitized, quoted details; logging alone is insufficient. Publish entries with valid, unique ids from that run as well. Mark the override source incomplete while any invalid or duplicate id exists, keeping earlier override keys open; PR clearing remains independent. Multiple invalid entries share the fallback alarm, whose details indicate their count. Once all ids are valid and unique, clear the fallback and reconcile superseded keys normally. This path also handles malformed hand-edited data even though the store's generator produces valid ids.

**`diffFeed` changes.** Today `diffFeed` takes one `incomplete` flag: it suppresses every clear and holds every earlier key open. This slice changes it to take incompleteness per source. Override keys (`repo === "operator-override"`) are held open when the layer is unreadable or contains invalid/duplicate ids, and PR keys only when the queue report is incomplete. `publishAttention` keeps passing a value that holds every key open, as it does today.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/operations/__tests__/needs-you-feed.test.mjs and we:scripts/operations/__tests__/delivery-metrics.test.mjs. Every feed test below drives `runOnce` with an injected queue report and override layer, and asserts on the lines in the feed file. Named tests, one per guarantee:
  - `runOnce publishes a confirmed loosening override to the feed file with its key, expiry, actor, time and instruction`
  - `runOnce does not publish a non-loosening override or an unconfirmed loosening entry`
  - `an expired override emits NEEDS-YOU-CLEARED on the next run, and the PR items in the same run still publish`
  - `an override feed key parses with the existing fromKey, so a later clear never throws`
  - `re-setting an override with a new value or expiry publishes a new line`
  - `a superseded loosening entry clears when the latest value is safe, and re-setting to another loosening entry clears the old key and publishes the new one`
  - `an unreadable override layer publishes one layer-unreadable item, keeps earlier override entries open and emits no override clear`
  - `an unreadable override layer does not stop PR items from clearing, and an incomplete queue report does not stop override clears`
  - `publishAttention still holds every earlier key open, PR and override alike`
  - `runOnce publishes a visible fallback for an invalid entryId` (missing, non-string, empty, newline, delimiters, dot/path names, Unicode/invisible characters and 129 characters; assert the fallback parses with existing fromKey)
  - `invalid entryIds hold earlier override keys open, publish valid overrides and allow PR clears; fixing the ids clears the fallback`
  - `duplicate entryIds publish the fallback instead of collapsing two active overrides into one feed key`
  - `the invalid-identity fallback key parses with the existing fromKey during rollback and recovery`
  - `runOnce quotes and sanitizes hostile instruction, key, actor and value` (newline, CR, U+2028, quotes, backticks, leading --, path .., markup, Unicode/invisible characters and a forged NEEDS-YOU line; assert exact feed-file bytes, no extra feed records, no raw reason or markup, and one parsed untrusted field)
  - `two override entries stay distinct in unacknowledged and the session bootstrap`
  - `parseFeedLine reads an override line and an override cleared line`
  - `delivery-metrics counts override entries apart from PR needs-you episodes and waits`

## Non-goals

- [N1] Does not change the guard floor or the store; display only.
- [N2] Does not change we:scripts/operations/operator-queue.mjs or its report.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — instruction, key, actor, value and other store-derived display fields go through `sanitizeForFeed` and are shown only in the `(untrusted)` JSON-quoted field, never in the static 100-character `reason` field and never rendered as markup. Sanitize the complete composed display text so concatenating individually safe fragments cannot forge a feed line. The id is validated separately before it becomes a feed key.
2. **Truncated reads** — when `readable` is false, the run publishes one `operator-override#0@layer:layer-unreadable` item, which the operator sees even though the live job runs with a silent log. Earlier override keys stay open, so no false clear says a guard is back on. The item clears once the layer reads again.
3. **Shared state files** — override keys live in the same feed state file, under the existing feed lock. Incompleteness is kept per source: an unreadable layer holds only override keys open, and an incomplete queue report holds only PR keys open.
4. **Fail closed** — a failure to read the layer never hides other entries: PR items still publish and clear in the same run, and earlier override entries stay open.
5. **Identity scoping** — n/a: no identity decision is made here.
6. **State over time** — consume slice 1's latest-entry-per-key view. Expired or superseded loosening entries clear on the next complete override read, with a `NEEDS-YOU-CLEARED` line; a safe replacement leaves no old loosening alarm active. An unreadable layer or invalid identity holds earlier override keys open until recovery.
7. **Who wrote it** — each feed line names the actor and time from the store's log entry.
8. **Downstream readers** — the feed lines are read by `parseFeedLine`, by `unacknowledged()` (which the session bootstrap in we:scripts/operations/operator-session-bootstrap-io.mjs uses, keyed by `keyOf`) and by we:scripts/operations/delivery-metrics.mjs. we:scripts/conveyor/health-watch.mjs only publishes through `publishAttention` and is unaffected. Delivery metrics leave out `repo: "operator-override"` entries from PR episodes and waits.
