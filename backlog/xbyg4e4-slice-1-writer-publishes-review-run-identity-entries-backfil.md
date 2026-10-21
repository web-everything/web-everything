---
bornAs: xbyg4e4
kind: story
size: 5
parent: "x5wqxb3"
status: open
blockedBy: ["xl3mmn5"]
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/lib/review-run-index.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/__tests__/review-run-index.test.mjs", "we:scripts/lib/__tests__/review-run-index.validation.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 1: writer publishes review-run identity entries, backfill, and a shadow indexed reader

Epic x5wqxb3. writeRun publishes a per-run identity entry (claim via temp+link, fsynced, before the record's first rename). A one-shot backfill indexes existing review-pr records. A shadow indexed reader runs beside the full scan in readDrainRedTeamEvidence and verifySavedRedTeamProvenance: the full-scan answer stays authoritative, and each pass logs mismatches, unindexed count and timing. Shadow errors are isolated. Proof: live per-call ms and zero mismatches across every ready PR. Delivery mode: shadow.

## Acceptance

- [A1] **Executable** — planned `we:scripts/lib/__tests__/review-run-index.test.mjs` cases below pass via `npm run test:unit -- <test-file>` from WE using the path after `we:`; entries become usable only after durable publication before the record rename.
- [A2] **Must refuse** — ambiguous index state never authorizes a skip; read each such record freshly. A shadow failure cannot alter the authoritative full-scan result or refusal.
- [A3] **Executable** — run the epic's shared live-parity, live-timing and per-slice audit validation cases for xbyg4e4; record compared calls, mismatches, unindexed counts and both timings. The production answer remains the full scan throughout shadow delivery.

## Planned tests

All cases below are planned in `we:scripts/lib/__tests__/review-run-index.test.mjs`. Exercise real run-store writes and both evidence/provenance entry points, with filesystem fault injection where needed; these are plans, not test results.

| Guarantee | Named case | Observable assertion |
| --- | --- | --- |
| I1 durable atomic publication | `publication_precedes_record_rename` | Trace claim temp-write/fsync/link, entry publication, directory fsyncs and first record rename; all durability steps precede rename. Crash/error injection at each boundary leaves no record visible with a usable partial identity; next read uses a fresh record/full scan whenever proof is incomplete. |
| Bounded index names | `index_names_stay_bounded_for_max_valid_identity` | Through public `writeRun` and both public readers: runId `review-pr-` + 118 characters (128, the `isValidRunId` maximum), repo `o`×39 + `/` + `n`×100, PR 1; also a 2,000-character repo and PR `Number.MAX_SAFE_INTEGER`. The record persists (no `ENAMETOOLONG`), every name created under the index (entry, claim, temps) is at most 255 bytes, neither the repo nor the PR text appears in any name, and the readers return that record for its PR and skip it for another PR. A run id over 128 characters is refused by `writeRun` before any write. A `runsDir` whose longest index path would exceed the platform path limit disables indexing: the record still persists unindexed and both readers read it. |
| Per-store index | `sibling_stores_have_independent_indexes` | Two sibling run stores (`<tmp>/.operations/first`, `<tmp>/.operations/second`). Write `review-pr-reused` for `owner/repo` PR 1 in first, then the same id for PR 2 in second, through public `writeRun`: both persist, with no identity-change error. Each claim and entry lives under its own store's `.review-run-index/`, and nothing is created in the shared parent. Both readers on second, asked about PR 2, return second's record; asked about PR 1, they never return first's record. The same holds after a backfill of each store, run with both records written before it. `listRunIds` on either store never lists `.review-run-index`. |
| PR key canonicalization | `equal_pr_forms_share_one_digest` | Same repo, records with PR `5742`, `"5742"`, `"05742"` and `"5742.0"`, each written or backfilled, plus queries in each form: every same-PR record is a candidate (never skipped) through both readers, exactly matching the full scan's `Number(...)` filter. Mixed-case repo forms share a digest. A record PR of `0`, negative, non-integer or unsafe gets no entry and is read; such a query PR falls back to the full scan. |
| Exclusive claims | `concurrent_claims_have_one_identity_winner` | Race two writers on one id: exactly one conflicting identity publishes, the loser throws without changing winner bytes; matching writers share one complete claim/entry. No observer reads a partial claim. |
| I3/I4 exact agreement and unknown fallback | `invalid_index_states_force_fresh_record_reads` | Table-drive absent, duplicate, conflicting, malformed, truncated and partial claims/entries, including missing claim, extra entry and claim/entry repo/PR disagreement. Spy reads through both public readers: every affected record opens on each call, and corrupt candidates preserve full-scan refusal. Only one valid agreeing other-PR pair permits a skip. |
| Fresh candidates and content/head filtering | `candidate_reads_are_fresh_and_head_filtered` | Rewrite same-PR and unindexed records between calls with equal byte lengths and preserved timestamps; both readers return the new contents, filter op/repo/PR/head exactly as full scan, and observe a head move without index rewrite. Same PR in another repo cannot match. |
| Directory fallback | `missing_or_unreadable_directory_uses_full_scan` | Remove or deny index-directory access; both readers open every listed review-pr record and return/refuse exactly as the full scan. |
| Backfill and migration | `backfill_excludes_invalid_records_and_indexes_migrations` | Valid existing and migrated records get agreeing claims/entries; malformed JSON or invalid/missing repo/PR gets none and remains freshly read. A rerun is idempotent; conflicting existing claims refuse publication without overwrite. Backfill with an unproven writer fence cannot certify a generation. |
| Pruning | `pruning_preserves_candidate_refusal_and_orphan_safety` | Prune record before entry: orphan entries outside the run listing do not add evidence. A listed same-PR/unindexed record vanishing mid-read preserves the base refusal. Losing an entry while retaining a record forces a fresh read. |
| Shadow isolation and authority | `shadow_failure_preserves_full_scan_result` | Make the indexed branch throw, time out or disagree for evidence and provenance; the returned value (or thrown full-scan error) is exactly the authoritative full-scan outcome. |
| Shadow observability | `shadow_logs_mismatch_counts_and_timings` | Inject one mismatch and one shadow error; each pass emits PR identity, compared-call/mismatch/error counts, unindexed count and nonnegative full/indexed timings. Matching calls log zero mismatches; errors cannot count as successful comparisons. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No production indexed answers or automatic promotion from shadow; slice 2 owns the operator ruling and durable writer-history gate.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — malformed index identities are unknown (`invalid_index_states_force_fresh_record_reads`), not path authority. Repo/PR text never reaches a file name; names stay within 255 bytes for every valid run (`index_names_stay_bounded_for_max_valid_identity`). No HTTP endpoint is added.
2. **Truncated reads** — partial claims/entries cannot authorize skips; partial records preserve full-scan refusal (publication and invalid-state cases).
3. **Shared state files** — atomic durable publication and exclusive claims are tested at crashes and concurrent writers (A1 cases).
4. **Fail closed** — directory failure uses the full scan; shadow failure preserves its result/error (A2 cases).
5. **Identity scoping** — claim and entry must agree exactly; filter record head on every call (invalid-state and fresh-candidate cases).
6. **State over time** — backfill reruns, migration, pruning and orphan handling have named cases above; no metadata skip.
7. **Who wrote it** — unproven writer history cannot certify backfill; indexed shadow results have no production authority (backfill and shadow-isolation cases).
