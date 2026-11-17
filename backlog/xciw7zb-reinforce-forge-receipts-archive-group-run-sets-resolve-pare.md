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

PR #6928's deletion-race repair takes exclusive leases on the existing Forge worker-writer guards before taking the receipt snapshot, retaining ownership through publication, validation and deletion. Stable guard inodes are never removed; a busy or untrusted guard refuses apply with retry/inspection instructions. The archive test `preserves originals modified after the final stat through writer ownership: %s %s` covers overwrite, append and replacement attempts in both final-check windows, using the writer's shared-flock protocol.

A crash after exclusive temp creation leaves a fixed .tmp-receipts-DAY.jsonl.gz. Apply now recovers that reservation on EEXIST only while holding every exclusive writer lease, when the regular file has one link, is older than one hour and still matches the snapshot taken under those leases. Recovery unlinks only that fixed temp and retries exclusive creation once; uncertainty or recovery failure preserves originals and reports the temp path with operator instructions. Abandoned UUID stages remain planned debt. CLI root precedence is now --root > FORGE_RECEIPTS_DIR > /srv/forge-receipts, with dry-run still the default and explicitly empty or relative roots refused.

## Acceptance

- [A1] Implemented: preserve all recognized members of an unfinished run while its .prepared or .running exists, regardless of marker age, kind or listing order; finished independent runs remain eligible. Named test: `preserves every member of a run with a %s marker regardless of listing order`.
- [A2] Planned: reject a root with any symlinked ancestor before reading or mutating receipts; refuse an ancestry-resolution error. Named tests: `rejects symlinked root ancestors` and `refuses unreadable root ancestry`.
- [A3] Planned: validate every existing archive before trusting it or deleting it under retention. Corrupt, truncated, or unverifiable archives produce an explicit error and remain available for operator recovery; loose originals remain intact. Named test: `refuses corrupt existing archive batches without deleting originals`. For every rejected archive, the test must assert that the same path still exists with byte-for-byte unchanged contents, both before expiry and at expiry; an error plus preserved originals alone is insufficient.
- [A4] Implemented: skip foreign names, including `passwd`, config files, malformed archives and receipt lookalikes, with reason `unrecognized`. Only exact Forge record families and recognized archives may reach archive/delete decisions. Named tests: `skips foreign or malformed filename %j as unrecognized` and `apply preserves unfinished runs and foreign files while archiving a completed run`.
- [A5] Partly implemented: fixed-temp recovery and refusal instructions are covered by `recovers an abandoned temp under writer leases and archives the day`, `preserves an old temp while a live owner holds the writer lease, then recovers after release`, and `preserves originals and gives temp recovery instructions on %s`. UUID-stage cleanup remains planned: named test `cleans abandoned stages without replacing a published archive`.
- [A6] Planned: install a dry-run-safe archive timer only after PR #6916's setup changes are available; preserve the sweeper's ownership boundary. Named test: `setup installs archive retention timer without broad receipt pruning`.
- [A7] Planned: add scoped check:standards rules rejecting active cards with scaffold placeholders in Acceptance or Edge cases, including the scaffolder's output, and rejecting named acceptance tests absent from repository test titles unless the item is explicitly marked planned. Require Test plan bullets to cite a repo-qualified test file and named assertion or be explicitly planned. Named tests: `rejects active scaffold acceptance placeholders`, `rejects active scaffold edge-case placeholders`, `accepts completed active card criteria`, `rejects missing unplanned named acceptance tests`, `accepts explicitly planned named acceptance tests`, and `requires test plan file citations or planned markers`.
- [A8] Implemented: `/srv/forge-receipts` is the CLI fallback, with argument > environment > default precedence and explicit empty/invalid roots still refused. Named tests: `defaults CLI --json with an empty env to a read-only /srv/forge-receipts plan`, `CLI main dry-run --json prints parseable output using the %s root`, and `rejects explicitly invalid CLI and environment roots %j`.

Executable acceptance from the WE root: `npm run test:unit -- forge-receipts-archive forge-receipts-cron-retention check-standards-rules-content-lint`, plus scoped `npm run check:standards`. These Vitest filename filters select `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`, `we:scripts/readiness/__tests__/forge-receipts-cron-retention.test.mjs`, and `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. A1/A4/A8 and the fixed-temp portion of A5 have executable tests; the remaining named tests are planned coverage, not existing proof.

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

- A1/R1 — Regression coverage in `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`: `preserves every member of a run with a %s marker regardless of listing order` fixtures all six recognized record suffixes with each live-state suffix and a finished independent run; assert run-set integrity, then planner eligibility after marker removal. `apply preserves unfinished runs and foreign files while archiving a completed run` pins the apply path.
- A4/R2 — Regression coverage in `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`: `apply preserves unfinished runs and foreign files while archiving a completed run` asserts aged foreign bytes survive alongside exact producer names. `skips foreign or malformed filename %j as unrecognized` covers malformed ids, unknown suffixes and archive lookalikes including Unicode line separators.
- A2/R2 — Planned capability (RED today): cover direct and multi-level symlink ancestry and resolution failures.
- A8/R2 — `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`: `defaults CLI --json with an empty env to a read-only /srv/forge-receipts plan` asserts the default path, successful plan and zero mutations through injected filesystem IO; `rejects explicitly invalid CLI and environment roots %j` asserts exit 2 for empty and relative values; `CLI main dry-run --json prints parseable output using the %s root` pins flag precedence over environment.
- A3/R3 — Planned capability (RED today): `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`, named test `refuses corrupt existing archive batches without deleting originals`: cover valid, corrupt gzip, truncated JSONL, wrong hashes, unverifiable reads and numbered existing archives before expiry and at expiry. Assert explicit errors and no original deletion on invalid input. Capture each invalid archive's path and bytes before apply, then assert the path still exists and `readFile(path)` equals those exact bytes afterward, including when retention would otherwise delete it. Include every matrix case in the executable acceptance gate above; mutation of rejection cleanup to unlink or overwrite an invalid archive must fail this test.
- A5/R4 — `we:scripts/readiness/__tests__/forge-receipts-archive.test.mjs`: `recovers an abandoned temp under writer leases and archives the day` asserts one retry and archive bytes; `preserves an old temp while a live owner holds the writer lease, then recovers after release` asserts no unlinks while busy; `preserves originals and gives temp recovery instructions on %s` asserts original and temp preservation for uncertain ownership and failed recovery, including a second EEXIST. UUID-stage crash cleanup remains planned.
- A6/R5 — Planned capability (RED today): extend the existing cron-retention integration fixture to inspect installed timer commands and prove the sweeper preserves all archive batches.
- A7/R6 — Planned capability (RED today) in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`: add the A7 named fixtures for active scaffold output, Acceptance-only and Edge-cases-only placeholders, complete active cards, inactive scaffolds, absent unplanned test titles, explicitly planned test titles, and missing Test plan file/assertion citations. Assert scoped check:standards invokes the rules and fails when shipped proof is claimed without a matching test title.

## Proof plan

Run the executable acceptance command above and cite each named test with its source line. Attach a dry-run JSON proof using a temporary fixture root; never use a privileged system directory as the negative-test target.
