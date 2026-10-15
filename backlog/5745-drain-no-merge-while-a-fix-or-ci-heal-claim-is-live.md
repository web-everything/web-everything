---
bornAs: xh8442i
kind: task
parent: "5767"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-claim-held.test.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs", "we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-14"
preparedAgainstSha: "da26ecf514707b05e79836199645898a91f85ba2"
tags: []
estimatedLoc: 310
---

# Drain: no merge while a fix or ci-heal claim is live

Slice S6a of the async-daemons epic (S3t needs it). Preserve the head pin and extend the drain's existing read-only fix-claim check to dispatcher `fix` and `ci-heal` claims. A live claim defers the merge with a stable `claim-held` skip reason. No claim acquisition, release, heartbeat, or drain-lease change belongs here.

## Done when

- [A1] A push racing the merge is refused by the existing `--match-head-commit` pin; the drain does not report a successful merge.
- [A2] A live `fixing`, `fix`, or `ci-heal` claim defers an otherwise mergeable PR with a `claim-held` skip reason (J2-10, J2-22).
- [A3] One real `claim-held` skip is observed in the live daemon log (location and capture procedure in Proof plan).

## Non-goals

- Writing or taking claims from the drain; changing the drain lease (R4).
- Changing claim ownership, TTL/reclamation policy, or implementing quarantine.
- Making a read-only claim observation atomic with a remote merge. A claim acquired after the observation remains a timing window; the head pin separately refuses a changed head.

## Edge cases this change must handle

1. **Untrusted text** — holder strings are diagnostic data only, never commands. Classifier precedence must prevent holder text from selecting a different skip kind.
2. **Truncated reads** — the low-level reader returns null on parse/read errors (we:scripts/readiness/file-locks.mjs:244-251). Null alone is not proof of absence. For all three kinds, an existing claim directory with no readable parsed entry defers with an unreadable-store placeholder.
3. **Shared state files** — reads only; no acquire/release/heartbeat or cleanup, including when an entry disappears during the read. A transient uncertainty may defer one pass.
4. **Fail closed** — errors other than confirmed absence defer. Use a filesystem probe that distinguishes ENOENT from permission/I/O errors; an existence-only boolean that hides errors is insufficient. Valid entries retain the existing lease policy.
5. **Identity scoping** — normalize the repo slug to the claim-store key and use repo + kind + PR, never head SHA. Different repos or PRs must not block each other.
6. **State over time** — valid expired entries do not block; live heartbeats do. `fixing` honors its stored TTL; dispatch kinds use the existing ten-minute default. No PID-liveness shortcut. Quarantine integration is a follow-up to epic 5767 O15.
7. **Who wrote it** — dispatch entries have an owner but no `meta.who`; normalize this shape before attachment. A live claim must not disappear because display metadata is absent.

## Design

Rechecked against checkout `da26ecf514707b05e79836199645898a91f85ba2` (existing preparation stamps below remain runner-owned). This is **partly delivered, not already done**:

- `readLiveFixClaim` reads only `fixing` (we:scripts/conveyor/fix-procedure.mjs:135-138). The existing dispatch-kind loop in `liveForeignDispatch` is for writer admission, not the drain (we:scripts/conveyor/fix-procedure.mjs:183-192).
- The merge-site fresh read attaches this fixing-only reader (we:scripts/merge-ai-prs.mjs:4507-4515). Attachment requires `meta.who` and catches thrown errors (we:scripts/merge-ai-prs.mjs:904-910). Dispatcher metadata has no `who` (we:scripts/conveyor/fix-dispatch-claim.mjs:132-139).
- The classifier already refuses an attached claim, but emits `fix claim held by` (we:scripts/merge-ai-prs.mjs:1023). The ordered skip classifier lacks `claim-held` (we:scripts/lib/drain-skip-reasons.mjs:14-43).
- Fresh-head revalidation already rejects H1 → H2 (we:scripts/merge-ai-prs.mjs:1076-1088), and the actual merge receives the pinned SHA (we:scripts/merge-ai-prs.mjs:6551). These protections must remain.

Add a drain-specific combined reader `readLiveDrainClaim` in we:scripts/conveyor/fix-procedure.mjs. Inspect `fixing`, `fix`, and `ci-heal`, returning the first live/uncertain claim or null only when every kind is absent or expired. Reuse `readFixDispatchClaim`, `fixDispatchResource`, and the shared lock-directory mapping (we:scripts/conveyor/fix-claim-store.mjs:42-60; we:scripts/readiness/file-locks.mjs:194). Keep `readLiveFixClaim` and other writer-facing callers unchanged.

