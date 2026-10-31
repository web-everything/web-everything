---
bornAs: xn3xlpp
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/settings/rebuild-smoke.json", "we:scripts/lib/__tests__/daemon-rebuild-shared-smoke.test.mjs"]
scopeRationale: "The build edits the smoke reuse path, the rebuild state helpers and the settings file, and adds one new test file; the generic test name the tooling inferred for the state helper is not a real test for this change."
dateOpened: "2026-10-29"
preparedDate: "2026-10-29"
preparedAgainstSha: "f300ed270ebb570fece3dd659713d79b0775219d"
tags: []
---

# Setting: reuse one tested daemon candidate per main sha

When main moves, ~6 daemons each build and smoke-test their own candidate (we:scripts/lib/daemon-rebuild/, self-sync state under ~/.claude/daemon-self-sync-state/). Add a policy-cascade setting (default off = today's behaviour) that reuses one tested candidate per main sha. No guard weakening; one settings change turns it on/off; prototype-loaded on daemons before merge (R228).

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/daemon-rebuild-shared-smoke.test.mjs` fails before this item lands (module/setting missing) and passes after.
- [A2] **Executable** — default off: the same test file's "default-off" case asserts no pool file is written and a second clone runs the full smoke; the on-case twin fails before (module missing) and passes after; the off-case is a regression guard that must keep passing.
- [A3] **Executable** — exact match only: the "mismatch" cases (tree, lockHash, nodeVersion, harnessHash, age, future date) each assert a full smoke runs.
- [A4] **Executable** — fail closed: the "fail closed" cases (corrupt, truncated, wrong shape pool file) assert a full smoke and the alert `shared-smoke-pool-refused`, never reuse.
- [A5] **Executable** — one-change toggle: the cascade case asserts `WE_REBUILD_SMOKE_SHARE` and the `we:scripts/settings/rebuild-smoke.json` value flip the behaviour on and off with the source logged.

## Non-goals

- [N1] No sharing of built commits, worktrees or objects between clones; no change to smoke contents, timeouts or rejection logic; no change to how overlays or main are planned.
- [N2] No weakening of any existing guard: the per-clone reuse path, env-check re-run and `smoke-reused-env-failed` hold are untouched.

## Edge cases this change must handle

1. **Untrusted text** — the pool file is local JSON that other daemons wrote; every field is type-checked as a string/number and compared by strict equality, never interpolated into a shell, argv or path. Alert text built from entries uses `foldUntrusted` (`we:scripts/lib/jury-core.mjs`) on the publisher name. `n/a` for LLM/PR text: none reaches this path.
2. **Truncated reads** — a short or partial JSON file fails to parse and is treated as "no valid entry" with an alert (never as a hit); atomic rename on write prevents readers seeing half files; the pool is capped (newest 20 entries) so reads stay small. No `gh`/`git` paged reads added.
3. **Shared state files** — the pool is written by ~6 daemons: `writeJsonAtomic` plus `withFileLock`, re-read under the lock and merge by key (compare-and-set), stale-lock steal only under the existing guard; a lock timeout skips publishing (best effort) and never blocks the smoke.
4. **Fail closed** — unreadable, unparsable, wrong-shape file, missing local identity (`smokePassIdentity` returns null), clock skew (negative age), or any mismatched field -> full smoke, with a named reason in the log. Setting invalid -> default `false`. Only an exact match on tree + lockHash + nodeVersion + harnessHash within `reuseHours` reuses.
5. **Identity scoping** — the match is on content (tree sha, lock hash, node version, harness hash), recomputed locally by the reader, so a record cannot apply to a different tree, dependency set, Node or smoke harness; the publisher cloneKind is recorded for audit only. Hash and card-number spellings: n/a, no card ids are keyed.
6. **State over time** — TTL via `reuseHours`; entries for old main shas simply age out and the pool keeps the newest 20; a new head makes a new tree so old records never match; a daemon restart mid-publish leaves either the old or new file (atomic rename); turning the setting off makes entries inert, turning it on again re-validates age and identity.
7. **Who wrote it** — any local process can write the file, so trust comes from content, not authorship: the reader recomputes identity and requires exact field equality; the file lives in the daemon state dir (user-owned), and a failed env check after reuse still holds the rebuild exactly as the existing reuse does. Entries are never accepted from a path outside `stateDir`.

## Premise check

Checked against main 88d94eb319: not delivered. `git log` has no commit for 7499. A per-clone smoke-pass reuse already exists (`resolveSmokeReuse`, `we:scripts/lib/daemon-rebuild/smoke.mjs:45`; `smokePassed` in the per-clone rebuild state file, `we:scripts/lib/daemon-rebuild/state.mjs:51`), but each clone has its own state file, so ~6 daemons that reach the same tree still each run the full smoke. That gap is this card. Scope correction: the card lists `we:scripts/lib/daemon-rebuild/candidate.mjs` and `we:scripts/lib/daemon-rebuild/index.mjs`, but the reuse decision lives in `we:scripts/lib/daemon-rebuild/smoke.mjs` (`smokeSha`, line 439) and `we:scripts/lib/daemon-rebuild/state.mjs`; scope is widened to those plus `we:scripts/settings/rebuild-smoke.json`. No goal change.

## Design

What is shared: the PROOF that a tree passed the full smoke, not a git commit or worktree. Each daemon clone builds its own candidate commit (own overlays, own object store), and `smokeSha` (smoke lines 439-504) materializes it and runs `runSmoke`. For daemons whose plan yields the same tree (main-only and same-overlay-set clones), that smoke is repeated ~6 times per main move.

1. New setting `rebuildSmoke.shareAcrossClones` (boolean, standard default `false`), resolved in `resolveSmokeReuse` (`smoke line 45`) through the existing `cascadePolicy('rebuildSmoke', ...)`: standard -> platform -> `we:scripts/settings/rebuild-smoke.json` -> env `WE_REBUILD_SMOKE_SHARE` (0|1). Sources are already logged by the `smoke-reuse` log line (`smoke line 368`). Turning it on or off is a one-line edit of `we:scripts/settings/rebuild-smoke.json` (or the platform preference); it is read on every smoke, no restart.
2. New shared pool file a shared smoke-passes file in the state dir (state dir from `stateDir`, `state line 31`), read/written only with `readJsonSafe`/`writeJsonAtomic` under `withFileLock` (`we:scripts/lib/atomic-json-file.mjs:64,154`). The file is named `smoke-passes-shared` (a JSON file) with a `version: 1` field (unknown version = fail closed). Each entry: `{tree, lockHash, nodeVersion, harnessHash, cloneKind, key, passedAt, publisher: cloneKey}` — the raw fields, not just a hash. `smokePassIdentity` is extended to also return `{lockHash, nodeVersion, harnessHash}` (a Must) so the reader can compare each field with strict equality AND recompute the key from the entry raw fields, requiring it to equal the local key. Merge rule under the lock: equal key keeps the newest `passedAt`; cap 20 newest; eviction only drops the oldest.
3. Write side: where `smokeSha` records `st.smokePassed` (`smoke line 490-494`), when the setting is on also upsert the entry into the pool. Same preconditions as today (`completeSmokePass`, not cached, no busy-pool skip, not a `label` comparison run, and `(!dispatch || dispatch.result.ok)` so a smoke whose dispatch check failed never publishes). Materializing the candidate still runs on a reuse; the saving is the code-kind checks only.
4. Read side: in `smokeSha`, when the per-clone lookup misses and the setting is on, look in the pool. The reader recomputes `identity` locally (`smokePassIdentity`, `smoke line 71`) and accepts a pool entry only if tree, lockHash, nodeVersion and harnessHash ALL equal the local values byte-for-byte and age is within `reuseHours` (non-negative). The pool key is derived locally, never trusted from the file. cloneKind STAYS in the shared match (reviewer finding: the code-kind dry-run checks read clone-specific runtime state through the candidate smoke env, so identical content alone is not proof). So sharing only helps clones of the same kind; excluding cloneKind is a Follow-up needing evidence that no code check depends on it. Environment checks still re-run exactly as in today's reuse path (`reuseCode: true`, `smoke line 464`), so a reuse never skips env-dependent checks, and a `smoke-reused-env-failed` hold behaves as today.
5. Off means off: when the setting is false the pool is neither read nor written, so flipping it off instantly returns to today's behaviour; stale entries are inert.
6. Prototype loading (R228, skill `prototype-load`): the code is inert with the default `false`, so the branch is loaded on all daemons via the prototype-load operation, then the settings file is flipped (a separate settings-only change) to turn it on, and flipped back to cancel.

## MVP

Musts only: the setting + cascade resolution, the shared pool read/write behind it, the exact-match acceptance rule, fail-closed refusals, the log line naming source and hit/miss. Out of scope (see Follow-ups): sharing a built commit or worktree, one elected builder, sharing across different trees.

## Test plan

New `we:scripts/lib/__tests__/daemon-rebuild-shared-smoke.test.mjs` (run scoped through heavy-admission):
- **Preservation (GREEN today):** default-off (regression guard, paired with the on-case below which is RED today): with no setting, a spy on the pool writer sees zero calls, no pool file is created, an existing pool file stays byte-identical, and clone B runs the full smoke.
- **Capability (Red today; new module/test, proposed):** identity extension: `smokePassIdentity` returns lockHash, nodeVersion, harnessHash (RED today: undefined).
- **Capability (Red today; new module/test, proposed):** key-only forgery: a pool entry whose key equals the local key but whose raw fields differ -> refused.
- **Capability (Red today; new module/test, proposed):** cloneKind: same tree, different cloneKind -> full smoke.
- **Capability (Red today; new module/test, proposed; regression gate):** `shared-hit-materializes-local-candidate`: A passes and publishes; B (separate state file, same tree and cloneKind) reuses (`reused: true`, `reuseCode: true`). Spy on candidate materialization: B must call `materializeCandidate` with its own root, candidate sha and lease path before `runSmoke`; `runSmoke` receives that materialized path and still runs env checks, and `removeCandidate` cleans up B's candidate afterward. RED before: B always smokes; mutation proof: bypass materialization on a shared hit -> the call/order/path assertions fail.
- **Capability (Red today; new module/test, proposed):** shared-hit-materialization-failed: a matching shared entry exists but B's `materializeCandidate` fails -> preserve `worktreeFailed` with the materializer's reason, never call `runSmoke`, never report a successful reuse and never publish a pass. Mutation proof: returning shared success before materialization -> the failure/result assertions fail.
- **Capability (Red today; new module/test, proposed):** on, mismatch: differing tree, lockHash, nodeVersion or harnessHash (one case each) -> B smokes fully. RED if the reader trusted a key only.
- **Capability (Red today; new module/test, proposed):** age: entry older than `reuseHours`, and a `passedAt` in the future -> refused.
- **Capability (Red today; new module/test, proposed):** fail closed: unreadable, truncated, non-JSON, wrong-shape pool file -> full smoke, plus an alert naming the reason; never "reuse".
- **Capability (Red today; new module/test, proposed; regression gate):** `missing-local-identity-runs-full-smoke`: with sharing on, no per-clone pass and an otherwise valid shared entry, make `smokePassIdentity` return null (failed tree verification, failed read of an existing lockfile, failed lockfile-presence check, or unreadable harness; one fixture each) -> complete the full smoke without throwing (`reuseCode: false`), log the named missing-local-identity refusal, never reuse and never publish an identity-less pass. Mutation proof: accept the pool's identity/key when local identity is null -> the full-smoke/refusal assertions fail.
- **Preservation (GREEN today):** failed or partial smoke (skipped row, busy-pool skip, cached, `label` run, failed dispatch smoke) never publishes (regression guards, each paired with a publishing on-case).
- **Preservation (GREEN today):** env check failure after a shared reuse still holds with `smoke-reused-env-failed`.
- **Capability (Red today; new module/test, proposed):** merge/eviction: equal key keeps newest `passedAt`; the 21st entry evicts the oldest.
- **Capability (Red today; new module/test, proposed):** unknown pool `version` -> full smoke plus alert `shared-smoke-pool-refused`.
- **Preservation (GREEN today):** toggle off after on: entries present, setting false -> not read, not written.
- **Capability (Red today; new module/test, proposed):** two concurrent publishers keep both entries (lock + re-read merge); a stale lock is stolen only under the existing guard.
- **Capability (Red today; new module/test, proposed):** `publish-lock-timeout-preserves-smoke-success`: inject a publication lock timeout after successful full smoke; assert smoke/rebuild completion remains successful, no shared entry is published, and the previous pool remains complete and unchanged.
- **Capability (Red today; new module/test, proposed):** `interrupted-publish-preserves-complete-pool`: inject interruption during the temporary write and immediately before/after atomic rename; assert readers see a complete old or complete new pool, never partial JSON or lost unrelated entries, and a caught publication failure does not turn successful smoke into a failed rebuild.
- **Capability (Red today; new module/test, proposed):** cascade: env `WE_REBUILD_SMOKE_SHARE=1` beats file `false` and permits shared reuse/publication; invalid file value (string) keeps the default `false` when env and platform overrides are absent.
- **Capability (Red today; new module/test, proposed):** `cascade-env-disables`: env `WE_REBUILD_SMOKE_SHARE=0` overrides file `true`, runs full smoke, and neither reads nor writes the pool.
- **Capability (Red today; new module/test, proposed):** `cascade-file-enables-and-disables`: with env and platform overrides absent, valid file `true` enables shared reuse after a per-clone miss and publication after a successful full smoke, while file `false` runs full smoke without pool I/O.
- **Capability (Red today; new module/test, proposed):** `cascade-logs-source`: isolate environment `1`/`0` overriding the opposing file value, file `true`/`false` with env absent, and absent/invalid file values with env and platform overrides absent; assert both effective behavior and logged effective value/selected source (environment, settings file, or standard default respectively).

## Proof plan

0. Measure first: count how many daemon clones share a cloneKind and plan the same tree after a move. If the hit count is zero, report it on the card before any build (the setting would be useless).
1. Before: capture `smoke-timings` lines from the alert/log of two daemons after one main move (full smoke each, ~100-140s).
2. Tests green, Codex audit NOT WEAKENED, then load the branch on the daemons via `prototype-load` with the setting still false; confirm the rebuild smoke gate passes and behaviour is unchanged.
3. Flip `rebuildSmoke.shareAcrossClones` to true in the settings file; on the next main move capture: first daemon full smoke and publish, later same-kind daemons log `smoke reused ... (shared)` with `reuseCode: true`, env checks re-run and a smoke time clearly below the full-smoke time from step 1; a daemon with a different tree or kind still runs the full smoke (negative proof).
4. Flip back to false; confirm the next move shows full smokes again (cancel proof).

## Follow-ups

- Share the built candidate commit/worktree (needs object-store sharing across clones).
- Elect one builder per sha with the others waiting (builds on `claimBuildLease`, `lease line 113`).
- Reuse for different trees that differ only in non-runtime files.
