---
bornAs: xl3mmn5
kind: story
size: 3
parent: "6786"
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/run-store.test.mjs", "we:scripts/lib/__tests__/review-run-index.validation.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 0: review-pr run identity is immutable (writeRun refuses a repo/PR change, no symlinked runs, safe legacy migration)

Prerequisite for the identity index (epic 6786), correct on its own. Today a fresh invocation with an existing --run-id overwrites a review-pr record with a different repo/PR unchecked, migrateLegacyRuns renames records in without writeRun (exists-then-rename overwrite race), and writeJsonAtomic follows symlinked run paths. Make writeRun refuse an input.repo/input.pr change for an existing review-pr id, refuse symlinked run paths, and route migration through the same check with no overwrite. Delivery mode: pr.

## Acceptance

- [A1] **Executable** — planned `we:scripts/operations/__tests__/run-store.test.mjs` cases below pass via `npm run test:unit -- <test-file>` from WE using the path after `we:`; refusal preserves existing bytes and safe same-identity rewrites still succeed.
- [A2] **Must refuse** — identity changes, symlink destinations and migration collisions cannot modify an existing record, its symlink target or its identity claim; the tests below assert each protected surface.
- [A3] **Executable** — the epic's shared live-parity and per-slice audit validation cases pass for 6787; attach the measured results and audit receipt before advancing the next slice.

## Planned tests

All cases in this table are planned in `we:scripts/operations/__tests__/run-store.test.mjs`, not claimed as implemented or run.

| Guarantee | Named case | Observable assertion |
| --- | --- | --- |
| A1/A2, immutable identity | `rejects_identity_change_without_modifying_record` | Vary repo-only, PR-only and both on an existing review-pr id, with and without a claim; each write throws and record/claim bytes are identical before/after. A same-identity progress rewrite succeeds. |
| Both fresh CLI entry points and resume | `cli_run_id_reuse_cannot_bypass_identity_guard` | Invoke fresh cli-adapter and review-loop-cli paths with a reused id and changed repo/PR; each refuses without changing the saved record. Resume keeps saved input and succeeds. |
| Symlink refusal | `rejects_symlink_without_modifying_target` | Attempt writes through symlinks to existing and missing targets; refusal leaves link, target bytes/existence and claim unchanged. |
| Migration without overwrite | `migration_preserves_existing_destination` | Create a destination before migration and race its creation at publication, for same and conflicting identity; destination bytes survive and the source is retained/reported rather than lost. |
| Migration uses identity guard | `migration_rejects_invalid_identity_and_symlinks` | Malformed/missing repo or PR and symlinked source/destination are refused with no published claim/record; valid migration preserves content and cannot change an existing identity. The legacy and shared folders are compared by `realpath`, not by `resolve()` strings. When the legacy folder is a symlink to (or the same directory as) the shared one, migration is a no-op and never deletes a source that is also the destination. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No reader switch, index backfill or change to evidence selection; those belong to later slices.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — validate repo/PR and refuse symlink paths; covered by `migration_rejects_invalid_identity_and_symlinks` above. No receive endpoint is introduced, so HTTP body/rate/CSRF controls are inapplicable.
2. **Truncated reads** — an unreadable or malformed existing record cannot prove identity: planned `rejects_identity_change_without_modifying_record` also asserts refusal with unchanged bytes for partial JSON and read errors.
3. **Shared state files** — collision at migration publication preserves the winner (`migration_preserves_existing_destination`); index claim concurrency is slice 1.
4. **Fail closed** — all identity/symlink failures leave protected files unchanged (A2 cases).
5. **Identity scoping** — compare repo and PR on every write, including both fresh CLIs and resume (A1 cases).
6. **State over time** — same-identity progress rewrites remain allowed; migration cannot replace an existing destination (A1 cases).
7. **Who wrote it** — migration and CLI writes share the run-store guard (`cli_run_id_reuse_cannot_bypass_identity_guard`, `migration_rejects_invalid_identity_and_symlinks`).
