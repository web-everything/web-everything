---
bornAs: xukmjgl
kind: story
size: 8
parent: "x5wqxb3"
status: open
blockedBy: ["xbyg4e4"]
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/lib/review-run-index.mjs", "we:scripts/operations/run-store.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/lib/daemon-rebuild/", "we:scripts/settings/red-team.json", "we:scripts/lib/__tests__/review-run-index.test.mjs", "we:scripts/lib/__tests__/review-run-index.validation.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 2: switch the red-team evidence reader to the identity index behind a cascade setting

Epic x5wqxb3. Blocked on an operator ruling (Option A on the epic): a PR's red-team evidence depends only on that PR's records, with a loud store-health alarm on any corrupt review-pr record. Adds the cascade setting redTeam.reviewRunIndexReader (standard shadow, then on), logged with its source each pass, plus the writer fence: it falls back to a full scan unless every live daemon build includes slice 0. It switches only after a mismatch-free shadow soak. Proof: live mergeCascade pass seconds before/after and a Codex guard verdict. Delivery mode: prototype.

The writer fence also includes the epic's durable writer-history validity protocol. A trusted writer-admission/deployment boundary outside the old binary must invalidate the generation before an incompatible/unknown writer can mutate records. If that boundary or continuous history cannot be proved for every writing path (including fresh CLIs and migration), use the full scan. Re-upgrade never clears invalidation. Reconciliation stops all writers under an exclusive barrier, freshly reads the complete store, rebuilds claims/entries into a new generation and atomically certifies it only while the barrier still holds. Conflicting historical claims are quarantined with the old generation, never silently accepted as immutable facts for the new one. Failed, interrupted or raced reconciliation remains invalid. Check the fence and generation on every evidence/provenance call and before returning indexed results. This protocol and its regression tests are prerequisites to enabling skips, not later cleanup.

Generations live per run store (epic: "One index per run store"), but writer admission is global. An old or unknown writer can be pointed at any store, for example through `WE_SHARED_RUNS_DIR`, `OPERATION_RUNS_DIR` or a daemon-jobs folder. So admission does not list stores. Instead, admission bumps one global fence epoch that is kept outside every store. A store's generation is valid only while its recorded epoch equals the current global epoch and its recorded `dev:ino` matches the store. Any admission therefore invalidates every store's generation at once.

The reconciliation lock is per store and records its holder: pid, boot id and start time. A crash leaves the lock behind and the generation invalid. The next reconciliation may take over only after proving the holder dead (a different boot id, or no live pid with that start time). It then rebuilds from scratch and never certifies the dead holder's partial work.

Prevention implementation card for PR #5742's historical writer-fence finding: the scope and size include admission, durable invalidation and reconciliation. Do not mark this slice implemented or enable skips until the named rollback/re-upgrade regression and all admission/reconciliation cases below pass.

## Acceptance

- [A1] **Executable** — planned cases below in `we:scripts/lib/__tests__/review-run-index.test.mjs` pass via `npm run test:unit -- <test-file>` from WE using the path after `we:`, including omitted settings, rollback and re-upgrade.
- [A2] **Must refuse** — no indexed production answer without Option A's recorded ruling, the completed soak, a passing current writer fence and a valid reconciled generation. Unknown settings, writer history, invalidation state or reconciliation outcome use the authoritative full scan; corrupt same-PR/unindexed records still refuse.
- [A3] **Executable** — epic live validation records under-1-second evidence calls, parity under the ratified Option A contract, before/after cascade seconds and a NOT WEAKENED slice audit receipt for xukmjgl.

## Planned tests

All following cases are planned in `we:scripts/lib/__tests__/review-run-index.test.mjs`, wired through both `readDrainRedTeamEvidence` and `verifySavedRedTeamProvenance` (including the saved-result caller). No implementation result is claimed.

