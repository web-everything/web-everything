---
bornAs: xsaj6u9
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-note-comment.mjs", "we:scripts/conveyor/__tests__/reconcile-note-comment.test.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-16"
preparedAgainstSha: "1ca5edb490fbc03fe55aee05985107d6272c4628"
tags: []
---

# Fix daemon: post the round-cap-exhausted take-over note for real, and surface it as a health finding

The reported September 29 incident left PR #2867 exhausted without a posted take-over note. Preserve the goal: an exhausted PR gets a real, deduplicated operator explanation, and a prolonged exhaustion is visible to health monitoring. Posting and health monitoring now exist; the remaining change makes the requested once-per-head comment identity explicit.

## Progress

- Original premise/scope: the note path only ran in dry-run, health did not report exhaustion, and the touch set was the entire we:scripts/conveyor/ directory.
- Corrected premise at checkout 1ca5edb490 on 2026-10-16: we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:348 defaults to real posting, retaining explicit environment opt-out. Its existing injected regression at we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs:82 pins that behavior. Do not add another posting path or remove diagnostic dry-run.
- Health coverage already exists: commit d177ff48e delivered operator-hold-aged; we:scripts/conveyor/health-watch-core.mjs:404 includes cap-exhausted, and we:scripts/conveyor/__tests__/health-watch.test.mjs:1423 exercises filing and persistence for that hold. This is aged-hold detection, not an immediate finding for every tick. Preserve that existing health policy and use its regression as compatibility evidence.
- Remaining gap: we:scripts/conveyor/reconcile-note-comment.mjs:84 keys round-cap-exhausted on PR, population and attempt/cap pair, without a head. we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:402 tags only the repository before planning the comment at line 418, although the same pass supplies the PR record at line 404. Thus a trusted comment for one head can suppress the next head at the same cap, contrary to this card's explicit once-per-head requirement. The complete goal is not already delivered.
- Corrected scope: two source files and their matching suites, including the canonical daemon suite alongside its focused note suite, plus the existing health integration suite for regression validation. Retain size 2: approximately 15 lines in the note-key helper, 10 in daemon enrichment, 45 helper-test lines and 70 daemon-test lines; health coverage is already present and requires no new production code. These are source observations and estimates, not newly executed test results.

## Design

For round-cap-exhausted notes, enrich the note in we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs with the current PR head from the same pass's PR record before calling the shared comment planner. Use that enriched note consistently in returned diagnostics and planning. Do not make another forge read or infer a head from untrusted comment text.

In we:scripts/conveyor/reconcile-note-comment.mjs, use a versioned head-aware key for a round-cap-exhausted note with a known head: PR, capKind and head identify the comment. Attempts and cap remain in its visible explanation, but do not mint more comments on the same head for the same population. Different populations remain independent. Repository isolation continues through the per-repository PR/comment collection. Other note kinds retain their existing identity.

For a missing head, retain the existing attempt/cap episode key rather than inventing a shared head identity or suppressing the explanation. A legacy headless marker cannot prove that a known head was notified: allow one head-aware comment after migration, then deduplicate on its trusted marker. Keep author checks, explicit dry-run, posting-error visibility and independent parking retries intact.

Health continues to report prolonged cap-exhausted holds through operator-hold-aged. There is no second smell, immediate alert, new threshold, or health-state reset in this change.

## MVP

1. Add the failing two-head daemon regression and helper identity matrix in the two matching scoped suites.
2. Thread the observed head into the note and implement the versioned identity plus legacy fallback.
3. Preserve default real posting and the existing aged-hold health regression. Update the affected helper/daemon comments to describe the actual default and head-aware identity.

## Test plan

- In we:scripts/conveyor/__tests__/reconcile-note-comment.test.mjs, assert stable identity for the same head/population even when attempt counts advance; different heads or populations get different keys. Missing-head inputs retain the legacy key. Trusted head-aware markers suppress repeats; forged markers and old headless markers cannot suppress a known head. Other note kinds remain unchanged.
- In we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs, use an injected poster and a two-pass PR snapshot: default mode posts on head A, the trusted returned marker suppresses another A tick, and head B at the same count posts once. Repeat with identical PR numbers in two repositories to pin isolation. Exercise legacy migration, explicit dry-run, missing PR/head, post failure followed by retry, and already-posted notes whose parking still needs retry. Assert no real forge calls.
- Run the existing cap-exhausted operator-hold filing/persistence case and full we:scripts/conveyor/__tests__/health-watch.test.mjs suite. Keep its onset, continuity and deduplication expectations unchanged.
- Run all four scoped suites, including we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs, and the standards gate only through the host heavy-run queue during implementation. Preparation checks and stamping belong to the runner.

## Proof plan

Capture the injected daemon's actual posted payloads and keys. Before implementation, a trusted head-A comment suppresses head B at the same count; afterward B receives one new comment and repeated B ticks do not post. Show the default real-post call and explicit dry-run no-call as separate observations. Record the existing health regression producing one finding for a prolonged cap-exhausted hold and retaining its persisted identity.

On the next naturally exhausted live PR, observe the posted marker, PR head and timestamp, then the health finding if the hold persists past its configured threshold. Do not deliberately exhaust or relabel a live PR for proof. If no such live event occurs, report deterministic proof separately and leave live observation outstanding rather than claiming it happened.

## Follow-ups

The terminal advisory parking flag is handled by #5952; neither its label policy nor takeover allowance is part of this change. If deployment still runs dry-run, inspect the actual environment and deployed revision before attributing it to code. No dependency edge is required for the independent head-key change.

## Done when

A repeated exhausted head/population posts once, a new known head is not suppressed by the old head's comment, explicit dry-run remains honored, and the existing aged cap-exhaustion health path passes its regression. Record the queued test results and distinguish deterministic evidence from any subsequent live observation.