For a null low-level read, inspect the keyed directory with an error-preserving filesystem operation: ENOENT means absent, an existing directory means unreadable/incomplete, and other errors propagate to attachment's fail-closed catch. Apply this to `fixing` as well as dispatch kinds; do not change the shared tolerant reader. For parsed entries use `isLiveFixClaim` for `fixing` (we:scripts/conveyor/fix-procedure.mjs:128-132), and `isLeaseExpired` with `DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES` for dispatch kinds (we:scripts/conveyor/fix-claim-store.mjs:23). This preserves the existing heartbeat and expiry semantics (we:scripts/readiness/file-locks.mjs:96-99). In particular, equality with the TTL is still live; expiry uses strict greater-than. A parsed entry with an unparseable heartbeat remains expired under the existing policy (we:scripts/readiness/file-locks.mjs:84-99); distinguish this from a null parse, which requires the directory probe. This card does not redefine lease validity.

Normalize live entries to the attachment's existing shape: preserve metadata, populate `meta.who` from existing `who`, then owner, then a kind-specific placeholder; retain `claimedAt` when present. Synthetic uncertain entries also have a nonempty `meta.who`. Wire the combined reader into the existing fresh-read attachment in we:scripts/merge-ai-prs.mjs:4514. Keep the injected-reader seam and existing classifier gate ordering.

Prefix the claim skip reason with `claim-held:`. Add `claim-held` to `SKIP_KINDS` and a leading anchored classifier rule in we:scripts/lib/drain-skip-reasons.mjs. Existing `buildSkipReasons` and stderr formatting then carry the stable kind without a new logging channel. Holder strings containing `BEHIND`, `cap`, or `review hold` must not override the prefix.

## MVP

- Read all three claim kinds at the existing merge-site fresh-read boundary, including real dispatch-shaped entries without `meta.who`.
- Fail closed on unreadable/incomplete keyed claims, retain existing expiry semantics, and never mutate claim state.
- Emit `claim-held` through the actual aborted-revalidation skip row and stderr summary.
- Demonstrate A1 at the production merge-call boundary, A2 through the production reader/attachment/classifier chain, and A3 in a real daemon pass.

## Test plan

