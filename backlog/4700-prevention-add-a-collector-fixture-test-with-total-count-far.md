---
bornAs: x1rogwo
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-01"
tags: []
---

# Prevention — Add a collector fixture test with total_count far above one page and mostly out-of-window runs, asserti… (from chalbert/web-everything#3355 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/credential-inventory.mjs:82` — Add a collector fixture test with total_count far above one page and mostly out-of-window runs, asserting early termination and ci.complete true. Longer term, a pagination-contract helper that requires a stop condition other than total_count for time-ordered listings.
2. `we:scripts/conveyor/credential-inventory.mjs:59` — Add a deterministic regression test with multiple pages of historical failures and a later repository, asserting bounded historical requests and complete collection for the later repository; implement a time-bounded query or pagination strategy that preserves the intended updated-time semantics.
3. `we:scripts/conveyor/credential-inventory.mjs` — An integration test that mocks a `total_count` greater than the pagination limit while providing only old runs past the first page, asserting that the collector terminates successfully.
4. `we:scripts/conveyor/health-watch.mjs` — An integration test that runs the health tick three consecutive times without advancing time, asserting that the probe fires exactly once, exposing the state-wipe on the second tick.
5. `we:scripts/conveyor/health-smells/credential-inventory-stale.mjs` — Including the original `updated_at` in the normalized `ciFinding` schema and using it for time-window checks.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3355@1e52c139b05c53353a8ec5b3af13370fc16ba630

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/credential-inventory.test.mjs we:scripts/conveyor/__tests__/health-watch.test.mjs` (drop the `we:` prefixes when typing the command) fails before this item lands (the new far-above-one-page and multi-repo cases) and passes after.
2. **Must (refuse on error)** — a runs listing that still has in-window runs beyond the page cap, or a malformed/changing `total_count`, still reports `incomplete`/`malformed`; early stop never hides that.
3. **Must (non-code inputs)** — fixtures stay metadata-only (secrets/logs canaries never reach the result), so the new cases also assert no canary leaks.

## Progress

- 2026-10-02 prepare pass: premise check against `origin/main` @ 35f85c0 — no commit delivers `4700`; the gap is real. `we:scripts/conveyor/credential-inventory.mjs:57-92` (the `for (let page…)` loop) has only three exits: `seen.size >= total` (line 96), a short page (97), or `page > 100` → `incomplete` (line 60). For the `actions/runs` listing (newest first) with `total_count` far above one page and mostly old runs, none triggers early, so the repo burns 100 pages (also eating the 20s budget shared by every later repo) and ends `incomplete`. Scope kept as-is (collector, health-watch, smell + their tests); no drift found beyond `file:line` citations (`:82`/`:59` now map to the loop at 59-97).

## Design

**Root cause** (`we:scripts/conveyor/credential-inventory.mjs:57-92`): the loop's only completeness signal for time-ordered listings is `total_count`. Old runs are skipped with `continue` (line ~80) but still counted in `seen`, so termination waits for all of history.

**Mechanism.** In the `ci` branch only, track per page whether any row is *potentially in window*. `actions/runs` is ordered by `created_at` desc while the window test uses `updated_at` (reruns bump `updated_at`), so a page may be declared "past the window" only when every row's `created_at` is older than `now - lookbackHours - RERUN_GRACE_MS` (a named constant, 7 days: no re-run of a run older than that is credibly in window; documented beside it). When such a full page is seen, stop paging and mark `ci` complete (no `fail('incomplete')`). Rows lacking a valid `created_at` never trigger the stop (treated as in-window; falls back to current behaviour). `secrets` keeps `total_count` termination untouched. In-window overflow still hits `runLimit` → `incomplete` (line ~82), and a changing `total_count` still fails `incomplete` (line ~66).

**Per-repo isolation.** Because each repo's CI loop now ends after at most a few pages in the common case, later repos keep their share of `budgetMs`; the new multi-repo test pins this with a counted request bound.

**health-watch (item 4).** `we:scripts/conveyor/health-watch.mjs:817-826,877-879`: collection and state write are gated on `inventoryDue`, so a second tick at the same `now` should neither re-probe nor wipe `credentialInventoryCache`. Add the three-tick integration test to pin it; if it goes RED, fix the write at line 877 (only write when `probes.credentialInventory` exists — already the shape) in the same PR.

## MVP

Musts:
1. Collector early-termination for the CI listing per Design, with `RERUN_GRACE_MS` constant. The bounded loss is explicit: a rerun (in-window `updated_at`) of a run created more than the grace ago is not collected; this is documented in a code comment and in the PR body, and `ci.complete` means "complete within the grace bound". Stop only when the page is descending-consistent (a mixed-order page never stops early) and every row has a valid `created_at`.
2. Test: `total_count` 5000, 100-row pages all old → stops after the first fully-old page, `ci.complete === true`, no `incomplete` error, request count bounded.
3. Test: repo `a/b` with multiple pages of old failures followed (sorted order) by repo `c/d` with one in-window failure → `c/d` collected, `ci.complete` true, total `gh api` calls bounded.
4. Test: an in-window run on page 2 is still collected; page of old-created-but-recently-updated (rerun within grace) is not skipped.
5. Guard (health-watch): `we:scripts/conveyor/__tests__/health-watch.test.mjs` already pins one probe call across repeat ticks; add only a `credentialInventoryCache`-preserved assertion on ticks 2-3.
6. Test: fixtures carry secret/log canaries; assert none reaches the result (Done-when 3).
7. Tests use a fake `clock` advancing 250ms per call so 100 calls exceed the 20s budget (makes the later-repo case RED today); a mixed-order page and a missing-`created_at` page assert no early stop.

Out of scope (Follow-ups).

## Test plan

- `far-above-one-page, mostly old runs`: asserts early stop + `ci.complete` true + `calls.length` ≤ small bound. RED today: loop runs to page 100 and returns `incomplete`.
- `later repository after historical failures`: asserts the later repo's finding exists and is complete, calls bounded. RED today: first repo exhausts the 20s/page cap, later repo gets `timeout`/`incomplete` (fake clock advancing per call makes this deterministic).
- `in-window run beyond page 1 / rerun within grace`: asserts no under-collection from the stop rule. Passes before and after as a guard on the fix (fails if the stop is too aggressive, e.g. using only `updated_at`).
- `total_count changes between pages` / `in-window overflow`: assert still `incomplete`. Guards; pass before and after.
- `three ticks, same now`: asserts one probe call and cache retained. Likely GREEN already (pins the contract); if RED, it exposes the item-4 state-wipe.

## Proof plan

Run the collector against a stub `gh` (fixture `exec`) shaped like the real 3355 case and print `calls.length` and `ci.complete` before the change (≈100 calls, `incomplete`) and after (a handful, `complete`). Capture both outputs in the PR body. Live probe if `gh` auth is available: `node we:scripts/conveyor/credential-inventory.mjs --repo=chalbert/web-everything` exit code and request count; else stub-only, noted as such.

## Follow-ups

- Item 5: carry the run's own `updated_at` in `ciFinding` and use it (not `observedAt`) in `we:scripts/conveyor/health-smells/credential-inventory-stale.mjs` window checks. Needs a state-schema version bump + cache migration (`schemaVersion: 1` today); the collector only emits in-window rows so current behaviour is correct.
- "Pagination-contract helper" requiring a non-`total_count` stop condition for time-ordered listings — extract once a second consumer exists.
- Optional server-side `created=>` query narrowing on the runs endpoint to cut requests further.

## Findings (standalone worker, 2026-11-20)

The build-dispatch daemon held #4700 with:

> worker-declined: Not prepared: #4700 — could-not-prepare. The unresolved choice is whether 'ci.complete' guarantees full updated-time coverage or permits omission of recently updated runs created beyond a chosen age cutoff. 'we:scripts/conveyor/credential-inventory.mjs:76' filters by 'updated_at'. The card’s proposed seven-day creation-age cutoff explicitly permits missing qualifying runs while reporting completeness. No supporting bound was established by the inspected code; adopting it would choose coverage policy. The preparation needs either an approved coverage restriction or a verified pagination strategy …

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
