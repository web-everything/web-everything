---
bornAs: x5wqxb3
kind: epic
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/lib/__tests__/review-run-index.test.mjs", "we:scripts/operations/__tests__/run-store.test.mjs", "we:scripts/lib/__tests__/review-run-index.validation.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Per-PR review-run identity index so the drain's red-team evidence read stops parsing every run

readDrainRedTeamEvidence and saved-red-team provenance each parse all ~6.5k review-pr run records (1.57 GB) per call: ~9.1 s per call, 200-600 s of each ~22-min mergeCascade pass. Designed replacement for four caches the Codex guard audit rejected as WEAKENED: the run-store writer publishes a permanent per-run identity entry (repo+PR) before each record; the reader reads every unindexed or same-PR record fresh and skips only records whose writer-enforced identity is another PR. Needs one operator ruling: a PR's evidence depends only on its own records.

Operator approved scoping this as designed work on 2026-10-20. The design below was critiqued by Codex against its earlier WEAKENED findings, and those points are folded in.

## Problem (measured 2026-10-20)

Line refs in `we:scripts/lib/drain-red-team-evidence.mjs`, `we:scripts/lib/saved-red-team-provenance.mjs` and `we:scripts/lib/drain-saved-red-team.mjs` are from the deployed drain build (overlay `a5c23adad5`). Other refs are from `main` `9cf8d0cd9`.

`readDrainRedTeamEvidence` (`we:scripts/lib/drain-red-team-evidence.mjs:30`) finds "the latest review-pr run for this repo/PR/head" by listing and parsing EVERY `review-pr-*` record in the shared run store (`latestRun`, lines 46-53). In the same call, `readSavedRedTeamResult` (`we:scripts/lib/drain-saved-red-team.mjs:32`, called at `we:scripts/lib/drain-red-team-evidence.mjs:40`) runs `verifySavedRedTeamProvenance` (`we:scripts/lib/saved-red-team-provenance.mjs:18-42`), which does the same full parse a second time (lines 21-22). Live store on 2026-10-20: 143,970 records in total, 6,508 `review-pr-*` records (1.57 GB), across 2,664 PRs. Runs per PR: median 1, p95 6, max 195. One full parse takes about 6.8 s, and one evidence call takes about 9.1 s. The callers are the drain cascade (`we:scripts/lib/drain-merge-strategy.mjs:267`), the enqueue path (`we:scripts/lib/enqueue-on-event.mjs:533-534`), the advisory sweep (`we:scripts/conveyor/advisory-label-sweep.mjs:141`) and the review job (`we:scripts/operations/review-job.mjs:292,521`). At 1-3 calls per candidate and about 20 candidates, that is 200-600 s of each ~22-min `mergeCascade` pass.

Four cache attempts were rejected by the Codex guard audit as WEAKENED. The last one is parked on `lane/hot-cascade-run-index-v2`: it skipped files by stat identity (dev/ino/size/mtime/ctime), with a settle window and a re-stat. Any skip based on file metadata has a stat-to-skip race, and the audit treats any change from "unknown" to "proven" as weakening. This design skips NO file on the strength of metadata. It skips a file only on a writer-enforced, permanent identity fact. Codex still judges that switch WEAKENED on one point (see "The decision this needs").

## Design: a writer-owned identity index

