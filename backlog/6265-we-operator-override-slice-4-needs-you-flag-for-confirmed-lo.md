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

The live producer is `runOnce` in we:scripts/operations/needs-you-feed.mjs, run by we:scripts/conveyor/needs-you-feed-job.mjs. Today it reads only the operator-queue report. This slice makes `runOnce` also read the override layer directly and add one item per confirmed loosening override to the same `diffFeed` call (changed as below). It makes one slice 1 `readOperatorOverrideLog({ after, now })` call per run, at the run's `now`, and takes both the current view (`entries`: its `readable` flag and each entry's `entryId`, actor, time, instruction and expiry) and the history (`records`) from that one read. It also uses slice 3's `isLooseningOverride`. The operator-queue report is not changed.

**Key shape.** An override item uses `repo: "operator-override"`, `pr: 0`, `head: <entryId>` and `kind: "override-loosening"`, so its state key is `operator-override#0@<entryId>:override-loosening`. The `entryId` is limited to `[A-Za-z0-9-]`, at most 128 characters (the feed's `head` limit), so `fromKey`'s greedy pattern cannot misparse it. That key already parses with the current `fromKey`, so an older producer reading the same state file during a revert never throws. (An older producer does emit `NEEDS-YOU-CLEARED` for override keys during a revert, since it does not publish them; the next run of this producer reopens them.) A new value or expiry is a new log entry with a new `entryId`, so it publishes a new line.

**Invalid identity is visible.** Validate the entire id against `^[A-Za-z0-9-]{1,128}$`, including type and length, and check uniqueness across current entries. A missing, non-string, malformed, over-long or duplicate id publishes the fixed fallback `operator-override#0@invalid-entry:layer-unreadable`, with a static reason and sanitized, quoted details; logging alone is insufficient. Publish entries with valid, unique ids from that run as well. Mark the override source incomplete while any invalid or duplicate id exists, keeping earlier override keys open and `overrideLogCursor` unchanged (named test `invalid or duplicate entryIds hold the override log cursor in place, and fixing the ids delivers the ended events once`); PR clearing remains independent. Multiple invalid entries share the fallback alarm, whose details indicate their count. Once all ids are valid and unique, clear the fallback and reconcile superseded keys normally. This path also handles malformed hand-edited data even though the store's generator produces valid ids.

**Overrides that ended between polls still produce an attention event.** Reading only the current view misses a confirmed loosening override that started and then expired (or was superseded) between two runs: it is never in any run's current view, so it is never published and never cleared, and the guard was off with no event. So `runOnce` also keeps an override log cursor, `overrideLogCursor` (`{ position, entryId, hash }`), in the feed state file, and passes it as `after` to the one `readOperatorOverrideLog` call. Because the current view and the history come from the same read at the same `now`, a record is either still effective (and in `entries`, so it publishes as `override-loosening`) or already ended (and handled here); it cannot slip between two reads. For every confirmed loosening record in `records` that has already ended (`endedBy` is `expired` or `superseded`) and whose `override-loosening` key never appears anywhere in the feed file (checked against the feed file's lines, not `openKeys`), the run publishes one `NEEDS-YOU operator-override#0@<entryId>:override-loosening-ended` line naming the key, value, actor, approval time, `at` and `endedAt`. A record that was published while active only clears, with no ended event. This happens on the first run after the record, however long ago it expired. The cursor then moves to the read's `cursor`, in the same atomic state write as the run's open keys, under the feed lock.

