---
bornAs: xxwaayo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-memory.mjs", "we:scripts/__tests__/check-memory.test.mjs", "we:scripts/__tests__/check-standards-memory-index.test.mjs", "we:agent-memory-src/index-*.md"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "00ecbc1d32b46ff3dd39bd76f6462915f84232cc"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3080's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:agent-memory-src/index-meta.md:92` — A regex check in `check:standards` asserting that all list items in `we:agent-memory-src/index-*.md` files end with a `(YYYY-MM-DD)` date.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3080@7676f830dfa368785acf58002163fa079131800d

## Acceptance

Each named test below is planned, belongs to the specified existing suite, and must fail against the pre-build implementation and pass after implementation (including its reject-then-correct assertions).

- [A1] **Executable** — `category date grammar and locations` in `we:scripts/__tests__/check-memory.test.mjs` rejects missing, misplaced, non-padded, and nonterminal dates with exact filename/one-based line; accepts terminal dates for unordered/ordered entries, trailing whitespace and CRLF; ignores frontmatter, fenced examples, prose and continuation lines.
- [A2] **Executable** — `canonical sweep cannot be bypassed by memory selection` in `we:scripts/__tests__/check-memory.test.mjs` runs the actual CLI with an undated canonical entry, both without a legacy map and with a preferred user-memory directory: text exits 2 with location, JSON has `ok: false` and a positive violation count; correcting the suffix clears the date error and permits success in otherwise valid fixtures. This pins the changed default: missing legacy memory no longer bypasses canonical validation.
- [A3] **Executable** — `canonical evidence failures are violations` in `we:scripts/__tests__/check-memory.test.mjs` removes the canonical directory, leaves it with no matching indexes, or substitutes a directory for a matching Markdown file: CLI exits 2 and JSON reports failure, never a successful skip. Restoring readable valid input passes. Inject a read error into the scanner as well, so unreadable-file coverage does not depend on host permissions. Diagnostics tell the operator to restore the canonical checkout/readability and rerun.
- [A4] **Executable** — `canonical corpus has evidenced terminal dates` in `we:scripts/__tests__/check-memory.test.mjs` scans all canonical category indexes and reports zero missing suffixes after backfill (currently 302). During migration, verify each changed entry against its cited leaf date or introducing commit and retain the entry-to-evidence ledger in the implementation review; the executable assertion proves formatting, while the ledger proves historical provenance.
- [A5] **Executable** — `real memory date failure reaches standards errors` in `we:scripts/__tests__/check-standards-memory-index.test.mjs` executes the existing standards section with the real memory CLI, asserts an undated fixture yields a `memory-index` error containing its filename/line, then asserts correction clears that error. Keep the existing skip-warning tests unchanged. This tests the output producer and caller, not a fabricated error string.

Run these named suites through the host heavy-run queue as described in Test plan.

## Progress

- **Old premise/scope:** the previous preparation reported ten category indexes, 292 bullets and 285 missing suffixes; cited the standards integration at line 2383; and scoped only the memory gate, its predicate test, and the category corpus. Earlier filing singled out the Night mode entry.
- **Corrected premise/scope:** a current read-only scan of the nine tracked `we:agent-memory-src/index-*.md` files found 309 list entries, 302 without terminal dates. Night mode remains at `we:agent-memory-src/index-meta.md:92`. The guard remains absent: `we:scripts/check-memory.mjs:151` returns success for a missing selected map, and lines 164–190 check pointer reachability without date validation. Preserve the prevention goal and corpus backfill; add the existing standards integration test to scope.
- **Source evidence:** user-memory preference is at `we:scripts/check-memory.mjs:34–42`; JSON result/exit behavior is at `we:scripts/check-memory.mjs:201–216`. The standards subprocess and error propagation now live at `we:scripts/check-standards.mjs:2567–2580`. `we:scripts/__tests__/check-memory.test.mjs:11` imports only path predicates. `we:scripts/__tests__/check-standards-memory-index.test.mjs:13–31` already executes the real standards section with a stub checker; extend that harness to run the actual checker for A5.
- **Callers/defaults:** `we:package.json:68` invokes the sweep; `we:.claude/settings.json:94` invokes `--pre`, which remains outside date enforcement. Existing secret-hook tests in `we:scripts/__tests__/publish-secret-gate.test.mjs:167` and budget consumers in `we:scripts/__tests__/golden-corpus-snapshot.test.mjs:39` must retain their behavior. `we:scripts/lib/hook-root.mjs:7–15` already supports `WE_HOOK_ROOT`, so CLI fixtures need no new production root flag.
- **Sizing:** retain story size 3. Expected touch set: `we:scripts/check-memory.mjs` approximately 90 changed lines for scanner/aggregation; `we:scripts/__tests__/check-memory.test.mjs` approximately 140; `we:scripts/__tests__/check-standards-memory-index.test.mjs` approximately 45; nine category files approximately 302 line replacements. Historical provenance tracing is the principal work beyond those roughly 577 changed logical lines. No `estimatedLoc` is added to this story. Stamps remain runner-owned.

