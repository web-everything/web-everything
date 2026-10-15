---
bornAs: xqce2qz
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ensure-label.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/review-label-provider.mjs", "we:scripts/lib/forge-land-provider.mjs", "we:scripts/lib/__tests__/ensure-label.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/review-label-provider.test.mjs", "we:scripts/lib/__tests__/forge-land-provider.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6d77e9169e764d4787a9348b5fafd81ee04b0fed"
tags: []
---

# Labels: a known-labels cache instead of label create before every edit

Held finding 227 (coroner-5). 4,118 label create calls in 12 h (merge-ai-prs 3,083, review-daemon 709, fix-procedure 134, pr-land 111); 295/h after the 18:30 ET fix. Each is an idempotent ensure-exists. Fix: a per-repo known-labels cache (refreshed daily or on a 422 label-not-found); ensure on a cache miss or expiry, and invalidate/re-ensure once when label application reports that exact label missing. Evidence: the conveyor calls ledger, op label create.

## Acceptance

- [A1] **Executable** — the ensure-label unit test (`we:scripts/lib/__tests__/ensure-label.test.mjs`, run with vitest) fails before this item lands (module absent) and passes after: a second `ensureLabelCached` for the same (repo, label) within the TTL issues zero `gh` calls; a missing-label failure invalidates the entry and re-creates once.

## Non-goals

- [N1] No change to label colors/descriptions (still single-sourced from `REVIEW_LABEL_META` / `CI_LIFECYCLE_LABEL_META`); no cross-host cache sharing; no edits to the `we:scripts/pr-land.mjs` call sites (they ride the land-provider change below); no `--force` added to the no-`--force` creates, so existing label colors/descriptions are never rewritten.

## Progress

- Current-checkout recheck at 6d77e9169: the helper is still planned, not delivered. Raw creates remain at `we:scripts/merge-ai-prs.mjs:4748` and `we:scripts/merge-ai-prs.mjs:5370`; process-local memoization is at `we:scripts/merge-ai-prs.mjs:4436`. Retain the corrected four-source/four-test scope and size 2. Correct the opening wording: this is ensure-on-cache-miss plus retry after a precise missing-label failure, not edit-first creation exclusively. The historical rate is not a current measurement.

- Rechecked at 17242a56d: not delivered; planned `we:scripts/lib/ensure-label.mjs` remains absent. Original premise was repeated idempotent creates across processes. Current drain sites are `we:scripts/merge-ai-prs.mjs:4748` and `we:scripts/merge-ai-prs.mjs:5370`, with process-local memoization near line 4432. The old citations at lines 4758 and 5357 were stale.
- Corrected scope retains the existing new-helper plus three caller-family design and all four matching tests. The review CLI is an indirect consumer, not an additional edit: `we:scripts/lib/review-label-provider.mjs:169` implements its ensure. The land adapter is separate (`we:scripts/lib/forge-land-provider.mjs:197`) and implicitly targets the cwd repository; it must resolve that identity before sharing a persistent cache.
- Corrected factual premise: only the review provider uses forced creation (`we:scripts/lib/review-label-provider.mjs:105`); the land provider (`we:scripts/lib/forge-land-provider.mjs:130`) and drain do not. Existing-label errors must fill the cache, without adding force. The prior design's generic “existing idempotent forced create” description was inaccurate.
- Retain size 2: approximately 120 helper lines, 50 review-provider lines, 35 land-provider lines, 35 drain lines and 180 lines across the four scoped tests. Shared atomic/lock utilities are consumed unchanged. Historical call counts in the opening are incident evidence, not a fresh measurement. No stamps or dependency changes.

## Design

