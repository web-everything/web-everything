---
bornAs: x0lckod
kind: story
size: 2
parent: "6786"
status: open
blockedBy: ["6789"]
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/review-run-index.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/__tests__/review-run-index.test.mjs", "we:scripts/lib/__tests__/review-run-index.validation.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 3: retire the full review-run scan to index-directory and writer-fence fallbacks

Epic 6786. Delete the shadow comparison. Retain the full scan for a missing or unreadable index directory (I4) and whenever the writer fence (I5) cannot prove that every live daemon build enforces slice 0's identity immutability, including an older or unknown build. Check the writer fence on every evidence/provenance read; a daemon rollback must restore full scanning even after the indexed reader has been enabled. Missing or invalid per-run entries still require fresh full reads of those records (I4). Optionally move review-referral-hold's own mtime/size projection cache (same race class) onto the index. Delivery mode: pr.

Retain durable invalidation, external writer-admission coverage and exclusive reconciliation from the epic and slice 2. Compatible live builds alone cannot re-enable a generation invalidated during an older/unknown-writer interval. Missing/unreadable history, a failed reconciliation, or a changed fence/generation before return retains full scan. This includes the per-store binding: each store's own index and generation, the global fence epoch, the store `dev:ino`, `realpath` resolution and symlink refusal for the index tree, and stale-lock recovery. Retirement removes shadow comparison only; it cannot remove these recovery paths. The optional referral-reader migration is excluded from this slice unless its separate entry point is covered by the same planned cases below.

## Acceptance

- [A1] **Executable** — in planned `we:scripts/lib/__tests__/review-run-index.test.mjs`, `retirement_preserves_all_full_scan_fallbacks` drives both evidence/provenance readers with shadow comparison removed. Assert no shadow branch runs, normal indexed evidence matches full scan, and missing/unreadable directories, older/unknown writers, invalid/missing history and failed reconciliation still open every record and preserve the base result/error.
- [A2] **Must refuse** — rerun the planned cases `invalid_index_states_force_fresh_record_reads`, `candidate_reads_are_fresh_and_head_filtered`, `rollback_restores_full_scan`, `old_writer_interval_requires_revalidation_before_index_reenable`, `unknown_writer_history_cannot_certify_index`, `reconciliation_failure_keeps_generation_invalid`, `sibling_stores_have_independent_indexes`, `admission_invalidates_every_store_generation`, `stale_reconciliation_lock_is_recovered_without_certifying`, and `corruption_alarm_preserves_candidate_refusals` from `we:scripts/lib/__tests__/review-run-index.test.mjs` against the retired path, preserving every observable assertion defined in slices 1-2. A currently passing fence never erases historical invalidation.
- [A3] **Executable** — `npm run test:unit -- <test-file>` from WE using the planned file's path after `we:` runs these regression cases. Epic shared live-performance/parity and audit cases must also pass with a NOT WEAKENED receipt for 6790; attach measurements and receipt before delivery.
- [A4] **Executable** — planned `we:scripts/lib/__tests__/review-run-index.test.mjs` → `retired_reader_omitted_setting_preserves_full_scan`: after retirement, omitted/default `shadow` and explicit `shadow` still return the authoritative full-scan result/error through both readers, with no shadow comparison. Assert each pass logs the effective value and default/override source. Explicit `on` alone may use indexed results subject to all I5 gates. This safely replaces slice 2's comparison-executing default test on the retired path; retirement never silently changes an omitted setting to `on`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not delete full-scan fallbacks, durable validity tracking or the store-health alarm. No unrelated referral-cache rewrite without its planned integration coverage.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — retain invalid-state fallback tests (A2); no receive endpoint is added.
2. **Truncated reads** — partial history/entries remain unproven and corrupt candidates refuse (A1/A2).
3. **Shared state files** — keep writer barrier and publication crash/race regressions (A2 reconciliation case).
4. **Fail closed** — every full-scan recovery branch is retained and exercised with shadow removed (A1).
5. **Identity scoping** — retain exact claim/entry agreement, fresh content and head filtering (A2).
6. **State over time** — re-upgrade cannot restore skips before reconciliation, including after reader restart (A2).
7. **Who wrote it** — retain external admission/history proof; older/unknown writers force full scan on every read (A1/A2).
