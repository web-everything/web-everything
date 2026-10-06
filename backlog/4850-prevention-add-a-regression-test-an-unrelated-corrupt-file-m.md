---
bornAs: xlz0cwo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/timeout-retry-state.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-06"
preparedAgainstSha: "cc47a8e8dfc7a0ddc9a7142e4d94bdf9ab5cacd7"
tags: []
---

# Prevention — Add a regression test: an unrelated corrupt file must not change another PR's budget. Scope the corrupt… (from chalbert/web-everything#3559 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/timeout-retry-state.mjs:13` — Add a regression test: an unrelated corrupt file must not change another PR's budget. Scope the corruption error to files whose evidence matches (repo, pr, head).
2. `we:scripts/operations/ci-heal-pr-dispatch.mjs:490` — Skip or retire pending entries whose observed PR is closed or merged, or whose age exceeds a cap. Add a test that a closed PR's pending state stops polling.
3. `we:scripts/operations/ci-heal-pr-dispatch.mjs:451` — Add a check:standards rule that flags template interpolation of fields from `parseTimeoutFailures` into scaffold digests unless passed through a single-line, length-bounded sanitizer. Or restrict names to a conservative charset at parse time and refuse otherwise.
4. `we:scripts/conveyor/reconcile-pass.mjs:1257` — Add a deterministic classifier regression for deleted dependencies with resolution fallbacks; conservatively reject source deletions until dependency resolution is compared against the base.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3559@73b10d286aa18f8c6d50968d32ddacf073f25f6a

## Done when

1. **Executable** — `npx vitest run` on we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs, we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs and we:scripts/conveyor/__tests__/reconcile-pass.test.mjs fails before this item lands (the new cases below are RED) and passes after.

## Progress

Premise check (2026-10-06, against `origin/main` cc47a8e8): no commit delivers #4850 (`git log --grep=4850` only shows the JIT-number rename). Citation drift corrected; the goal is unchanged:

- Guard 1 — still open. the reader is `readTimeoutStates` at `we:scripts/conveyor/timeout-retry-state.mjs:13`: when no canonical file exists it scans every `*.json` and the `corrupt-timeout-state` throw (line 19) fires BEFORE the repo/pr/head evidence match, so one unrelated corrupt file makes `readTimeoutBudget` return `{pending:true, reason:'timeout-state-unreadable:…'}` for every PR. No `we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs` exists yet (scope already lists it).
- Guard 2 — ALREADY DELIVERED, not rebuilt. `flushTimeoutFollowups` (`we:scripts/operations/ci-heal-pr-dispatch.mjs:592`, was cited as :490) retires pending entries as `aged-out` (`TIMEOUT_PENDING_MAX_AGE_MS`, :590) and `pr-closed` (:628); tests at `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs:559` and `:565`. Out of the MVP.
- Guard 3 — still open. `fileTimeoutFollowup` (`we:scripts/operations/ci-heal-pr-dispatch.mjs:560`, was :451) interpolates `f.path` / `f.name` from `parseTimeoutFailures` (`we:scripts/conveyor/reconcile-pass.mjs:1330`) straight into the scaffold digest. The parser caps lines at 16 KiB but does not bound or charset-restrict the name.
- Guard 4 — still open. The cited area is now `timeoutImpact` (`we:scripts/conveyor/reconcile-pass.mjs:1360`, was :1257). `visit` resolves an import against `sources` (head-bound blobs) via an ordered candidate list (bare path, then ts/mjs/js/tsx extensions, then index files) and checks `paths.includes(path)` only on the candidate that resolved. A deleted ts module falling back to a surviving mjs sibling of the same name is therefore reported as unchanged (`null`), though at base the import resolved to the deleted ts file.
- `size: 3` kept (3 live guards, all in the existing scope).

## Design

