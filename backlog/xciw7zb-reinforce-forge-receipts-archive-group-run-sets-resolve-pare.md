---
kind: task
status: active
scaffoldedBy: "forge-receipts-archive"
dateScaffolded: "2026-11-16"
dateOpened: "2026-11-16"
tags: []
---

# Reinforce forge-receipts-archive: group run sets, resolve parent symlinks, revalidate existing day archives

Harden receipt retention after PR #6928: preserve unfinished run sets, validate existing archives, reject symlinked root ancestry, allowlist receipt names, recover abandoned temporary files, pin CLI defaults, and prevent active backlog scaffolds from retaining placeholders. Wire the archive timer after PR #6916.

## Design

This is prevention debt from PR #6928's advisory review, not a claim that the guarantees below already ship. Keep planning pure and IO injectable. Existing day archives now cause a new numbered batch rather than suppressing the day; their contents still are not revalidated. The current CLI requires --root or FORGE_RECEIPTS_DIR and returns 2 when neither is supplied, despite the original PR body's default-path claim.

PR #6928's operator repair implements A1 and A4: the planner groups records by exact Forge run id, preserves unfinished runs, and skips unrecognized names before retention decisions. Eligible records use `r-<32 lowercase hex digits>` with receipt/rejected/cancel/consumed/telemetry/base suffixes emitted by Forge; prepared/running markers and writer locks stay protected. Recognized archive batches keep their separate retention policy. Other acceptance items below remain prevention debt.

A crash after exclusive temp creation currently leaves a fixed .tmp-receipts-DAY.jsonl.gz that causes EEXIST on later attempts for that batch; abandoned UUID stages also accumulate. Do not remove a temp merely because it is old: an active writer can have an old reservation. Recover only with proven exclusive ownership; otherwise report a refusal and an explicit operator recovery procedure.

## Acceptance

- [A1] Implemented: preserve all recognized members of an unfinished run while its .prepared or .running exists, regardless of marker age, kind or listing order; finished independent runs remain eligible. Named test: `preserves every member of a run with a %s marker regardless of listing order`.
- [A2] Reject a root with any symlinked ancestor before reading or mutating receipts; refuse an ancestry-resolution error. Named tests: `rejects symlinked root ancestors` and `refuses unreadable root ancestry`.
- [A3] Validate every existing archive before trusting it or deleting it under retention. Corrupt, truncated, or unverifiable archives produce an explicit error and remain available for operator recovery; loose originals remain intact. Named test: `refuses corrupt existing archive batches without deleting originals`.
- [A4] Implemented: skip foreign names, including `passwd`, config files, malformed archives and receipt lookalikes, with reason `unrecognized`. Only exact Forge record families and recognized archives may reach archive/delete decisions. Named tests: `skips foreign or malformed filename %j as unrecognized` and `apply preserves unfinished runs and foreign files while archiving a completed run`.
- [A5] Recover provably abandoned fixed temps and UUID stages without clobbering a live writer, or refuse with actionable operator recovery instructions when ownership cannot be established. Named tests: `recovers an abandoned temp reservation`, `preserves an active writer reservation`, and `cleans abandoned stages without replacing a published archive`.
- [A6] Install a dry-run-safe archive timer only after PR #6916's setup changes are available; preserve the sweeper's ownership boundary. Named test: `setup installs archive retention timer without broad receipt pruning`.
- [A7] Add a scoped check:standards rule rejecting active cards with scaffold placeholders in Acceptance or Edge cases, including the scaffolder's output. Named tests: `rejects active scaffold acceptance placeholders`, `rejects active scaffold edge-case placeholders`, and `accepts completed active card criteria`.
- [A8] Resolve the original default-root promise by adding `/srv/forge-receipts` as the CLI fallback, with argument > environment > default precedence and explicit empty/invalid roots still refused. Replace the current no-root refusal pin deliberately. Named tests: `CLI uses the documented default root`, `CLI root argument overrides environment`, and `CLI refuses explicitly empty roots`.

