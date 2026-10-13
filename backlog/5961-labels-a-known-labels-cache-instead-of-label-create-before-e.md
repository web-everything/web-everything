---
bornAs: xqce2qz
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ensure-label.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/review-label-provider.mjs", "we:scripts/lib/forge-land-provider.mjs", "we:scripts/lib/__tests__/ensure-label.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/review-label-provider.test.mjs", "we:scripts/lib/__tests__/forge-land-provider.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "8e6ac5c8b85595160693d112b6996004db63cd16"
tags: []
---

# Labels: a known-labels cache instead of label create before every edit

Held finding 227 (coroner-5). 4,118 label create calls in 12 h (merge-ai-prs 3,083, review-daemon 709, fix-procedure 134, pr-land 111); 295/h after the 18:30 ET fix. Each is an idempotent ensure-exists. Fix: a per-repo known-labels cache (refreshed daily or on a 422 label-not-found); create a label only when the edit fails for a missing label. Evidence: the conveyor calls ledger, op label create.

## Acceptance

- [A1] **Executable** — the ensure-label unit test (`we:scripts/lib/__tests__/ensure-label.test.mjs`, run with vitest) fails before this item lands (module absent) and passes after: a second `ensureLabelCached` for the same (repo, label) within the TTL issues zero `gh` calls; a missing-label failure invalidates the entry and re-creates once.

## Non-goals

- [N1] No change to label colors/descriptions (still single-sourced from `REVIEW_LABEL_META` / `CI_LIFECYCLE_LABEL_META`); no cross-host cache sharing; no edits to the `we:scripts/pr-land.mjs` call sites (they ride the land-provider change below); no `--force` added to the no-`--force` creates, so existing label colors/descriptions are never rewritten.

## Progress

- Premise check (2026-10-13, main 8e6ac5c8): not delivered. `git log` finds only the drain JIT-number commit for 5961. `we:scripts/merge-ai-prs.mjs` still mints via raw `gh label create` at :4758 and :5357, memoized only in-process by `ensuredLabels` (:4447), so every drain process start re-mints (the 3,083 calls).
- Scope corrected: the old scope entry `we:scripts/review-set-label.mjs` never calls `label create` itself; it routes through `createGhProvider`. The shared home is `we:scripts/lib/review-label-provider.mjs:169` (`ensureLabel`, `--force` create argv at :105), reaching review-daemon, fix-procedure and pr-land (`we:scripts/pr-land.mjs:729,1054,1144,1154,1230`). The new scope lists `we:scripts/lib/review-label-provider.mjs` in its place.
- Review round 1 corrections: `we:scripts/pr-land.mjs:703` uses `createGhLandProvider` (`we:scripts/lib/forge-land-provider.mjs:130` `labelCreate`, `:197` `ensureLabel`), a separate adapter from the review provider, so it is added to scope. Also: `labelCreate` and the two merge-ai-prs creates run WITHOUT `--force`, so on an existing label they fail and the error is swallowed — a naive "record only on success" cache would never fill in steady state (the actual 3,083 calls). Design below treats "already exists" as success.
- `size:` 1 → 2 (new module + three call-site families + tests).

## Design