| Guarantee | Named case | Observable assertion |
| --- | --- | --- |
| Omitted setting defaults to shadow | `omitted_setting_uses_shadow` | Omit `redTeam.reviewRunIndexReader`; both paths return the full-scan answer, execute isolated shadow comparison and log value `shadow` with its default source on each pass. Explicit `shadow` and `on` log their actual override sources. |
| Safe setting errors | `invalid_setting_preserves_full_scan` | Unknown/malformed values cannot enable skips, and log the rejected value/source with the full-scan fallback. |
| Ruling and soak prerequisite | `switch_requires_ruling_and_completed_shadow_soak` | Explicit `on` with absent/Option B ruling, fewer than 3 days, fewer than 1,000 successful compared calls, any mismatch or shadow error never enables skips. Only a recorded Option A ruling plus at least 3 days and 1,000 successful mismatch/error-free comparisons permits promotion, subject to the fence. |
| Per-read fence and rollback | `rollback_restores_full_scan` | Enable on compatible writers, then introduce an older or unknown writer before the next call and during an indexed call. Both public readers use full scan, including discarding an in-flight indexed result when the final fence/generation check changes; no stale indexed result escapes. |
| Durable historical invalidation | `old_writer_interval_requires_revalidation_before_index_reenable` | Index R for A; invalidate before admitting an old writer that reuses R for B; restore compatible writers and restart readers. Old A claim/entry still agree, yet B remains freshly read and found by full scan. Only complete reconciliation of all records publishes a new valid generation with B evidence equal to full scan. |
| Writer-admission coverage | `unknown_writer_history_cannot_certify_index` | Exercise daemon rollout/rollback, fresh CLI and migration admission; the durable invalid marker precedes any incompatible mutation. Missing/unreadable history, a gap across restart, or an uninstrumented writing path prevents certification even with all current builds compatible. |
| Reconciliation crash/race safety | `reconciliation_failure_keeps_generation_invalid` | Inject failure at record read, claim rebuild, fsync and generation publication; admit a competing writer or change the generation during reconciliation. No partial generation becomes usable; after restart full scan still returns B. A complete exclusive retry succeeds; old claim files are quarantined, not reused. |
| Global epoch covers every store | `admission_invalidates_every_store_generation` | Reconcile two stores, then admit an old writer pointed at only the second (via env). Both stores' generations become invalid before it writes. Both readers full-scan both stores until each is reconciled again under the new epoch. A store copied or restored from backup (a different `dev:ino`, or restored generation bytes from an older epoch) is unknown and full-scanned. |
| Stale reconciliation lock | `stale_reconciliation_lock_is_recovered_without_certifying` | Kill reconciliation while it holds the lock. The generation stays invalid. A live holder blocks takeover. A holder proven dead (a different boot id, or a reused pid with another start time) is taken over. The new run rebuilds fully, and only it publishes a valid generation. |
| Store-health alarm | `corruption_alarm_preserves_candidate_refusals` | Corrupt an indexed other-PR record: store-health reports an actionable record-id alarm (including read/disappearance errors), rather than silent success. Corrupt same-PR and unindexed records: evidence/provenance retain their base refusal semantics. Under Option B, full-scan refusal remains authoritative. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not ratify Option A, waive the soak, or remove full-scan recovery. No metadata-based skip is introduced.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — malformed setting values cannot enable skips (`invalid_setting_preserves_full_scan`); no HTTP endpoint is introduced.
2. **Truncated reads** — unreadable/partial history is unproven; unreadable candidates retain refusal (history and corruption cases).
3. **Shared state files** — generation certification requires an exclusive writer barrier and atomic durable publication (reconciliation case). Per-store generations are bound to one global epoch and the store's `dev:ino` (`admission_invalidates_every_store_generation`). A stale lock is recovered only after its holder is proven dead (`stale_reconciliation_lock_is_recovered_without_certifying`).
4. **Fail closed** — every enable prerequisite is checked, including omitted-setting defaults (A1/A2 cases).
5. **Identity scoping** — a historically stale but internally agreeing A identity cannot conceal B (re-upgrade regression); retain slice 1's exact agreement/head tests.
6. **State over time** — rollback, restart, re-upgrade and failed reconciliation stay full scan until successful reconciliation (recovery cases).
7. **Who wrote it** — old binaries cannot be trusted to invalidate themselves; the external admission boundary must cover every writer (history case).