Executable acceptance from the WE root: `npm run test:unit -- forge-receipts-archive forge-receipts-cron-retention check-standards-rules-content-lint`, plus scoped `npm run check:standards`. These Vitest filename filters select `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`, `we:scripts/readiness/__tests__/forge-receipts-cron-retention.test.mjs`, and `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. A1/A4 tests exist; the remaining named tests are planned coverage, not existing proof.

## Non-goals

- [N1] No deployment to Forge, retention-policy changes, or recovery of files already removed by unrelated operators. No web endpoint is introduced; HTTP body caps, CSRF and rate limits do not apply.

## Edge cases this change must handle

1. **Untrusted text** — Filenames are data; reject separators, control characters, traversal and near-match naming families before any destructive action. Never interpolate names into shell commands.
2. **Truncated reads** — Refuse truncated gzip/JSONL and mismatched count/hash metadata; retain originals and report the offending archive.
3. **Shared state files** — Preserve active run sets and other writers' reservations; retain exclusive creation and no-clobber publication.
4. **Fail closed** — An unreadable ancestry, unknown ownership, invalid explicit root or invalid archive blocks the affected destructive action with a visible error.
5. **Identity scoping** — Root ancestry and the exact Forge filename grammar scope eligible objects; a wrong root must leave foreign files untouched.
6. **State over time** — Exercise finish transitions, crash leftovers, numbered archive batches and retries after partial deletion; retain the UTC 7/30-day boundaries.
7. **Who wrote it** — Temp age alone is not ownership proof. CLI configuration is operator input; a default must not override an explicitly invalid root.

## Risks

- [R1 → A1] Partial run grouping can strand or remove state needed by a resumed run.
- [R2 → A2, A4, A8] A symlinked or misconfigured root can expose unrelated files to privileged deletion.
- [R3 → A3] A corrupt existing batch can conceal missing data or be deleted before recovery.
- [R4 → A5] Aggressive stale-temp cleanup can delete a live writer's reservation; no cleanup leaves repeated EEXIST stalls.
- [R5 → A6] Setup/cron drift can bypass the archive retention policy.
- [R6 → A7] Unfilled active cards can defer security guarantees without executable acceptance.

## Test plan

- A1/R1 — Regression coverage: fixture all six recognized record suffixes with each live-state suffix and a finished independent run; assert run-set integrity in the planner and apply, then planner eligibility after marker removal.
- A4/R2 — Regression coverage: run apply against a temporary directory containing aged `passwd`, dotfiles, receipt lookalikes and exact producer names; assert foreign bytes survive. Planner cases cover malformed ids, unknown suffixes and archive lookalikes including Unicode line separators.
- A2,A8/R2 — Planned capability (RED today): cover direct and multi-level symlink ancestry and resolution failures, plus explicit root precedence/refusals.
- A3/R3 — Planned capability (RED today): cover valid, corrupt gzip, truncated JSONL, wrong hashes and numbered existing archives before expiry and at expiry; assert errors and no original deletion on invalid input.
- A5/R4 — Planned capability (RED today): inject crashes after exclusive create, rename and publication; test two concurrent writers, old active reservations, uncertain ownership refusal, safe retry and stage cleanup.
- A6/R5 — Planned capability (RED today): extend the existing cron-retention integration fixture to inspect installed timer commands and prove the sweeper preserves all archive batches.
- A7/R6 — Planned capability (RED today): add standards-rule fixtures for active scaffold output, Acceptance-only and Edge-cases-only placeholders, complete active cards, and inactive scaffolds under the existing policy. Assert scoped check:standards invokes the rule.

## Proof plan

Run the executable acceptance command above and cite each named test with its source line. Attach a dry-run JSON proof using a temporary fixture root; never use a privileged system directory as the negative-test target.
