---
bornAs: x5wqxb3
kind: epic
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/operations/cli-adapter.mjs"]
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

**Index entry** (`<runsDir>/../review-run-index/`): one empty file per run, named `<runId>@<repoKey>@<pr>`, where `repoKey` is the lowercase repo, URL-encoded. It is created exclusively (`wx`) BEFORE the first `writeRun` of that id. An entry is never rewritten.

**Identity invariant (new, enforced by the writer):** a `review-pr` record's `input.repo` and `input.pr` never change across rewrites of the same id. `writeRun` checks that an entry for its own (id, repo, pr) exists (one `stat`). If it does not, it creates the entry with an exclusive per-id claim file (`ids/<runId>`, `wx`, holding the key). If the claim already holds a different key, `writeRun` throws: an identity change is refused, never indexed twice. This turns the index entry into a permanent fact about the record, not a guess about its current bytes.

**Reader (fresh every call, no cache, no metadata skip):**
1. `readdir(runsDir)` → the set R of `review-pr-*` ids (about 160 ms for 144k names, measured). No parse.
2. `readdir(review-run-index)` → a map from each indexed id to its (repo, pr).
3. The candidates are every id in R that is **either unindexed, or indexed to this (repo, pr)**. Each candidate is read and parsed in full, every call, and filtered on content exactly as today (`op`, `input.repo`, `input.pr`, head). A corrupt candidate still throws.
4. An id skipped in step 3 is skipped only because its permanent, writer-enforced identity is a different PR. Its bytes, mtime and size are never consulted.

The fallback is built in. An id with no entry (written by an older daemon build, by `migrateLegacyRuns` at `we:scripts/operations/run-store.mjs:83-98` which renames files in without calling `writeRun`, written before the backfill, or lost to a crash) is simply read in full. A missing or unreadable index directory means every id is unindexed, which is today's full scan and gives the same answer. Unknown stays unknown. Only "proven to be another PR" is skipped.

## Invariants (revised after the Codex guard critique, 2026-10-20)

- I1: an index entry is published (claim and entry written, fsynced, directory fsynced) before the record's first rename. A claim is written to a temp name and then `link()`ed to `ids/<runId>`. That is atomic and exclusive, so no reader ever sees an empty or partial claim.
- I2: `input.repo` and `input.pr` are immutable per id. This is NOT true today. A fresh invocation with an existing `--run-id` builds a new record and overwrites the old one unchecked (`we:scripts/operations/cli-adapter.mjs:1295`, `we:scripts/operations/review-loop-cli.mjs:659`). Resume already keeps the saved input (`we:scripts/operations/cli-adapter.mjs:460`). Slice 0 makes `writeRun` refuse an identity change: it compares against the claim, or against the existing record when there is no claim yet, BEFORE any entry is published.
- I3: the reader skips an id only when exactly one well-formed claim and entry name it, they agree, and they name a different PR. No mtime, size, inode or settle window takes part.
- I4: a missing, duplicate, conflicting, malformed or partial entry means "unknown", and the record is read in full. An entry can make the reader read fewer files only through I3.
- I5 (writer fence): the indexed reader is enabled only while every live daemon build includes the I2 enforcement. An older build could still reuse a `--run-id`. The reader checks the running build shas, which the daemon-rebuild records; an unknown build means a full scan.
- Run paths that are symlinks are refused, because `writeJsonAtomic` follows them (`we:scripts/lib/atomic-json-file.mjs:74`) and one id could replace another id's target.

## Failure modes

- Crash between entry and record: an entry with no record. The id is not listed in the run store, so it matches a full scan.
- Record kept but entry lost (crash or power loss): unknown, so the record is read (I4).
- `migrateLegacyRuns` (`we:scripts/operations/run-store.mjs:83-98`) renames files in without `writeRun` and has an exists-then-rename overwrite race. Slice 0 routes it through the same identity check, with no overwrite. Until then its files are unindexed and read in full.
- Backfill: it is correct only under I2 + I5. The identity it records can no longer change, so parse-then-publish has no race.
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
2. [xukmjgl](/backlog/xukmjgl/) **Reader switch behind a cascade setting** (size 3, delivery: prototype; needs Option A ratified plus the I5 fence). `redTeam.reviewRunIndexReader` (standard `shadow`, then `on`), logged with its source each pass. It switches after a mismatch-free shadow soak (for example, 3 days or more and 1,000+ compared calls). Scope: the same two readers, `we:scripts/lib/drain-saved-red-team.mjs`, the settings files.
3. [x0lckod](/backlog/x0lckod/) **Retire the full scan to fallback only** (size 2, delivery: pr). Delete the shadow comparison. Retain the full scan for a missing/unreadable index directory (I4) and whenever the writer fence (I5) cannot prove every live daemon build enforces slice 0, including older or unknown builds. Check the fence on every evidence/provenance read so a daemon rollback restores full scanning. Missing or invalid per-run entries still require fresh full reads of those records (I4). Optionally move `we:scripts/conveyor/review-referral-hold.mjs:122-150` (which has its own mtime/size projection cache, the same race class) onto the index.

## Proof required (each slice)

Before/after on the LIVE store, not only unit tests: per-call ms and per-pass `mergeCascade` seconds; identical evidence/provenance answers for every ready PR; a Codex guard audit verdict of NOT WEAKENED on the slice diff.

## Acceptance

- [A1] **Executable** — on the live shared run store, a timed `readDrainRedTeamEvidence` call for each ready PR takes under 1 s, where it takes about 9 s today, and returns the same evidence as the full scan.
- [A2] **Must refuse** — a missing, duplicate, conflicting, malformed or partial index entry falls back to reading that record in full. A `review-pr` identity change is refused at write time.
- [A3] **Must** — the Codex guard audit returns NOT WEAKENED on each slice diff, given the ruling recorded for Option A.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No metadata-skip cache (mtime/size/inode/settle window) of any kind. The parked `lane/hot-cascade-run-index-v2` is superseded, not revived.
- [N2] It does not change what counts as red-team evidence for a PR. It only changes which files are opened to find it.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: index entries carry only a run id, a URL-encoded repo and an integer PR. Malformed names are treated as unknown (I4).
2. **Truncated reads** — a partial claim cannot be seen, because it is published with temp+link. A torn record that is still read throws, as today.
3. **Shared state files** — the index is shared across daemons. Claims are exclusive (`link`), and entries are never rewritten.
4. **Fail closed** — any doubt about an entry means the record is read in full. A missing index means a full scan (today's answer).
5. **Identity scoping** — the index is keyed by lowercase repo + PR. The head is filtered on record content, so head moves need no index work.
6. **State over time** — pruning deletes the record, then the entry. An orphan entry is harmless, and an orphan record is read.
7. **Who wrote it** — the writer fence (I5): the indexed reader runs only while every live daemon build enforces I2.
