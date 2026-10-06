---
bornAs: x68ifx8
kind: story
size: 2
status: active
scope: ["we:scripts/conveyor/health-responder-state.mjs", "we:scripts/conveyor/__tests__/health-responder-state.test.mjs"]
dateOpened: "2026-10-02"
dateStarted: "2026-10-06"
preparedDate: "2026-10-03"
preparedAgainstSha: "4cd29d605b95337785a59fb5463807f3317f8cda"
scopeRationale: "we:scripts/conveyor/health-responder.mjs is named only as the existing shadowTick entry point the regression test imports; it needs no source edit, so it stays out of scope."
tags: []
---

# Health responder: verify cached journal segments before trusting the receipt archive

Follow-up from the #3490 advisory (operator approved #3490, 2026-10-02). The cache-hit branch in `we:scripts/conveyor/health-responder-state.mjs:110-117` returns stored receipts without opening the corresponding journal segment. Verify segment content before using archived receipts, and derive receipts from validated journal rows so cache-only alterations cannot affect responder decisions.

## Design

Keep the journal authoritative and the receipt archive rebuildable. Implement this within `we:scripts/conveyor/health-responder-state.mjs`; the existing error propagation through `readReceipts` already freezes `shadowTick` in `we:scripts/conveyor/health-responder.mjs:25-26`.

- Extend each archive segment entry with `contentHash`, a SHA-256 hex digest of the exact segment bytes, retaining the existing schema and name/receipts fields. Compute the digest during the same descriptor-based, chunked read that validates complete lines through `parseRow`. Preserve no-follow opens, regular-file checks, UTF-8 chunk handling and the partial-line refusal. Hash raw chunks, including delimiters and blank lines; do not hash reserialized rows or reopen the file for a second independent pass.
- Read and validate every enumerated segment on every archive read, including cache hits. When an entry has a valid recorded digest and the current digest differs, throw a segment-identifying integrity error. Do not silently replace that baseline, return partial receipts, or publish a partially rebuilt archive. Malformed JSON, invalid row schema, incomplete lines and unsafe/unreadable segment files also throw.
- Derive receipts from the validated rows using `receiptsFromJournal`. Return those derived values, never an unchecked cached receipt array. Compare the stored projection with the derived projection in its persisted JSON/scrubbed representation; repair altered, missing or malformed cached receipts atomically only after all segments pass validation. A separate checksum over cached receipts would not establish that they correspond to the journal.
- Preserve recovery for missing, syntactically corrupt or stale archives. Existing entries have no digest: validate and derive from their segments before adding the digest. Treat missing/invalid digest metadata as a rebuildable cache miss, not evidence of a matching segment. Retain segment enumeration/order and removal of stale index entries; never rewrite journal bytes to repair the cache.

This adds full historical segment I/O and parsing on a cache hit; chunking avoids loading entire segments as text but does not make runtime independent of history size. The digest detects changes relative to an available baseline, not authenticated tampering: loss of the archive or coordinated replacement of journal and digest cannot establish the original bytes. These limits do not weaken the requirement to validate every segment and derive every returned receipt from it.

## MVP

1. Extend the internal segment reader to produce a raw-byte digest alongside validated receipt projection, using the existing filesystem protections in `we:scripts/conveyor/health-responder-state.mjs`.
2. Replace the name-only cache-hit shortcut with validation, digest comparison and journal-derived receipts. Preserve the existing atomic archive writer and defer publication until the complete segment set succeeds.
3. Add regressions to `we:scripts/conveyor/__tests__/health-responder-state.test.mjs`, including a `shadowTick` rejection test importing the existing entry point from `we:scripts/conveyor/health-responder.mjs`. No responder entry-point changes are required.

## Test plan

Use temporary directories and real filesystem reads/writes in `we:scripts/conveyor/__tests__/health-responder-state.test.mjs`; keep the existing rotation/rebuild tests.

- Populate the archive through normal append/rotation, then corrupt a segment without deleting the archive: partial final line, malformed JSON and invalid schema must throw. Verify the failing read leaves the archive and journal bytes unchanged.
- Change a schema-valid segment row while retaining the recorded digest (include a same-byte-length edit). Reading receipts must reject the hash mismatch even though row parsing succeeds. Also change bytes that do not affect the receipt projection, proving the hash covers the entire segment.
- Keep segment bytes and digest intact but replace, remove or inject cached receipts. Reads must return exactly the journal-derived receipts and atomically repair the archive; forged identities and counts must not reach callers.
- Exercise missing archive, broken archive JSON, empty/stale index, legacy entries without hashes and invalid hash metadata. Valid segments rebuild deterministically; corrupt segments still refuse. Repeated reads of an intact archive preserve receipts and avoid unnecessary archive rewrites.
- Cover multiple segments where a later segment fails: no partial repair is published. Retain multi-byte/chunk-boundary coverage, collision ordering and rotation receipt preservation. A cached segment replaced by a symlink or directory must fail the existing filesystem guards.
- Call `appendDecisions` with a cached corrupt segment and verify no decision rows are appended. Call `shadowTick` with the same condition and a fact-reader tripwire: it must reject before facts/decisions, and leave the last-tick record unchanged. Use an absent or sub-threshold active journal so this assertion isolates the archive read rather than rotation.