## Design

Extend `we:scripts/check-memory.mjs` with an import-safe date-suffix validator and a scan of the tracked canonical `we:agent-memory-src/index-*.md` files. Reuse the existing standards-to-memory CLI integration; no second registration or change to `we:scripts/check-standards.mjs` is needed.

Inspect Markdown body list entries, excluding YAML frontmatter and fenced examples. Cover unordered markers and ordered list markers, including the existing numbered-memory form inside a bullet. Require the terminal pattern `\(\d{4}-\d{2}-\d{2}\)\s*$`; a date embedded earlier in the entry or followed by commentary does not satisfy it. This is the requested formatting guard, not calendar arithmetic, age-based eviction, or a claim that a memory was recently reaffirmed. Preserve headings, prose, and continuation lines.

Scan the canonical tracked directory independently of the user-memory-directory preference. Do not let the existing missing-map early return skip this check. Merge findings into the CLI's violation count and existing nonzero/text/JSON behavior, with each text diagnostic naming the actual index and one-based line. Keep existing budget, reachability, and secret checks intact. A missing canonical directory, zero matching category files, or a directory/file read failure is a violation with an operator-visible restore/readability diagnostic, not a successful skip; catch these failures into both text and JSON results. Enumerate immediate matching files in the canonical directory so newly added indexes are checked too. Leave `--pre` behavior unchanged. If only the legacy map is absent, still finish canonical validation and preserve a visible legacy-skip notice in text output; emit valid JSON in JSON mode.

Backfill missing suffixes across `we:agent-memory-src/index-*.md` in the same implementation change. Retain existing valid suffixes. Use an explicit date already attached to that memory when supported; otherwise use the commit date that introduced the entry, tracing moves through history as needed. Record provenance in the implementation review. Never label the migration date as historical creation or reaffirmation. Preserve entry wording and links.

## MVP

1. Add the pure validator and canonical-directory sweep in `we:scripts/check-memory.mjs`, wired into its normal CLI error path.
2. Extend `we:scripts/__tests__/check-memory.test.mjs` with fixture cases and isolated subprocess coverage for the normal sweep. Its corpus smoke also covers the scoped Markdown files. Extend `we:scripts/__tests__/check-standards-memory-index.test.mjs` with A5 using the real CLI and isolated fixture root.
3. Backfill the nine category indexes with evidenced dates and prove that removing one suffix reopens the failure through the existing standards integration.

## Test plan

- In `we:scripts/__tests__/check-memory.test.mjs`, accept dated linked and numbered-memory bullets, ordered items, trailing whitespace, and CRLF. Reject missing dates, non-padded dates, dates only in the middle, and text after the suffix; assert exact file and line diagnostics.
- Cover frontmatter, headings, prose, fenced examples, and continuation lines without false positives. Exclude the map, leaf files, and similarly named non-Markdown files from the directory scan.
- Exercise the actual CLI with `WE_HOOK_ROOT` pointing at a disposable fixture checkout and a child-only isolated home environment: undated canonical entry fails, corrected entry passes, and JSON violation count agrees with exit status. Cover a missing legacy map and a preferred user-memory directory so neither bypasses canonical validation. Keep fixtures isolated from real user memory.
- Add the A3 evidence-failure fixtures and A4 live canonical-corpus assertion. Use the existing standards-section harness for A5; put all temporary fixtures under the task temporary directory.
- Run only the affected suites through the host queue: `npm run test:unit -- <affected-test-files>` with `we:scripts/__tests__/check-memory.test.mjs`, `we:scripts/__tests__/check-standards-memory-index.test.mjs`, `we:scripts/__tests__/publish-secret-gate.test.mjs`, and `we:scripts/__tests__/golden-corpus-snapshot.test.mjs` (strip the repository prefix for command arguments). Invoke that command via the queue runner `we:scripts/readiness/heavy-admission.mjs`. Queue `npm run check:memory` and `npm run check:standards` likewise. If busy, use the queue's own wait option once, then report unrun checks; do not poll.

## Proof plan

Before implementation, run the new negative fixture against the old CLI and capture its failure to reject the undated entry. After implementation, capture rejection with the index filename and line, then acceptance after adding a valid suffix. In a disposable checkout with the backfilled corpus, remove the Night mode suffix in `we:agent-memory-src/index-meta.md` and run `npm run check:standards`; capture its memory-index error, restore the suffix, and rerun. Distinguish unrelated baseline failures from this signal. Preserve the test output and the backfill's date provenance in the implementation review; preparation itself does not claim these future probes passed.

## Follow-ups

No additional feature is required for this prevention guard. Write-time hook enforcement, semantic freshness dates, calendar validation, and expiry rules are outside this item. Any future adoption needs its own scope; this work enforces only the reviewed terminal-date convention.