1. **Scope corruption to the evidence.** In `readTimeoutStates` (`we:scripts/conveyor/timeout-retry-state.mjs:13`) parse each scanned file in its own try. Order: (a) unparseable JSON or no `evidence` object ⇒ unattributable ⇒ skip it in the legacy scan (it cannot name this PR); (b) evidence present and `repo/pr/head` mismatch ⇒ skip without validating the rest; (c) evidence matches ⇒ THEN require `version===1 && Array.isArray(requests)`, else throw `corrupt-timeout-state`. The canonical-name path (`timeoutKey` file) keeps failing closed on any parse/shape error, so the PR's own budget never silently resets. `timeoutTransaction` (`we:scripts/operations/ci-heal-pr-dispatch.mjs:496`) is unchanged: it only touches the canonical path. **Deliberate trade-off (review finding):** an unparseable legacy file cannot be attributed to any PR, so skipping it means a truncated legacy file that belonged to THIS PR no longer blocks and its old spend is not imported. That is accepted: legacy files are historical (live state is the canonical per-key file, which stays fail-closed), spend per head is capped at 2 confirmed requests, and the alternative (one garbage file wedging every PR's retries) is the bug being fixed. A test pins the skip so it stays a decision, not an accident. The candidate-order guard in step 3 compares extension-bearing candidates only to the entries before the resolved one; a bare-path candidate 0 matches only a changed file with exactly that name.
2. **Bound what reaches the scaffold digest.** In `parseTimeoutFailures` (`we:scripts/conveyor/reconcile-pass.mjs:1348`) refuse (`incomplete()`) when `match[1]` fails `/^[\w@./+-]+$/` or is >256 chars, or `match[2]` has a control character or is >300 chars. Refusing already means "no rerun authorised", the parser's existing contract. This is the card's "restrict at parse time and refuse otherwise" branch.
3. **Resolution-fallback deletion guard.** In `timeoutImpact`'s `visit` (`we:scripts/conveyor/reconcile-pass.mjs:1405`) after computing `candidates`, return `changed-dependency:<p>` if ANY candidate listed BEFORE the resolved one is in `paths` (covers deleted/renamed-away source: `changed` carries `filename` and `previous_filename`). Conservative: a changed earlier candidate means head resolution may differ from base.

## MVP

Musts only:
- M1 (refuse on error): an unrelated corrupt/unattributable state file never changes another PR's `readTimeoutBudget`; a corrupt file whose evidence MATCHES, or a corrupt canonical file, still yields `pending:true` + `timeout-state-unreadable`.
- M2: a log whose failing test path/name is multi-token-unsafe (control chars, over-long, non-conservative path charset) is `complete:false`.
- M3 (every input kind): the deletion guard treats a changed/deleted earlier resolution candidate as `changed-dependency`, for source, and it does not loosen the existing `changed-input-impact-unknown` refusal for docs/config/data (existing tests at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1199` stay green).

OUT of scope (see Follow-ups): guard 2 (already delivered); the `check:standards` interpolation rule; re-parsing sources at the base commit.

## Test plan

- `we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs` (new): (1) dir holds an unrelated-PR file with `version:2` + a garbage-JSON file; `readTimeoutBudget` for PR A with no canonical file equals the budget computed with those files absent — RED today because the scan throws `corrupt-timeout-state`/JSON error ⇒ `pending:true`. (2) matching-evidence file with `requests` not an array ⇒ `pending:true, reason` starts `timeout-state-unreadable` (stays green; pins M1's fail-closed half). (3) corrupt canonical file ⇒ `pending:true`.
- `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: (4) a vitest FAIL line whose test name is 400 chars long ⇒ `complete:false` — RED (accepted today). (5) a failing-test path with a character outside the conservative charset (e.g. a backtick) ⇒ `complete:false`. (6) `timeoutImpact` where a root test imports `./b`, `changed` lists a removed ts file for `b`, and `sources` holds an mjs file for `b` ⇒ `changed-dependency:` naming the ts file — RED (returns `null`). (7) same with a rename whose `previous_filename` is the ts file.
- `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`: (8) end-to-end via `flushTimeoutFollowups`/`dispatchTimeoutRetry` with an unrelated corrupt sibling file: `dispatchTimeoutRetry` for PR A resolves normally. It is RED today because its `initial()` calls `readTimeoutStates` inside `timeoutTransaction` with no try/catch, so the corrupt sibling makes it REJECT with a raw JSON or `corrupt-timeout-state` error (the `timeout-state-unreadable` string only exists on the `readTimeoutBudget` path). `flushTimeoutFollowups` already isolates each file, so a corrupt sibling is only a noise result there. (9) a truncated legacy file with no evidence is skipped and leaves PR A's budget unchanged (pins the accepted trade-off above).

## Proof plan

Before/after on the live shape: seed a throwaway `ci-timeout-reruns` dir (passed as `dir`, never the real lock root) with one corrupt JSON plus a valid state for PR A; run `node -e` against `readTimeoutBudget({repo, pr:A, head, dir})` first from a throwaway `git worktree` of `origin/main` (expect `pending:true, reason:'timeout-state-unreadable:…'`) and on the branch (expect the valid state's budget). Then run the three test files named in Done-when RED→GREEN and `npm run check:standards`.

## Follow-ups

- Add a `check:standards` rule flagging template interpolation of `parseTimeoutFailures` fields into scaffold digests without a sanitizer (guard 3's lint branch).
- Compare dependency resolution against the BASE commit's file list instead of the conservative candidate-order refusal (guard 4's long form).
- Optional: a garbage-file janitor that quarantines unattributable state files so they stop accumulating.