## Proof plan

Run the affected Vitest file from the WE repository root: `npx vitest run` with the repository-relative argument corresponding to `we:scripts/conveyor/__tests__/health-responder-state.test.mjs`.

First add the cached-corruption and altered-receipt regressions and run them against the unchanged implementation; retain their failing output. After implementation, run the complete file and retain passing output, including the tick refusal and valid-cache controls. Inspect the temporary store bytes before/after refusal rather than relying on an exception assertion alone. The runner owns preparation checks and stamping; the implementation delivery must also pass `npm run check:standards`.

## Done when

- **Must refuse:** a malformed cached segment or a valid segment whose bytes disagree with its recorded content hash causes receipt reads and the consuming tick to fail before new decisions are recorded.
- **Must preserve authority:** altered cache data never changes returned receipt identities/counts; valid journals rebuild a lost, legacy or corrupt cache, and invalid journals are never repaired or skipped.
- **Executable:** the regressions in `we:scripts/conveyor/__tests__/health-responder-state.test.mjs` fail against the current cache-hit shortcut and pass with the implementation, using the command described in Proof plan.

## Follow-ups

Measure verification cost with realistic retained history before pursuing optimization; any optimization must retain evidence that current segment bytes and returned receipts agree. Authentication of both journal and index, detection of deleted historical segments without an independent manifest, and concurrent external rewrites require separate work if demanded; this item supplies neither a signed audit log nor a new retention policy.

## Progress

- **Delivery sanity read (2026-10-06):** the name-only cache shortcut remains present, so the spec is coherent and not superseded. Added real-filesystem regressions for partial lines, malformed JSON, invalid schema, and replaced/missing/injected/malformed receipt projections before changing the implementation.
- **Red proof:** the unchanged implementation failed 5 regressions (14 passed): cached partial lines, malformed JSON and invalid schema were accepted, and replaced/injected receipts reached callers. Full output is retained in the delivery environment at `/tmp/conveyor-4732-before.log`.
- **Implemented:** every enumerated segment is opened with the existing filesystem guards, parsed and hashed from the same raw chunks. Valid recorded digests are checked even when receipt metadata is malformed or duplicated. Returned receipts always come from validated rows; persisted projections are repaired only after all segments pass. Stale entries are removed, including when no segments remain.
- **Persistence edge case:** the existing generic text scrubber can redact some valid SHA-256 hex strings. Archive persistence now scrubs receipt projections while retaining generated digest metadata; a real-writer regression proves that these digests survive and still detect changed bytes. Undefined JSON fields and scrubbed receipt strings do not cause repeated archive rewrites.
- **Green proof:** `npx vitest run we:scripts/conveyor/__tests__/health-responder-state.test.mjs we:scripts/conveyor/__tests__/health-responder.test.mjs` passed all **52 tests** (45 state tests and 7 responder integration tests). Output is retained at `/tmp/conveyor-4732-after.log`. Coverage includes same-length edits, changes outside the receipt projection, blank-line bytes, UTF-8 chunk splits, archive recovery, atomic repairs, later-segment refusal without partial publication, symlinks/directories, and append/tick refusal with unchanged store bytes and an uncalled fact-reader tripwire.
- **Wrapper handoff:** implementation and tests are complete; edits are intentionally uncommitted. The standards gate remains for the wrapper, per the delivery brief's prohibition on agent-run gate commands.

- **Premise checked:** the original card pointed at `we:scripts/conveyor/health-responder-state.mjs:113` and described cached segments bypassing corruption freezes. The precise shortcut is `we:scripts/conveyor/health-responder-state.mjs:110-117`: parsing happens only for names absent from the cache. There is currently no segment digest field or comparison.
- **Corrected premise:** checking segment hashes alone cannot validate cached receipt payloads. `we:scripts/conveyor/health-responder-state.mjs:108` accepts any receipt array, and line 119 flattens it directly. Both segment verification and a journal-derived receipt projection are needed for the original goal.
- **Scope checked:** original and corrected edit scope remain `we:scripts/conveyor/health-responder-state.mjs` and its matching existing test `we:scripts/conveyor/__tests__/health-responder-state.test.mjs`. The caller in `we:scripts/conveyor/health-responder.mjs:25-26` already propagates receipt-read failures, so it is evidence and an integration-test entry point, not an additional source edit.
- **Coverage evidence:** `we:scripts/conveyor/__tests__/health-responder-state.test.mjs:113-119` explicitly removes the archive before corrupting a segment. It proves cache-miss refusal, not cache-hit refusal. The rebuild tests at lines 101-111 cover missing/broken/empty archives, not altered receipt arrays.
- **Observed probe:** a disposable real-filesystem Node probe appended a shadow act row and rotated it to populate the archive. Replacing the segment with an incomplete JSON line still returned the original cached receipt. Restoring the segment and changing only the cached family key returned the forged value. The probe cleaned up its temporary directory and changed no source files. The goal is not already delivered.