New `we:scripts/lib/ensure-label.mjs` exports `ensureLabelCached({ repo, name, create, now })`. State is one JSON file in the conveyor state directory (under the user's Claude home; env override `WE_KNOWN_LABELS_FILE`) shaped `{ "<repo>::<name>": { at: <epoch ms> } }`. If the entry exists and `now - at < TTL` (24 h), return without calling `create`. Otherwise call `create` (the existing idempotent `gh label create --force`), then record the entry. Writes use `withFileLock` + `writeJsonAtomic` from `we:scripts/lib/atomic-json-file.mjs`, re-reading inside the lock and merging (compare-and-set), since drain, review-daemon and pr-land are separate processes.

Call sites: (1) `we:scripts/merge-ai-prs.mjs:4758` and `:5357` replace the raw `execFileSync('gh', ['label','create', …])` with `ensureLabelCached`, keeping the in-process `ensuredLabels` set as the first-level skip. (2) `we:scripts/lib/review-label-provider.mjs:169` `ensureLabel` wraps its `exec` in `ensureLabelCached` (covers review-daemon and fix-procedure). (3) `we:scripts/lib/forge-land-provider.mjs:197` `ensureLabel` wraps its `exec` the same way (covers pr-land's five sites). The merge-ai-prs and land-provider creates have no `--force`, so on an existing label `gh` exits non-zero with "already exists": `ensureLabelCached` treats a failure whose `e.stderr ?? e.message` matches `/already exists/i` as SUCCESS and records it; any other failure records nothing and rethrows (call sites keep their existing swallow). Creation of a genuinely new label also records. `--force` stays only where it already is, so the 24 h TTL delays only the review provider's metadata update-on-force, which is accepted.

Invalidation on need: `invalidateKnownLabel(repo, name)`. The review provider keeps a per-name map of the last `ensureLabel` opts; `setLabels` (:165) catches a failure whose `e.stderr ?? e.message` matches `/not found/i` AND contains the label name being added, invalidates that entry, calls the (cache-wrapped, so it now creates) `ensureLabel` with the remembered opts (default `ededed`/empty when none), and retries once; any other failure (rate limit, PR not found) propagates unchanged. The merge-ai-prs `applyLabel` path does not use this provider, so it gets only the TTL protection, not the retry.

## MVP

Musts: the cache module with TTL + lock/atomic write; review provider, land provider and both merge-ai-prs sites wired; "already exists" counted as success; invalidate-and-retry-once on a not-found `--add-label` failure; unit tests. OUT (Follow-ups): repo-wide label list prefetch, hit-rate metrics.

## Test plan

In `we:scripts/lib/__tests__/ensure-label.test.mjs` with injected `create` and clock (all RED before: module absent):
- Capability (Red today): hit within TTL → `create` not called.
- Capability (Red today): miss, expired entry (TTL+1 ms), and different repo/name → `create` called once each.
- Capability (Red today): `create` throws → nothing recorded, error surfaces (no false "known").
- Capability (Red today): corrupt/unparseable state file → treated as empty and rewritten valid; create still runs.
- Capability (Red today): two interleaved writers keep both keys (merge under lock).
- Capability (Red today): `invalidateKnownLabel` forces the next ensure to create.
- Capability (Red today): `create` failing with realistic "label with name \"X\" already exists" stderr → treated as success and recorded (second call makes no `gh` call); a different failure (auth/network) records nothing and rethrows.
- Capability (Red today): name starting with `--` is rejected before any `create`.
- Capability (Red today): review provider, in `we:scripts/lib/__tests__/review-label-provider.test.mjs`: `setLabels` failing with realistic "could not add label: 'X' not found" invalidates, re-ensures once with remembered opts, retries once; a second failure propagates.
- Preservation (GREEN today; mutation proof: make the retry unconditional and it fails): same file, an unrelated `setLabels` failure (rate limit, PR not found) neither invalidates nor retries.
- Capability (Red today): land provider, in `we:scripts/lib/__tests__/forge-land-provider.test.mjs`: a second `ensureLabel` for the same label within the TTL makes no `gh` call.
- Capability (Red today): in `we:scripts/__tests__/merge-ai-prs.test.mjs`, two sweeps in separate processes (fresh `ensuredLabels`) mint each label once, not twice.

## Proof plan

Before/after on the live drain: count `label create` rows per hour in the conveyor calls ledger (op label create) before the change vs after a drain restart on the new build; expect at most one create per (repo, label) per 24 h window (counted per repo and label over one full TTL after restart) vs the current 295/h. Also a CLI probe: call `ensureLabelCached` twice for one label against a real repo and show the second makes no `gh` call.

## Edge cases this change must handle

1. **Untrusted text** — keys are `repo::name`; names come from constant tables (`REVIEW_LABEL_META`) or `review-round:<N>` (numeric N); a name starting with `--` is rejected before argv; the JSON key is only a data key, never a path, shell or regex.
2. **Truncated reads** — n/a: the cache reads only its own small JSON file; not-found detection reads the single `gh` failure text, not a paged list.
3. **Shared state files** — written by several processes: `withFileLock` + `writeJsonAtomic`, re-read and merge inside the lock; stale-lock steal is already guarded in `withFileLock`.
4. **Fail closed** — unreadable/corrupt cache means "unknown", so we create (never skip); a failed `create` records nothing; a failed cache write after a successful create is swallowed (the next process just re-creates).
5. **Identity scoping** — key includes repo slug (`null` resolved to the cwd repo slug, never a bare shared key) and exact label name.
6. **State over time** — 24 h TTL bounds drift from hand-deleted labels; the not-found invalidate-and-retry covers deletion inside the TTL; a restart mid-write leaves the old or new file (atomic rename).
7. **Who wrote it** — n/a: the file grants no trust, it is only a "created recently" hint; a forged entry can at worst delay a create, and the not-found retry repairs that.

## Follow-ups

- Prefetch `gh label list` once per repo per day to warm the cache.
- Cache hit/miss counters in conveyor metrics.