Use the host heavy-run queue for every test invocation: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>` (repo-qualified notation; execute the path relative to the WE checkout without the `we:` prefix).

- **Reader cases, RED first:** extend we:scripts/conveyor/__tests__/fix-procedure.test.mjs for the combined reader using temporary claim roots and fixed time. Cover each live kind, dispatch metadata without `who`, an expired kind followed by a live different kind, all absent/expired, heartbeat extension via the owner heartbeat file (we:scripts/readiness/file-locks.mjs:252-255), exact-TTL and just-expired boundaries, parsed invalid-heartbeat compatibility, repo-slug normalization, and foreign repo/PR isolation. Write truncated entries and directory-with-missing-entry cases for each kind; inject permission/I/O failures rather than relying on host permissions. Cover confirmed ENOENT, EACCES/EIO, and an entry disappearing between the read and directory probe; only confirmed absence permits proceeding. Assert placeholders defer. Snapshot directory contents before/after reads to prove no mutation.
- **End-to-end attachment cases, RED first:** in we:scripts/__tests__/merge-ai-prs.test.mjs pass real dispatch-shaped entries through the combined reader, `attachLiveFixClaim`, and `revalidateForMerge` with an otherwise green fixture. Assert skip and `claim-held`, then removal/expiry permits merge. Update existing fixing-only expectations in we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs:176-201; preserve the thrown-reader test.
- **Skip-kind cases, RED first:** extend we:scripts/lib/__tests__/drain-skip-reasons.test.mjs for `classifySkipReason`, `buildSkipReasons` with `revalidationAborted`, and formatted stderr. Include misleading holder words to prove prefix precedence. These are new failing cases today, not already-green guards.
- **Production wiring and A1:** add we:scripts/__tests__/merge-ai-prs-claim-held.test.mjs, using the real CLI with isolated coordination/home state and hermetic git/gh shims, following we:scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs:1-88. Use a recognized constellation repo slug so the claim key resolves. A live dispatch claim must prevent any merge invocation and produce `claim-held` in stderr/JSON; absent and expired controls must reach the merge. A head changed before fresh revalidation must prevent the merge invocation. Separately advance the fake server head after the fresh read but before merge: record the real CLI's `--match-head-commit H1` argument, refuse the now-stale H1 against H2, and assert no successful merge or success effects. The unchanged-head control succeeds. This characterizes the existing pin, rather than claiming a new RED behavior. The shim proves drain wiring/error handling, not GitHub's implementation.
- Retain existing argv coverage in we:scripts/__tests__/pr-merge-gate.test.mjs:35-47 as a regression check (read/run only, outside the predicted edit scope).

Run the scoped suites and the existing merge-gate suite through the queue, then queue `npm run check:standards`. Record actual failures separately from proof; preparation itself does not implement these tests.

## Proof plan

1. During build, capture before/after output from the hermetic CLI case using a real-format `ci-heal` claim under an isolated `WE_COORDINATION_ROOT`. Before: merge attempted despite dispatch claim. After: no merge invocation, structured `claim-held` row and matching stderr. Repeat for `fix` and `fixing`, and keep an unclaimed merge control.
2. Capture the A1 race harness's actual merge argv and refusal result. For service-level proof of the head pin, use an authorized disposable PR: advance H1 to H2, attempt the pinned H1 merge, and record the refusal plus the PR remaining open at H2. Do not represent the hermetic server's refusal as an observed GitHub refusal.
3. Observe a real drain pass while a legitimate fix/ci-heal claim is live. Locate the active daemon’s configured stderr log first; the drain documents `we:.drain-daemon/daemon.log` as its expected destination (we:scripts/merge-ai-prs.mjs:6948), but that comment alone does not establish the deployed path. Quote the `claim-held` row, resolved log location, PR/repo, time, and claim kind, without secrets. Do not create claims on production work merely to manufacture evidence. If no such pass occurs, report A3 pending; an isolated replay does not satisfy the live acceptance criterion.
4. Retain queued test/gate results with the build review. This preparation turn performs no dispatch, claim mutation, live merge attempt, or implementation proof.

## Follow-ups

- Integrate quarantined claims when epic 5767 O15 supplies their storage/reader contract. The inspected claim readers currently have no quarantine branch; this card does not invent that contract or change expiry policy.
- Add stale-claim age diagnostics separately; the merge safety predicate needs only the existing live/expired result.
- If stronger exclusion is later required for claims acquired after the read, design a coordinated merge/claim fence separately. The read-only observation plus head pin is not such a fence.

## Progress

- 2026-10-14 preparation against `26105d8adb52d1d310d5e0109933a1a80b6a5c59`: old premise said the drain ignored live claims; corrected premise is that it already reads `fixing`, but misses dispatcher `fix`/`ci-heal` and a stable skip kind. Evidence: we:scripts/conveyor/fix-procedure.mjs:135-138, we:scripts/merge-ai-prs.mjs:4514 and we:scripts/lib/drain-skip-reasons.mjs:14-43. The original goal is retained.
- Old scope comprised three sources and four tests. Corrected scope retains those seven files and adds planned we:scripts/__tests__/merge-ai-prs-claim-held.test.mjs for production wiring and the late head-race case. Every source has a matching scoped test. Other cited modules are read-only dependencies, not predicted edits.
- Corrected earlier proof claims: the attachment catches thrown errors, but the underlying read swallows read/parse failures (we:scripts/readiness/file-locks.mjs:244-251). The drain-only fail-closed wrapper therefore covers all three kinds. Dispatch entries lack `who` at the actual writer (we:scripts/conveyor/fix-dispatch-claim.mjs:132-139). Revalidation alone does not exercise a push after the read; the existing CLI harness pattern makes that boundary testable without exporting a new production helper (we:scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs:23-88). Removed the former substitution of a dry-run replay for A3 live evidence.
- `estimatedLoc` was absent; set to **310 changed lines**: we:scripts/conveyor/fix-procedure.mjs ~60; we:scripts/merge-ai-prs.mjs ~10; we:scripts/lib/drain-skip-reasons.mjs ~5; we:scripts/conveyor/__tests__/fix-procedure.test.mjs ~80; we:scripts/__tests__/merge-ai-prs.test.mjs ~30; we:scripts/__tests__/merge-ai-prs-claim-held.test.mjs ~100; we:scripts/lib/__tests__/drain-skip-reasons.test.mjs ~20; we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs ~5. Estimate is grounded in the reader/attachment/classifier seams and existing CLI harness cited above. No size existed or was added; this is a task.
- Existing preparation stamps are preserved for the runner to replace. No blockedBy change is proposed.

- 2026-10-14 re-preparation against `da26ecf514707b05e79836199645898a91f85ba2`: incoming premise already identified fixing-only coverage; current source confirms it remains undelivered (we:scripts/conveyor/fix-procedure.mjs:135-138; we:scripts/merge-ai-prs.mjs:4514; we:scripts/lib/drain-skip-reasons.mjs:14-43). Old and corrected scope are the same eight entries: three source files and five matching existing/planned tests. Retain the incoming **310** changed-line estimate and per-file allocation above; no size change. Corrected the merge-call citation to we:scripts/merge-ai-prs.mjs:6551 and distinguished parsed invalid-heartbeat expiry from unreadable entries using we:scripts/readiness/file-locks.mjs:84-99. Added explicit boundary/race test cases within the existing reader-test allocation. The prior log destination was an assumed deployment fact; corrected proof requires resolving the active log before capture, with we:scripts/merge-ai-prs.mjs:6948 as source evidence for the documented destination. No unresolved policy fork or blockedBy change was found.