New `we:scripts/lib/ensure-label.mjs` exports `ensureLabelCached({ repo, name, create, now })`. State is one JSON file in the conveyor state directory (under the user's Claude home; env override `WE_KNOWN_LABELS_FILE`) keyed by an unambiguous encoded (repo, name) tuple with `{ at: <epoch ms> }` values. If the entry exists and `now - at < TTL` (24 h), return without calling `create`. Otherwise call `create` (the caller-provided create operation, retaining its existing force/no-force argv), then record the entry. Use `withFileLock` + `writeJsonAtomic` from `we:scripts/lib/atomic-json-file.mjs`, with the cache hit rechecked under the lock before calling create and updating state. This serializes concurrent cold misses for the same key as well as merging different keys. The create callback stays synchronous to match all three callers. Inject cache path and clock for hermetic tests. On a cache read/lock/write failure, perform the original uncached ensure if it has not already run; never suppress a required create or run it twice merely because persistence failed. Only definitive create success or a specific existing-label response records a positive entry; preserve other create errors for the caller.

Call sites: (1) `we:scripts/merge-ai-prs.mjs:4748` and `we:scripts/merge-ai-prs.mjs:5370` replace the raw `execFileSync('gh', ['label','create', …])` with `ensureLabelCached`, replacing the process-lifetime `ensuredLabels` skip with TTL-aware cache checks, so a long-running watch also observes expiry. (2) `we:scripts/lib/review-label-provider.mjs:169` `ensureLabel` wraps its `exec` in `ensureLabelCached` (covers review-daemon and fix-procedure). (3) `we:scripts/lib/forge-land-provider.mjs:197` `ensureLabel` wraps its `exec` the same way (covers pr-land's five sites). The merge-ai-prs and land-provider creates have no `--force`, so on an existing label `gh` exits non-zero with "already exists": `ensureLabelCached` treats a failure whose `e.stderr ?? e.message` matches `/already exists/i` as SUCCESS and records it; any other failure records nothing and rethrows (call sites keep their existing swallow). Creation of a genuinely new label also records. `--force` stays only where it already is, so the 24 h TTL delays only the review provider's metadata update-on-force, which is accepted.

Invalidation on need: `invalidateKnownLabel(repo, name)`. The review provider keeps a per-name map of the last `ensureLabel` opts; `setLabels` (:165) catches a failure whose `e.stderr ?? e.message` matches the concrete missing-label diagnostic and names an exact label being added, invalidates that entry, calls the (cache-wrapped, so it now creates) `ensureLabel` with the remembered opts (default `ededed`/empty when none), and retries once; any other failure (rate limit, PR not found) propagates unchanged. Apply the same one-retry contract to the land provider's `addLabel` (`we:scripts/lib/forge-land-provider.mjs:187`) and the drain's direct label application, using the metadata already available at their ensure sites. The invalidation must also remove any in-process memoized hit. Match a concrete missing-label response for an exact requested label, not a generic HTTP 422 or arbitrary “not found” substring; unrelated PR/repository/auth/rate-limit errors never retry. If no metadata was ensured in this process, retain the existing default color/description rather than inventing metadata.

Resolve an implicit cwd repository once per adapter instance using the existing repository-resolution facility, and include the resulting full repo slug in every key. If resolution fails, bypass persistent caching and retain the original uncached operation; never share a null/empty-repo key. Use nested maps or collision-safe tuple encoding for exact repo/name keys, not ambiguous concatenation. Reject malformed or future-dated timestamps as cache misses. Do not persist credentials or error bodies.

## MVP

Musts: the cache module with TTL + lock/atomic write; review provider, land provider and both merge-ai-prs sites wired; "already exists" counted as success; invalidate-and-retry-once on a not-found `--add-label` failure; unit tests. OUT (Follow-ups): repo-wide label list prefetch, hit-rate metrics.

## Test plan

Run all four scoped tests and the standards gate only through Node on `we:scripts/readiness/heavy-admission.mjs` (`run -- npx vitest run` with test filesystem paths, or `run -- npm run check:standards`). Repo prefixes in this card are documentation only. No real forge calls are needed.


In `we:scripts/lib/__tests__/ensure-label.test.mjs` with injected `create` and clock (all RED before: module absent):
- Capability (Red today): hit within TTL → `create` not called.
- Capability (Red today): miss, expired entry (TTL+1 ms), and different repo/name → `create` called once each.
- Capability (Red today): `create` throws → nothing recorded, error surfaces (no false "known").
- Capability (Red today): corrupt/unparseable state file → treated as empty and rewritten valid; create still runs.
- Capability (Red today): concurrent child processes with isolated state retain different keys, and two cold ensures for the same key execute one create under normal lock acquisition. Lock/read/write faults preserve uncached behavior without false positive entries or duplicate create within one attempt.
- Capability (Red today): `invalidateKnownLabel` forces the next ensure to create.
- Capability (Red today): `create` failing with realistic "label with name \"X\" already exists" stderr → treated as success and recorded (second call makes no `gh` call); a different failure (auth/network) records nothing and rethrows.
- Capability (Red today): name starting with `--` is rejected before any `create`.
- Capability (Red today): review provider, in `we:scripts/lib/__tests__/review-label-provider.test.mjs`: `setLabels` failing with realistic "could not add label: 'X' not found" invalidates, re-ensures once with remembered opts, retries once; a second failure propagates.
- Preservation (GREEN today; mutation proof: make the retry unconditional and it fails): same file, an unrelated `setLabels` failure (rate limit, PR not found) neither invalidates nor retries.
- Capability (Red today): land and drain add-label failures with a concrete missing label invalidate, re-ensure and retry once; a second failure and unrelated errors propagate under existing caller handling. Unknown implicit repo bypasses caching, two cwd repos never share hits, future timestamps miss, and a long-running watch rechecks after TTL expiry.
- Capability (Red today): land provider, in `we:scripts/lib/__tests__/forge-land-provider.test.mjs`: a second `ensureLabel` for the same label within the TTL makes no `gh` call.
- Capability (Red today): in `we:scripts/__tests__/merge-ai-prs.test.mjs`, two sweeps in separate processes (fresh `ensuredLabels`) mint each label once, not twice.

## Proof plan

Before/after on the live drain: count `label create` rows per hour in the conveyor calls ledger (op label create) before the change vs after a drain restart on the new build; expect at most one create per (repo, label) per 24 h window during normal cache operation, excluding explicit invalidation and documented cache/lock faults (counted per repo and label over one full TTL after restart) vs a newly captured baseline (the incident reported 295/h). Also a CLI probe: call `ensureLabelCached` twice for one label against a real repo and show the second makes no `gh` call.

## Edge cases this change must handle

1. **Untrusted text** — keys encode the exact (repo, name) tuple; names come from constant tables (`REVIEW_LABEL_META`) or `review-round:<N>` (numeric N); a name starting with `--` is rejected before argv; the JSON key is only a data key, never a path, shell or regex.
2. **Truncated reads** — n/a: the cache reads only its own small JSON file; not-found detection reads the single `gh` failure text, not a paged list.
3. **Shared state files** — written by several processes: `withFileLock` + `writeJsonAtomic`, re-read and merge inside the lock; stale-lock steal is already guarded in `withFileLock`.
4. **Fail closed** — unreadable/corrupt cache means "unknown", so we create (never skip); a failed `create` records nothing; a failed cache write after a successful create is swallowed (the next process just re-creates).
5. **Identity scoping** — key includes repo slug (`null` resolved to the cwd repo slug or caching bypassed, never a bare shared key) and exact label name.
6. **State over time** — 24 h TTL bounds drift from hand-deleted labels; the not-found invalidate-and-retry covers deletion inside the TTL; a restart mid-write leaves the old or new file (atomic rename).
7. **Who wrote it** — n/a: the file grants no trust, it is only a "created recently" hint; a forged entry can at worst delay a create, and the not-found retry repairs that.

## Follow-ups

- Prefetch `gh label list` once per repo per day to warm the cache.
- Cache hit/miss counters in conveyor metrics.