The writer is single. `writeRun` (`we:scripts/operations/run-store.mjs:206-213`) is the only path that writes a `review-pr` record, and `assertReviewRunNamespace` (lines 158-163) makes the `review-pr-` file name true (PR #5520). Records are written atomically (temp file + rename, `we:scripts/lib/atomic-json-file.mjs`), but the same id is rewritten in place many times while a review runs. The head (`findings.read.netBasis.rev`) is set only once the read step finishes. So the index is keyed by **repo + PR, not by head**. The reader still filters by head on the record's content, so a head move needs no index work.

**One index per run store** (red-team break on head `4b622bedb`). The index lives INSIDE the store it describes: `<dir>/.review-run-index/`, where `<dir>` is the same `dir` argument `writeRun`, `listRunIds` and both readers already take. It is never derived from a parent directory, an environment variable or another store. An earlier draft used `<runsDir>/../review-run-index/`: two sibling stores (`…/.operations/first`, `…/.operations/second`) then shared one claim path `ids/<runId>`, so a valid write of the same id to the second store was refused as an identity change, and the first store's claim could wrongly satisfy I3 for the second store's record. Everything the index holds lives under that one directory: claims (`ids/`), entries, temp and quarantine names, and the I5 generation, validity and writer-history state. So a store's index can only describe that store's own records. The same store reached through a symlink resolves to the same directory and the same index. The leading dot keeps it out of the record listing: `listRunIds` keeps only `*.json` names that pass `isValidRunId`, which must start with a letter or digit.

**Index entry** (`<dir>/.review-run-index/`): one empty file per run, named `<runId>@<keyDigest>`. The identity key is the canonical string `<lowercase repo>\n<pr>`, and `keyDigest` is its SHA-256 as 64 lowercase hex characters. One shared helper builds the key for the writer, the backfill and the reader: the repo is lowercased with plain `toLowerCase()` (never locale-aware), and the PR is written as `String(Number(pr))`, only when `Number(pr)` is a positive safe integer. This matches the content filter's `Number(run.input?.pr) === Number(pr)`, so `5742`, `"5742"`, `"05742"` and `"5742.0"` all hash the same. A record whose PR fails that rule gets no entry and is always read; a query PR that fails it means a full scan. It is created exclusively (`wx`) BEFORE the first `writeRun` of that id. An entry is never rewritten.

**Bounded names (red-team break on head `3d16f726`).** The repo and PR never appear in any index file name: `input.repo` has no length cap, and a valid identity (a 128-character run id, a 39/100-character repo) made the earlier `<runId>@<URL-encoded repo>@<pr>` name 273 bytes, which `stat`/`open` refuse with `ENAMETOOLONG`. Every index name is built from `isValidRunId` (at most 128 ASCII bytes, never `@`) plus fixed-length parts, so an entry name is at most 193 bytes and a claim name at most 128, under the 255-byte name limit for every valid run. Temp names (claim temps, quarantine and generation files) use a fixed-length random token, never the run id or key. A name that cannot be built within the limit makes `writeRun` throw before the record is written; it never truncates. The full path is bounded too: `runsDir` comes from the environment, and index paths are longer than record paths. At store setup, if the longest possible index path (for a 128-character run id) would exceed the platform path limit, indexing is disabled for that store: records are written with no entry, so they stay unindexed and are read in full. A valid run is never refused for its index path.

**Identity invariant (new, enforced by the writer):** a `review-pr` record's `input.repo` and `input.pr` never change across rewrites of the same id. `writeRun` checks that an entry for its own (id, keyDigest) exists (one `stat`). If it does not, it creates the entry with an exclusive per-id claim file (`ids/<runId>`, `wx`, holding the full canonical key and its digest). If the claim already holds a different key, `writeRun` throws: an identity change is refused, never indexed twice. This turns the index entry into a permanent fact about the record, not a guess about its current bytes.

**Reader (fresh every call, no cache, no metadata skip):**
1. `readdir(runsDir)` → the set R of `review-pr-*` ids (about 160 ms for 144k names, measured). No parse.
2. `readdir(<runsDir>/.review-run-index)` (this store's own index) → a map from each indexed id to its key digest.
3. The candidates are every id in R that is **either unindexed, or indexed to this (repo, pr)'s digest**. A digest differs only when the key differs, so a mismatch proves another PR; a hash collision can only add a candidate, never skip one. Each candidate is read and parsed in full, every call, and filtered on content exactly as today (`op`, `input.repo`, `input.pr`, head). A corrupt candidate still throws.
4. An id skipped in step 3 is skipped only because its permanent, writer-enforced identity is a different PR. Its bytes, mtime and size are never consulted.

The fallback is built in. An id with no entry (written by an older daemon build, by `migrateLegacyRuns` at `we:scripts/operations/run-store.mjs:83-98` which renames files in without calling `writeRun`, written before the backfill, or lost to a crash) is simply read in full. A missing or unreadable index directory means every id is unindexed, which is today's full scan and gives the same answer. Unknown stays unknown. Only "proven to be another PR" is skipped.

## Invariants (revised after the Codex guard critique, 2026-10-20)

- I1: an index entry is published (claim and entry written, fsynced, directory fsynced) before the record's first rename. A claim is written to a fixed-length random temp name and then `link()`ed to `ids/<runId>`. That is atomic and exclusive, so no reader ever sees an empty or partial claim.
- I2: `input.repo` and `input.pr` are immutable per id. This is NOT true today. A fresh invocation with an existing `--run-id` builds a new record and overwrites the old one unchecked (`we:scripts/operations/cli-adapter.mjs:1295`, `we:scripts/operations/review-loop-cli.mjs:659`). Resume already keeps the saved input (`we:scripts/operations/cli-adapter.mjs:460`). Slice 0 makes `writeRun` refuse an identity change: it compares against the claim, or against the existing record when there is no claim yet, BEFORE any entry is published.
- I3: the reader skips an id only when exactly one well-formed claim and entry name it, they agree (the entry's digest is the SHA-256 of the claim's key), and their digest differs from this (repo, pr)'s digest. No mtime, size, inode or settle window takes part.
- I4: a missing, duplicate, conflicting, malformed or partial entry means "unknown", and the record is read in full. An entry can make the reader read fewer files only through I3.
- I5 (writer fence and history): the indexed reader is enabled only while every writer enforces I2 **and** a durable valid generation proves no incompatible/unknown writer interval since reconciliation. An older build could reuse a `--run-id` and leave an agreeing but stale claim/entry. Current daemon build shas alone cannot prove history. Invalidate before incompatible writer admission, preserve invalidation across restart/re-upgrade, and require complete exclusive reconciliation before skips resume (protocol below). Unknown current builds, history or validity mean full scan. Recheck the fence and generation on every read and before returning indexed results.
- Run paths that are symlinks are refused, because `writeJsonAtomic` follows them (`we:scripts/lib/atomic-json-file.mjs:74`) and one id could replace another id's target.

## Failure modes

- Crash between entry and record: an entry with no record. The id is not listed in the run store, so it matches a full scan.
- Record kept but entry lost (crash or power loss): unknown, so the record is read (I4).
- `migrateLegacyRuns` (`we:scripts/operations/run-store.mjs:83-98`) renames files in without `writeRun` and has an exists-then-rename overwrite race. Slice 0 routes it through the same identity check, with no overwrite. Until then its files are unindexed and read in full.
- Backfill: it is correct only under I2 + I5 and the exclusive writer barrier. Initial backfill cannot certify an uncertain history; reconciliation must rebuild a complete generation, quarantining stale claims/entries.
- Two writers on one id: `link()` picks one claim. The loser either matches (no-op) or throws (I2).

## The decision this needs (operator ruling, before slice 2)

Codex judged the switched reader **WEAKENED on one point the design cannot remove**. Today a corrupt or vanished (pruned mid-scan) `review-pr` record for ANY PR makes every PR's evidence read refuse, because `latestRun` reads every listed file before it filters (`we:scripts/lib/drain-red-team-evidence.mjs:47`). Provenance is the exception: it stops at the first valid proof, so corruption after that point is never seen (`we:scripts/lib/saved-red-team-provenance.mjs:21-41`). Any reader that does not open other PRs' bytes turns that refusal into an answer. A corruption sweep cannot keep parity between its runs.

- Option A (recommended): ratify **"a PR's red-team evidence depends only on that PR's records."** One damaged record would no longer freeze evidence for every PR. Instead, a separate store-health check raises a loud alarm on any corrupt `review-pr` record. Then slices 2-3 ship.
- Option B: keep store-wide refusal as a protected property. Then only slices 0-1 ship: the identity hardening and shadow measurement. The read stays about 9 s per call. The only remaining lever is sharing one full scan per call between `latestRun` and provenance (about 2x). Even that changes snapshot ordering and needs its own audit.

## Expected gain

- Per call: the two full parses (about 2 × 4.5-6.8 s) become 2 readdirs (about 170 ms) plus parsing this PR's own runs (median 1, p95 6; about 240 KB each, so about 5-30 ms). That is about **9.1 s → ~0.2-0.4 s**.
- Per pass: **200-600 s → about 10-25 s** of each ~22-min `mergeCascade` pass.

## Slice plan

0. [xl3mmn5](/backlog/xl3mmn5/) **Identity hardening** (size 3, delivery: pr; correct on its own). `writeRun` refuses a `review-pr` identity change (I2). It refuses symlinked run paths. `migrateLegacyRuns` validates identity and never overwrites. Scope: `we:scripts/operations/run-store.mjs`, `we:scripts/operations/cli-adapter.mjs`, tests.
1. [xbyg4e4](/backlog/xbyg4e4/) **Writer index + backfill + shadow reader** (size 5, delivery: shadow). `writeRun` publishes entries per I1. A one-shot backfill parses every existing `review-pr-*` record once and creates its entry. A record whose current content has no valid repo/pr gets no entry, so it stays unindexed and is always read. `migrateLegacyRuns` indexes what it moves. The shadow reader runs the indexed reader beside the full scan in `readDrainRedTeamEvidence` and `verifySavedRedTeamProvenance`, returns the full-scan answer, and logs any mismatch plus unindexed-count/timing per pass. Scope: `we:scripts/operations/run-store.mjs`, `we:scripts/lib/review-run-index.mjs` (new), `we:scripts/lib/drain-red-team-evidence.mjs`, `we:scripts/lib/saved-red-team-provenance.mjs`, tests.
2. [xukmjgl](/backlog/xukmjgl/) **Reader switch behind a cascade setting** (size 8, delivery: prototype; needs Option A ratified plus the complete I5 fence/history protocol). `redTeam.reviewRunIndexReader` (standard `shadow`, then `on`), logged with its source each pass. Requires at least 3 days and 1,000 successful mismatch/error-free shadow comparisons. Durable invalidation at external writer admission and complete exclusive reconciliation are prerequisites; the estimate includes this expanded safety scope. Do not implement a current-build-only shortcut.
3. [x0lckod](/backlog/x0lckod/) **Retire the full scan to fallback only** (size 2, delivery: pr). Delete shadow comparison. Retain full scan for missing/unreadable index directories and every I5 failure: older/unknown writers, missing/unreadable history or validity, prior incompatible intervals, and incomplete reconciliation even after re-upgrade. Check the fence/generation on every evidence/provenance read and before return. Missing or invalid per-run entries still require fresh full reads (I4). Optional referral-reader migration requires the same integration coverage; otherwise exclude it.

## Proof required (each slice)

Before/after on the LIVE store, not only unit tests: per-call ms and per-pass `mergeCascade` seconds; identical evidence/provenance answers for every ready PR; a Codex guard audit verdict of NOT WEAKENED on the slice diff.

### Rollback history is part of index validity

A passing live-build fence alone cannot authorize skips. An incompatible or unknown writer interval durably invalidates the index generation, including identities already claimed before that interval. Returning all writers to a compatible build does not clear invalidation. Until reconciliation has freshly read every record under an exclusive compatible-writer barrier, repaired or quarantined stale claims and entries, and atomically published a new valid generation, every reader uses the authoritative full scan. Missing, unreadable, interrupted or uncertain validity state also means full scan. Reconciliation failure or a writer entering during reconciliation leaves the generation invalid; it must never certify a partial scan. A reader rechecks validity and the writer fence on every read and before returning indexed results, discarding those results if either changed.

Planned regression: `we:scripts/lib/__tests__/review-run-index.test.mjs` → `old_writer_interval_requires_revalidation_before_index_reenable`: index run R for PR A, enter an older/unknown-writer interval, reuse R for PR B, then restore compatible writers. Assert invalidation survives reader/daemon restart and re-upgrade, B's record is freshly read and returned by full scan despite the old agreeing A claim/entry, failed/interrupted reconciliation cannot enable skips, and only complete reconciliation under the writer barrier publishes a valid generation whose B evidence equals the full scan. Writer admission must invalidate durably **before** an incompatible writer can mutate records; an unprovable writer history cannot be certified merely by sampling current daemon builds. Slice 2 must establish this protocol before switching; slice 3 must retain it.

## Planned validation (shared by all four slices)

These are future implementation requirements, not results from this cards-only PR. Planned file: `we:scripts/lib/__tests__/review-run-index.validation.test.mjs`. The live cases require an explicit read-only live-store target and captured before/after receipts; missing receipts are incomplete proof, not a passing skipped test. Run for each slice using `npm run test:unit -- <test-file>` from WE with this file's path after `we:` in its implementation validation environment. Switched-path performance validation uses explicit `on`; after retirement an omitted/default `shadow` setting remains authoritative full scan without comparison (slice 3 A4).

| Acceptance / guarantee | Named case | Observable assertion |
| --- | --- | --- |
| A1, live per-call and cascade performance | `live_ready_pr_reads_meet_latency_budget` | Enumerate every ready PR, record store/build/generation identity and baseline/changed per-call ms plus mergeCascade pass seconds. For switched slices 2-3 each measured evidence call is under 1,000 ms; report measured cascade reduction against the same candidate set (10-25 s is an estimate, not a fabricated result). For slices 0-1 record full-scan and shadow timing without claiming the production speedup already exists. |
| A1, evidence and provenance parity | `live_ready_pr_evidence_matches_full_scan` | For every ready repo/PR/head compare full evidence, provenance and refusal outcomes from full scan versus the new path on an unchanged snapshot under a writer barrier; replay any live concurrent discrepancies under that barrier. Include current/stale heads, saved evidence and absence of evidence. Assert equality on a valid store and on same-PR/unindexed candidate errors; any remaining mismatch blocks promotion. Other-PR corruption under ratified Option A is the explicit exception below. |
| A2, unknown states and identity refusal | `invalid_index_states_force_fresh_record_reads` / `rejects_identity_change_without_modifying_record` | Planned in `we:scripts/lib/__tests__/review-run-index.test.mjs` and `we:scripts/operations/__tests__/run-store.test.mjs` respectively; assert every unknown record opens on each call and every changed-identity write leaves record/claim bytes unchanged (full matrices in slices 0-1). |
| A3, each slice's audit | `each_slice_requires_not_weakened_audit` | Parameterize xl3mmn5, xbyg4e4, xukmjgl and x0lckod; require a Codex guard receipt matching that exact slice diff/head and the recorded ruling where applicable, with verdict NOT WEAKENED. Missing/stale receipts or WEAKENED verdicts fail validation. Receipt fixtures must demonstrate each rejection. |
| Option A exception and alarm | `corruption_alarm_preserves_candidate_refusals` | Planned in `we:scripts/lib/__tests__/review-run-index.test.mjs` (slice 2); other-PR corruption may cease blocking this PR only after Option A is ratified, and must emit a store-health alarm. Same-PR/unindexed corruption still follows base refusal. Option B retains the authoritative full scan and blocks slices 2-3. |

Every slice's A3 references these live/audit cases; each slice also maps its individual behavioral guarantees to repository-qualified named cases and observable assertions. Validate assertion adequacy during preparation, not just the presence of a test name.

## Prevention tracked from PR #5742 advisory

- Coverage/preparation gate: existing card [5360](/backlog/5360/) tracks deterministic refusal of completed preparation with executable Acceptance placeholders or guarantees lacking a repository-qualified planned test, named case and observable assertion, explicitly including omitted-setting defaults. This PR extends that card's executable plan rather than filing duplicate debt.
- Rollback history: [xukmjgl](/backlog/xukmjgl/) is the prevention implementation card for durable invalidation across incompatible/unknown writer intervals and reconciliation before re-enabling skips. Its A2 is blocked on `old_writer_interval_requires_revalidation_before_index_reenable` and admission/reconciliation regressions; [x0lckod](/backlog/x0lckod/) retains them after shadow retirement. No current-build-only fence may substitute for that work.

## Acceptance

- [A1] **Executable** — the named live-performance and parity cases above establish under-1-second reads for every ready PR in switched slices and equal evidence/provenance under the recorded Option A contract. Shadow-only slices still return full-scan results and report both timings.
- [A2] **Must refuse** — missing, duplicate, conflicting, malformed or partial index state forces fresh record reads; identity-changing writes refuse without mutation. Planned cases above and in slices 0-1 assert this. I5 history gaps force full scans until the named rollback/re-upgrade and reconciliation cases in slice 2 establish safe recovery.
- [A3] **Must** — `each_slice_requires_not_weakened_audit` requires NOT WEAKENED on each exact slice diff, with the Option A ruling recorded before slices 2-3.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No metadata-skip cache (mtime/size/inode/settle window) of any kind. The parked `lane/hot-cascade-run-index-v2` is superseded, not revived.
- [N2] Keep the PR's evidence, provenance and head-selection rules. The only permitted refusal change is the explicit other-PR corruption dependency after Option A is ratified; the alarm and candidate-refusal tests above cover that exception.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — malformed run-id/digest names and noncanonical names are unknown (I4), tested by slice 1's `invalid_index_states_force_fresh_record_reads`. Repo and PR text never reach a file name (only a fixed-length digest does), so their length or characters cannot break a name; slice 1's `index_names_stay_bounded_for_max_valid_identity` covers the 255-byte boundary. No HTTP receive endpoint is introduced.
2. **Truncated reads** — a partial claim cannot be seen, because it is published with temp+link. A torn record that is still read throws, as today.
3. **Shared state files** — claims are exclusive (`link`); entries are immutable within a generation. Reconciliation quarantines obsolete generations under an exclusive barrier (slice 1 publication/concurrency and slice 2 reconciliation tests).
4. **Fail closed** — any doubt about an entry means the record is read in full. A missing index means a full scan (today's answer).
5. **Identity scoping** — the index is keyed by the SHA-256 digest of lowercase repo + PR; the claim holds the full key. Each run store has its own index inside it (`<dir>/.review-run-index/`), so sibling stores never share a claim, an entry or a generation (slice 1 `sibling_stores_have_independent_indexes`). The head is filtered on record content, so head moves need no index work.
6. **State over time** — pruning deletes the record, then the entry. An orphan entry is harmless, and an orphan record is read.
7. **Who wrote it** — I5 requires current compatible writers and durable uninterrupted history since reconciliation; re-upgrade cannot clear invalidation (slice 2 admission and rollback/re-upgrade tests).
