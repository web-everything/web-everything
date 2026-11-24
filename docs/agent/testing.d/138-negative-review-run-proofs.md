## Negative review-run proofs

`headNeverReviewedFromRuns` proves absence through `readNamedCandidates`, independently
of the full-review index. Archive evidence, archive claims, unreadable listings or
records, malformed evidence, and missing/non-40-hex subject heads retain the
hold. Every candidate, including ids named for other PRs, is read and validated with
`assertReviewRunEvidence` on a cache miss. Payload repo/PR determines relevance
regardless of the filename's PR; corrupt or unreadable unrelated records refuse proof.
Independently list the directory before and after parsing: any review-like JSON file
omitted by candidate discovery refuses proof unless its payload validates as another
`review-*` operation (such as `review-prep` or `review-ledger-check`). These share the
run store but are unrelated operations: validate their run-record schema, payload ID,
and operation matching the filename prefix under the same parse budget, summary cache
and file-identity checks before excluding them. An omitted `review-pr-*` filename
still refuses proof. Malformed or unreadable unrelated records,
invalid filenames and mismatched IDs or operations retain the hold.
Known `.abandoned.json` tombstones and
temporary files ending in `.tmp` remain excluded. Operators must inspect and repair
omitted or malformed evidence before retrying. An unfinished review on an older head
permits a fresh full review (R640); any live-head review prevents this proof.

A process-local summary cache binds each directory/id to mtimeMs, ctimeMs, device,
size and inode; a difference in any field forces a fresh read and validation.
Read exceptions retain the current hold without caching a failed summary; the next
scan retries even when metadata is unchanged. Returned payloads rejected by scanner
validation remain cached as invalid for that identity. The transient-read regression
in `redteam-pending-settle.test.mjs` covers repeated EMFILE failures and full-review
dispatch recovery for PR, prep and ledger-check records without settling red-team pending.
Only cache misses consume `runs.scan.maxParses`, resolved through the shared settings
cascade. Reaching the limit returns false while retaining verified summaries for the
next tick. Operators can wait for subsequent ticks, inspect omitted evidence, or
explicitly raise the setting; a partial scan never authorizes a dispatch. Rewritten
records are reparsed. Before returning true, re-read the candidate snapshot and
recheck every candidate's file identity; changed or unreadable evidence returns false.

Keep the ten Tier-1 regressions in `redteam-pending-settle.test.mjs`: over-400 legacy
success and live-head refusal, unreadable heads, unrelated malformed records,
other-PR payload validation and cached reuse, bounded cache resumption, rewritten
identities (including ctime/device), omitted review filenames, listing races,
null candidate discovery, and planner cooldown/formal-review/publishability holds.
Prep fixtures cover valid coexisting records, malformed/unreadable payloads, ID/operation
mismatches, shared budget resumption, cache invalidation, and the real-file default
scanner dispatching a full review while preserving the pending red-team label.
The `unrelated %s run-store records` tests cover ledger checks and a future operation
through the same validation path. The real-file default scanner also includes a
persisted ledger check. `cached %s candidate rewritten during final snapshot refuses
proof` warms the cache for PR, prep and ledger-check records, changes metadata only
at the final identity sweep, and asserts refusal without rereading the payload plus
eviction of the stale summary. This isolates the final sweep from the parse-time check.
Keep index integrity/backfill tests in `review-run-index.test.mjs`; index corruption,
poison, overflow or eviction alone no longer determines the never-reviewed proof.
This proof only permits a full review. Red-team release still requires the unchanged
reader's finished acceptance on the live head.