- **One-shot items.** `override-loosening-ended` items go to `diffFeed` in a separate `oneShot` list: they are written as `NEEDS-YOU` lines but never added to `openKeys`, so no `NEEDS-YOU-CLEARED` ever follows them. `unacknowledged()` keeps showing them until the operator acknowledges past them.
- **Unreadable history.** When the read is not readable, the cursor stays where it is, the run publishes `operator-override#0@history:history-unreadable` (its own key, separate from `layer-unreadable`, which follows the current view), and the ended events come on the first readable run. That item clears when the history reads again.
- **Rewritten log.** When the read reports `rewritten: true` (the cursor is past the end or its record no longer matches), the run publishes `operator-override#0@history:history-rewritten`, a one-shot item, and rescans every record from the start. The feed-file check above deduplicates events already published, so only missed ones appear.
- **Crash and first run.** A crash after the lines are appended but before the state write is deduplicated by the same feed-file check, so no ended event is published twice. A missing cursor (first run after rollout, or a new feed path) starts at the beginning of the log, with the same check. The run handles at most 1000 records (the read's `limit`) and continues from the cursor next run. Named tests: `a first run with no cursor replays the whole log history once` and `a history longer than the per-run limit continues from the cursor on the next run`.

**`diffFeed` changes.** Today `diffFeed` takes one `incomplete` flag: it suppresses every clear and holds every earlier key open. This slice changes it to take incompleteness per source. Override keys (`repo === "operator-override"`) are held open when the layer is unreadable or contains invalid/duplicate ids, and PR keys only when the queue report is incomplete. It also takes the `oneShot` list above, published but never kept in `openKeys`. `publishAttention` keeps passing a value that holds every key open, as it does today.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/operations/__tests__/needs-you-feed.test.mjs and we:scripts/operations/__tests__/delivery-metrics.test.mjs. Every feed test below drives `runOnce` with an injected queue report and override layer, and asserts on the lines in the feed file. Named tests, one per guarantee:
  - `runOnce publishes a confirmed loosening override to the feed file with its key, expiry, actor, time and instruction`
  - `runOnce does not publish a non-loosening override or an unconfirmed loosening entry`
  - `an expired override emits NEEDS-YOU-CLEARED on the next run, and the PR items in the same run still publish`
  - `an override that expired between polls publishes an override-loosening-ended event on the next poll` (the record is confirmed, loosening, created after the last run and expired before this run; assert one `override-loosening-ended` line with its key, actor, `at` and `endedAt`, that `unacknowledged()` returns it until acknowledged, and that no `NEEDS-YOU-CLEARED` follows it)
  - `an override superseded between polls publishes an override-loosening-ended event on the next poll` (loosening then safe re-set, both between runs)
  - `the override log cursor advances only on a readable history, and an unreadable history publishes history-unreadable and delivers the ended events on the first readable run`
  - `a record still active at this run's now publishes as override-loosening and, once it ends, only clears` (current view and history taken from one read at one `now`; a record that ends between two separate reads is the regression this pins)
  - `a rewritten or truncated log publishes history-rewritten and rescans, publishing only the ended events not already in the feed file`
  - `a crash between appending ended events and writing the state does not publish the same ended event twice`
  - `an override that was published before it expired emits only NEEDS-YOU-CLEARED, not a second ended event`
  - `diffFeed publishes oneShot items without adding them to openKeys`
  - `an override feed key parses with the existing fromKey, so a later clear never throws`
  - `re-setting an override with a new value or expiry publishes a new line`
  - `a superseded loosening entry clears when the latest value is safe, and re-setting to another loosening entry clears the old key and publishes the new one`
  - `an unreadable override layer publishes one layer-unreadable item, keeps earlier override entries open and emits no override clear`
  - `an unreadable override layer does not stop PR items from clearing, and an incomplete queue report does not stop override clears`
  - `publishAttention still holds every earlier key open, PR and override alike`
  - `runOnce publishes a visible fallback for an invalid entryId` (missing, non-string, empty, newline, delimiters, dot/path names, Unicode/invisible characters and 129 characters; assert the fallback parses with existing fromKey)
  - `invalid entryIds hold earlier override keys open, publish valid overrides and allow PR clears; fixing the ids clears the fallback`
  - `invalid or duplicate entryIds hold the override log cursor in place, and fixing the ids delivers the ended events once` (assert the state file's `overrideLogCursor` is byte-identical after each invalid run, for a missing, malformed, over-long and duplicate id; then fix the ids and assert the cursor advances to the read's `cursor` and each pending `override-loosening-ended` line appears exactly once)
  - `duplicate entryIds publish the fallback instead of collapsing two active overrides into one feed key`
  - `the invalid-identity fallback key parses with the existing fromKey during rollback and recovery`
  - `runOnce quotes and sanitizes hostile instruction, key, actor and value` (on both `override-loosening` and `override-loosening-ended` lines; newline, CR, U+2028, quotes, backticks, leading --, path .., markup, Unicode/invisible characters and a forged NEEDS-YOU line; assert exact feed-file bytes, no extra feed records, no raw reason or markup, and one parsed untrusted field)
  - `two override entries stay distinct in unacknowledged and the session bootstrap`
  - `parseFeedLine reads an override line, an override cleared line and an override-loosening-ended line`
  - `a first run with no cursor replays the whole log history once` (no `overrideLogCursor` in the state file, as after rollout or a new feed path, with a log holding ended, still-active and safe records: assert one `override-loosening-ended` line per ended confirmed loosening record, one `override-loosening` line per active one, nothing for safe ones, and that a second run publishes nothing new)
  - `a history longer than the per-run limit continues from the cursor on the next run` (1001 or more ended records with `limit` 1000: the first run publishes the first 1000 and stores their cursor, the next run publishes the rest, no record is skipped or published twice, and an unreadable read between the two runs keeps the cursor)
  - `history-unreadable clears when the history reads again and history-rewritten is published once with no clear`
  - `delivery-metrics counts override entries apart from PR needs-you episodes and waits` (including `override-loosening-ended`, `history-unreadable` and `history-rewritten` lines)

## Non-goals

- [N1] Does not change the guard floor or the store; display only.
- [N2] Does not change we:scripts/operations/operator-queue.mjs or its report.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — instruction, key, actor, value and other store-derived display fields go through `sanitizeForFeed` and are shown only in the `(untrusted)` JSON-quoted field, never in the static 100-character `reason` field and never rendered as markup. Sanitize the complete composed display text so concatenating individually safe fragments cannot forge a feed line. The id is validated separately before it becomes a feed key.
2. **Truncated reads** — when `readable` is false, the run publishes one `operator-override#0@layer:layer-unreadable` item, which the operator sees even though the live job runs with a silent log. Earlier override keys stay open, so no false clear says a guard is back on. The item clears once the layer reads again. An unreadable history publishes its own `operator-override#0@history:history-unreadable` item and keeps the cursor; a rewritten log publishes a one-shot `history-rewritten` item and rescans.
3. **Shared state files** — override keys and `overrideLogCursor` live in the same feed state file, written atomically under the existing feed lock. Incompleteness is kept per source: an unreadable layer holds only override keys open, and an incomplete queue report holds only PR keys open. A crash between line append and state write is deduplicated against the feed file's lines. The current view and the history come from one log read at one `now`, so no record falls between two reads.
4. **Fail closed** — a failure to read the layer never hides other entries: PR items still publish and clear in the same run, and earlier override entries stay open.
5. **Identity scoping** — n/a: no identity decision is made here.
6. **State over time** — consume slice 1's latest-entry-per-key view. Expired or superseded loosening entries clear on the next complete override read, with a `NEEDS-YOU-CLEARED` line; a safe replacement leaves no old loosening alarm active. A confirmed loosening entry that started and ended between two polls is read from slice 1's history after `overrideLogCursor` (taken from the same read as the current view) and publishes one `override-loosening-ended` event on the next poll; test `an override that expired between polls publishes an override-loosening-ended event on the next poll`. An unreadable layer or invalid identity holds earlier override keys open, and the cursor in place, until recovery; tests `an unreadable override layer publishes one layer-unreadable item, keeps earlier override entries open and emits no override clear`, `the override log cursor advances only on a readable history, and an unreadable history publishes history-unreadable and delivers the ended events on the first readable run` and `invalid or duplicate entryIds hold the override log cursor in place, and fixing the ids delivers the ended events once`. A first run replays the whole history once and a long history continues across runs; tests `a first run with no cursor replays the whole log history once` and `a history longer than the per-run limit continues from the cursor on the next run`.
7. **Who wrote it** — each feed line names the actor and time from the store's log entry.
8. **Downstream readers** — the feed lines are read by `parseFeedLine`, by `unacknowledged()` (which the session bootstrap in we:scripts/operations/operator-session-bootstrap-io.mjs uses, keyed by `keyOf`) and by we:scripts/operations/delivery-metrics.mjs. we:scripts/conveyor/health-watch.mjs only publishes through `publishAttention` and is unaffected. Delivery metrics leave out `repo: "operator-override"` entries, including `override-loosening-ended`, from PR episodes and waits.
