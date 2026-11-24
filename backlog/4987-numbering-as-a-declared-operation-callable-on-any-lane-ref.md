---
bornAs: x52nn3j
kind: story
size: 8
parent: "3383"
status: open
blockedBy: ["4985"]
scope: ["we:scripts/operations/number-lane.mjs", "we:scripts/operations/number-lane-io.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/number-lane.test.mjs", "we:scripts/operations/__tests__/number-lane-io.test.mjs", "we:scripts/operations/__tests__/run.test.mjs", "we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain-numbering.test.mjs", "we:scripts/lib/card-number-allocator.mjs", "we:scripts/lib/__tests__/card-number-allocator.test.mjs", "we:scripts/lib/numbering-commit-evidence.mjs", "we:scripts/lib/__tests__/numbering-commit-evidence.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-11-24"
preparedAgainstSha: "c4573f9f4b4b58c330eccc3851b05deaae87068b"
tags: []
---

# Numbering as a declared operation callable on any lane ref

Expose producer numbering as a declared operation on a pinned lane tip, independent of the invoking checkout and of an existing PR. Compose the current allocator and immutable remote reservations, scan main and every pushed lane tip, and hold the shared numbering mutex through publication. Refuse incomplete evidence and unsupported settings with named outcomes. This supplies the operation for #4988; it does not migrate producer callers or replace their review gates.

## Acceptance

All five criteria are MVP Musts. The named tests below are build requirements, not claims that they already exist or have passed.

- [A1] **Executable** — `we:scripts/operations/__tests__/number-lane-io.test.mjs`, test `numbers an unpushed lane tip from another checkout`, invokes the real registered operation against a bare origin and two clones. Two dependent hash cards receive numbers; supported references and associated filenames are rewritten, both `bornAs` values survive, and unrelated blobs, the invoking index/worktree, main, and sibling lane refs remain unchanged. Include an already-pushed target and a held citation outside the rewrite scope: the latter refuses the whole publication. Fails before the operation exists; passes after Must 1.
- [A2] **Executable** — the same file, tests `replays both reservations after process death before lane push`, `recovers an acknowledged-late push`, and `published numbered tip is a no-op`, prove recovery in a fresh process/clone with no local ledger. Retry reuses the original two numbers, adds no reservation and creates no retry-induced gap; a subsequent invocation on the published tip creates no commit or push. Inject death after one reservation as well as after both. Existing unrelated gaps and permanently abandoned claims are not reclaimed. Fails before the operation exists; passes after Must 2.
- [A3] **Executable** — the same file, tests `scans main and every pushed lane in a narrow clone`, `holds the shared mutex until publication completes`, and `refuses incomplete evidence and moved targets`, prove allocation above occupied numbers even on an unfetched legacy lane without reservation refs; contention/ownership loss, unreadable or oversized listings, missing objects, malformed reservations, and target movement cause named refusal and no lane push. Exercise a real second lock contender and a concurrent remote target update. `we:scripts/lib/__tests__/card-number-allocator.test.mjs`, new test `lane snapshot option fails closed without changing legacy callers`, pins the opt-in boundary. These new cases fail before the build and pass after Must 3.
- [A4] **Executable** — `we:scripts/lib/__tests__/numbering-commit-evidence.test.mjs`, test `accepts only reservation-backed lane numbering commits`, and `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`, test `operation numbering passes the real gate while a hand-picked number fails`, verify the operation's real commit through the production evidence reader and gate wiring, with the bypass unset. Missing/mismatched claims, a forged subject or `bornAs`, an unproved parent rename, and unreadable evidence grant no exemption. Preserve existing drain/heal exemptions. Fails before that wiring exists; passes after Must 4.
- [A5] **Executable** — `we:scripts/operations/__tests__/number-lane.test.mjs`, test `resolves the declared numbering setting before effects`, and `we:scripts/operations/__tests__/run.test.mjs`, test `number-lane CLI reports settings and named refusals`, prove omitted config selects `producer-at-pr-open`, explicit config is honored, and `integration-branch`, unknown values, and unreadable entries refuse before allocation or publication, even for a hash-free tip. Assert value/source diagnostics, a nonzero CLI refusal, and registration as an operation with write effects. Fails before registration exists; passes after Must 5. No shared lock, queue-numbering, or birth-numbering default changes.

## Design

### Contract and operation boundary

Add `number-lane` in `we:scripts/operations/number-lane.mjs`, its IO bindings in `we:scripts/operations/number-lane-io.mjs`, and registration in `we:scripts/operations/run.mjs`. Follow the declaration/effect separation in `we:scripts/operations/routing-override.mjs:29` and the builder registration in `we:scripts/operations/run.mjs:279`. The compute step validates input and resolves settings; one effect owns the complete synchronous lock/read/allocate/rewrite/publish transaction. Never return a Promise from the synchronous mutex callback: `we:scripts/readiness/drain-lock.mjs:231` releases in `finally` immediately after the callback returns.

Proposed input is `{ ref, expectedHead, config = {} }`, with the repository supplied through the existing operation `cwd` binding. `ref` must be a fully qualified local or origin-tracking lane branch ref, resolving to the required commit SHA `expectedHead`; derive the destination as the corresponding `refs/heads/lane/...`. Refuse main, tags, arbitrary revision expressions, invalid refs and an unresolved/mismatched SHA. A local unpushed lane is supported; an already-pushed lane can be selected through its fetched origin-tracking ref. The operation need not check out that branch or require a PR number.

The IO result is `{ ok, outcome, sourceHead, newHead, assigned, pushed, setting, detail? }`. Success outcomes are `numbered`, `already-published`, or `no-op`; failures name `invalid-ref`, `head-moved`, `setting-refused`, `lock-unavailable`, `lock-lost`, `evidence-unreadable`, `evidence-limit`, `numbering-incomplete`, `reservation-conflict`, or `publish-failed`. Preserve publication evidence if cleanup fails after a successful push; never report that origin is unchanged when the push may have succeeded. Wire sink failures and the CLI finish function so refusals exit nonzero and retain the structured outcome, rather than treating a computed plan as successful execution.

Resolve `backlogIdNumbering` using `we:scripts/lib/backlog-id-settings.mjs:48`. The config object is supplied by the caller; absent config uses its existing platform default. Report the effective value and whether it came from the platform default, inline input, or descriptor override/flavor. This adds no new competing setting or environment alias. Generic project-config file/pointer loading remains outside this story, as in #4985; a supplied unreadable pointer must refuse. Both programmatic and CLI callers can supply the object, and the CLI test must exercise the production object-input parser. Do not consult the separate queue mode or number-at-birth enabled flag to bypass this setting refusal.

### Snapshot, locking and publication

Use the existing numbering key, with `runUnlockedOnContention: false`, a bounded 2-second acquisition wait, and heartbeats/ownership checks between synchronous Git phases and immediately before publication. Keep the shared default unchanged. A lock refusal names the holder/reason and asks the caller to retry; it never opens an unlocked path. Git child calls use argv, noninteractive execution, timeouts shorter than the lease, bounded output, and sanitized one-line diagnostics.

Under the lock, capture the remote target's current OID or confirmed absence. First recognize a recovery case: a present destination that is provably the operation-generated numbered descendant of `expectedHead`, backed by matching immutable claims, returns `already-published`. Otherwise a present destination must be an ancestor of `expectedHead`; divergent or unrelated movement refuses. When the selected origin-tracking ref has advanced to that proven numbered descendant on retry, permit recovery of the original source before rejecting the expected-head mismatch; arbitrary ref movement still refuses. Read a complete advertisement of main and all remote lane heads, fetch their exact objects into private temporary refs, and inspect each pinned tip's backlog paths. A narrow clone's configured fetch refspec is not the population. A failed fetch/read, truncated listing, missing main, malformed path listing, or output bound is a refusal, never an empty population. Recheck the advertised heads after the scan; if the population moved, return `head-moved` and retry a fresh invocation rather than spinning. This is a snapshot allocation floor, not an assertion that other hosts cannot publish after it.

Extend `we:scripts/lib/card-number-allocator.mjs` with an opt-in lane-snapshot evidence path; retain the existing main/reservation evidence default for current callers. Compute the new-number floor from the selected lane, pinned main, every pushed lane tip, and immutable reservation refs. Reuse the allocator's 32 MiB evidence bounds and 100-attempt reservation limit; do not truncate. Limit exhaustion names the affected read/phase and requires retry after repairing access/contention, or an explicitly reviewed bound increase for a legitimately larger repository. No fallback to a local-only assignment.

Create a private detached worktree for the pinned source, reusing `addNumberingWorktree`, `assertTrackedTreeEntries`, and the path guards from `we:scripts/lib/queue-branch-numbering.mjs:187,237,291`. The sparse form requires HEAD reads; a fallback to worktree reads must refuse. Reuse `numberPendingHashes` from `we:scripts/lane-drain.mjs:683`, adding optional evidence/heartbeat/commit-context plumbing without changing legacy defaults. Validate that no hash cards remain before publication. Keep its established rewrite boundaries: backlog, top-level agent docs/memory, flow citations, soak card metadata and associated path renames. Unknown live path-citation homes remain refusal cases; executable fixture payloads and historical hashes are not blindly rewritten.

Publish only the numbered descendant to the derived lane destination, with an explicit lease on the captured remote OID (empty lease for creation) and an ancestry check; never overwrite a changed or divergent remote head. Hold the mutex until the push result is checked. Return `newHead` for the eventual producer caller to adopt; do not reset its checkout or index. Remove temporary refs/worktrees in cleanup. For an ambiguous push, read back the remote destination and verify the numbered tree/mappings before reporting success; otherwise return a retryable publication refusal with uncertainty stated.

### Recovery and gate evidence

Reuse `reserveCardNumber` and its atomic create-only pair of number-reservation/card-identity refs (`we:scripts/lib/card-number-allocator.mjs:117`). Its identity replay already returns an earlier assignment even below today's high-water mark. Do not allocate again solely because a worktree, operation receipt, or local ledger disappeared. Add a read-only exported claim validator factored from the existing replay validation, shared by the operation's recovery and standards evidence. It must never reserve or push while checking a claim.

For recovery, verify a replayed number is not occupied by a different identity on the selected lane or scanned tips/main. Existing claims take precedence over a higher floor; conflicting claims refuse for repair. Restart the deterministic rewrite from the original source if the lane push did not occur. If it did occur, prove that the published tip is the numbering result for that source and return it. The operation adds no second reservation ledger. No schema migration or deletion of legacy local reservation state is needed.

Give the new operation commit a distinct machine-readable context containing its source SHA and hash/number pairs, while keeping existing callers' commit subjects unchanged. Add `we:scripts/lib/numbering-commit-evidence.mjs` to validate that context against commit ancestry, a hash-named parent card, the resulting numeric path and preserved `bornAs`, and the matching immutable remote claim pair. Treat commit text as a candidate to verify, never authority. A same-number different identity/path is not exempt. Bound history/blob reads and reject incomplete evidence.

Wire this evidence into `we:scripts/check-standards.mjs:839` and extend `handNumberedNewItems` in `we:scripts/check-standards-rules.mjs:3182` with an optional verified-pair input, empty by default. Preserve the existing drain/heal filter. Do not widen trusted drain authors, synthesize a drain identity, or set the hand-numbered-gate bypass. Keep the new evidence failure outside the existing broad catch that silently skips an unavailable main read: checking an operation claim with unreadable evidence must emit a gate error. Update the stale at-land-only diagnostic to name the sanctioned operation.

### Consumers and delivery

The immediate new caller is the operation builder in `we:scripts/operations/run.mjs`; cover its actual parser and effect result. The existing `numberPendingHashes` callers retain their signature/default behavior: `we:scripts/backlog.mjs`, `we:scripts/drain-followup-job.mjs`, `we:scripts/merge-ai-prs.mjs`, `we:scripts/pr-land.mjs`, `we:scripts/lib/drain-followup-job.mjs`, and `we:scripts/lib/queue-branch-numbering.mjs`. Existing direct-main publication still uses `we:scripts/lib/number-pending-hashes-before-push.mjs` from `we:scripts/push-if-green.mjs:196`; replacing that pre-push helper would require changing ownership of its caller's subsequent push and belongs with #4988.

Land operation, evidence support, gate wiring and tests together. The operation is callable but no producer is automatically rerouted in this story. The gate must understand its output before #4988 starts publishing through it. Cross-host final uniqueness at the write to main, acceptance re-parking, and producer adoption remain #4988's obligations under `we:docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish`.

## MVP

The complete design above is the smallest safe callable operation; the wider rollout is explicitly deferred below.

1. **Must 1** — a registered ref-targeted operation, isolated worktree, existing rewrite semantics, and lane-only publication (A1).
2. **Must 2** — durable identity replay after partial allocation, process death and uncertain push, plus a true repeat no-op (A2).
3. **Must 3** — all pushed lane tips contribute to the floor; bounded complete evidence, shared lock through push, and target/ownership fencing (A3).
4. **Must 4** — production standards-gate acceptance of verified operation assignments and rejection of unproved numeric additions (A4).
5. **Must 5** — existing numbering setting/default honored, named pre-effect refusals, CLI/effect result parity, and unchanged legacy defaults (A5).

Build order: add the red operation/real-Git fixtures; factor read-only reservation validation and add opt-in snapshot evidence; thread evidence and heartbeat through the allocator; implement the declaration and IO transaction; wire registration and gate verification; finish recovery/adversarial tests and run the focused regressions. No global gap-compaction, new reservation service, generic config loader, or producer rollout is hidden in the MVP.

## Test plan

Use isolated fixtures under the task's `$TMPDIR`, a local bare origin, and two narrow clones. Override lock roots, operation stores and configuration so tests cannot touch host daemons or real remotes. At least A1–A3 run real Git/worktree/process mechanics; injected failures supplement those fixtures rather than replacing them. A4 exercises the production evidence-reader/gate boundary, not just a fabricated set of approved pairs.

- New `we:scripts/operations/__tests__/number-lane.test.mjs` covers input validation, declaration/effects, settings and output contracts (A5).
- New `we:scripts/operations/__tests__/number-lane-io.test.mjs` covers A1–A3, real death/restart, partial allocation, push-response loss, confirmed empty/missing remote branches, main-only clone refspecs, unswept citations, retained `bornAs`, symlink/path confinement, cleanup after publication and diagnostics with hostile ref/path text. Assert no lane publication on every refusal; previously created immutable claims may remain.
- Existing `we:scripts/operations/__tests__/run.test.mjs` gains the registered CLI case (A5); existing `we:scripts/__tests__/lane-drain-numbering.test.mjs` gains evidence/heartbeat opt-in parity while keeping its legacy cases.
- Existing `we:scripts/lib/__tests__/card-number-allocator.test.mjs` gains lane-floor, replay/conflict and bounded-completeness cases (A2/A3); new `we:scripts/lib/__tests__/numbering-commit-evidence.test.mjs` and existing `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` cover A4, including the production error boundary and unchanged default denial.
- Run the existing `we:scripts/lib/__tests__/queue-branch-numbering.test.mjs`, `we:scripts/readiness/__tests__/drain-lock.test.mjs`, `we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs`, and `we:config/__tests__/backlog-id-settings.test.ts` as compatibility regressions. Their paths are verification dependencies, not predicted edits; never weaken their assertions to accommodate the new operation.

## Proof plan

Record RED/GREEN for the new A1–A5 cases: missing operation/registration is the initial RED, followed by behavior-specific failures as the implementation is added. Preserve command, exit code, case names and fixture observations. No RED/GREEN run is claimed by this preparation.

All test execution goes through host admission. For example, this command retains repo-qualified authored paths while stripping the prefix only for execution:

```sh
queue='we:scripts/readiness/heavy-admission.mjs'
case_file='we:scripts/operations/__tests__/number-lane-io.test.mjs'
node "${queue#we:}" run --wait-ms=60000 -- npx vitest run "${case_file#we:}"
```

Use that queue form for the other named affected files, then run the standards gate through the same admission entry with `npm run check:standards`. Wait once using the queue's own wait budget if busy; report non-admission instead of polling or bypassing it.

For the decisive A1/A2 trace, retain source/remote OIDs, the two reservation blob OIDs, resulting card contents and tree diff, the subprocess death boundary, retry output, and the final no-op output. For A3 retain the observed lock holder at the push boundary and proof the second contender was refused. For A4 retain real gate output for the generated commit and the deliberately hand-numbered fixture. This establishes the callable operation; activation in real producer flows is proved by #4988, not inferred here.

## Follow-ups

- #4988 wires producer-before-review callers, adopts `newHead`, blocks PR opening on refusal, and verifies clashes at the write to main. It also owns changing the PR-route numbering tail; direct-filing behavior remains available.
- #4989 owns the required backlog-ID check and operator setup. This operation's local hand-numbered exemption does not substitute for that required check.
- Building `integration-branch`, generic config-file/pointer loading, or altering permanent reservation/gap policy requires separate work. This story only consumes the declared default and refuses unsupported values.
- Migrating legacy unlocked mutex callers or the queue wrapper onto this operation is separate caller work; reuse helpers here without changing those defaults opportunistically.

## Proposed blockedBy changes

- remove 4985 — the required setting resolver and named unbuilt-value refusal now exist (we:scripts/lib/backlog-id-settings.mjs:48). Independent reviewer confirmation is required; frontmatter remains unchanged.

## Progress

- Premise checked against local HEAD `c4573f9f4b4b58c330eccc3851b05deaae87068b`; no remote refresh was performed. The operation registry has no numbering entry. This goal is not already delivered: existing branch preparation is queue/PR-shaped, not the requested standalone operation.
- **Old premise/scope:** the card suggested building from the pre-push helper and changing the shared lock, with directory-wide operation/test scopes. **Corrected premise/scope:** the allocator is `we:scripts/lane-drain.mjs:683`; the pre-push helper delegates at `we:scripts/lib/number-pending-hashes-before-push.mjs:65` and releases before its caller's push at `we:scripts/push-if-green.mjs:210`. Existing branch preparation already builds a detached worktree and opts into the lock at `we:scripts/lib/queue-branch-numbering.mjs:361,392,471`, but allocates from main plus queue reservations and requires a PR context. Reuse its exported guards/worktree helper; do not wrap the whole queue operation. File-level scope now names the new operation/IO, registry caller, actual allocator, reservation evidence, gate caller/rule and their matching tests. Drop edits to the direct-main helper and lock implementation; fail-closed locking is already an opt-in at `we:scripts/readiness/drain-lock.mjs:210,222`.
- **Recovery drift:** `we:scripts/lib/card-number-allocator.mjs:117,126,158` already atomically reserves and replays identity/number pairs; `we:scripts/lane-drain.mjs:1002` uses it. Existing tests at `we:scripts/lib/__tests__/card-number-allocator.test.mjs:236,249` assert cross-host replay and reuse below main's current maximum. Therefore “no gap” is precisely no extra number consumed by retry of these identities, not rollback of immutable claims or global gaplessness. The original same-numbers-on-retry goal is retained.
- **Gate drift:** exemptions already run in `we:scripts/check-standards.mjs:839` via `we:scripts/lib/queue-branch-numbering.mjs:72,111`; the pure rule alone cannot recognize operation provenance. Existing exemption trusts drain authors from main (`we:scripts/lib/queue-branch-numbering.mjs:32`), so a producer operation must not impersonate that author. Add a separate reservation-backed evidence reader and wire the real gate, retaining the existing drain/heal behavior.
- **Missing test correction:** the direct-main helper's existing tests are `we:scripts/__tests__/push-if-green-numbers-pending-hashes.test.mjs:36`, not the originally suggested library-test pattern. They remain a compatibility check. The new scope lists concrete matching tests for every edited source, including the omitted gate caller and allocator.
- **Size correction: 5 → 8.** Estimate roughly 850–1,150 changed lines: two new operation files × 110–150, registry wiring × 15–25, allocator/evidence plumbing across two existing files × 40–65, new commit-evidence reader × 90–130, gate caller/rule together × 25–45, and seven test files × roughly 60–70. The basis is the existing worktree/guard reuse at `we:scripts/lib/queue-branch-numbering.mjs:187`, reservation replay at `we:scripts/lib/card-number-allocator.mjs:126`, allocator option seam at `we:scripts/lane-drain.mjs:683`, and gate composition at `we:scripts/check-standards.mjs:839`. This is a story: no `estimatedLoc` is added.
- Preparation edits only this card. No implementation, test execution, independent review, preparation stamp, commit or publication is claimed. The runner owns checks, stamping and the parked review.
