---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild-settings.json", "we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-hold-live-pinned.test.mjs"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "2ee4dcbf9bf17c1674e7948339d0b15c164151b6"
tags: []
---

# Daemon cure overlays auto-refresh when main outruns them

Held card 390 (coroner-1030). A registered daemon cure overlay is outrun by main and the clone freezes until a worker hand-builds a refreshed -mN, prototype-loads it and removes the old ref. we:scripts/lib/daemon-rebuild/auto-rebase.mjs already does that repair, but it never starts on the pinned-overlay-conflict refusal (we:scripts/lib/daemon-rebuild/prepare.mjs) or for a no-PR newcomer overlay-conflict-unresolved, and its dead-end refusals (test selection over 100, agent failed) retry every 30 min forever with no escalation. Review daemon froze 22:17-02:34 ET 10-30/31; fix daemon logs the same on lane/forge-remote-exec-s2 and lane/unfreeze-fix-top-1030a-m1 on 10-31.

## Evidence (premise check against main 2ee4dcbf9b, 2026-10-31)

- **The repair already exists.** `runAutoRebase` (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:102) clones to scratch, merges `origin/main` into the overlay (:148), has Codex resolve conflicts (:181), refuses if any parent test file disappears (:192-196), runs import-graph-selected tests through heavy-admission (:241), requires a Codex audit answering exactly `NOT WEAKENED` (:259-260), pushes `<ref>-auto-<n>`, writes a pending swap, then registers the new ref with `stackBases: [ref]` BEFORE anything is removed (:272-275). `finishPendingSwaps` (:304) removes the old ref only after the clone's adopted HEAD contains the new SHA (:321) and the new tip still contains the old tip (:334). That is add-before-remove, and it is what the worker did by hand on 10-31.
- **Gap G1: a pinned refusal never kicks it.** The kick is only on the `established-overlay-hold` path (we:scripts/lib/daemon-rebuild/prepare.mjs:360-371, fed by `plan.establishedLost`, we:scripts/lib/daemon-rebuild/plan.mjs:777-787). A `pinned-overlay-conflict` refusal (we:scripts/lib/daemon-rebuild/plan.mjs:441-446) returns at we:scripts/lib/daemon-rebuild/prepare.mjs:327-349 without a kick. Live: the review clone's events show `overlay-main-merge-conflict` for lane/unfreeze-review-top-1030a-m1 at 03:41Z and NO `auto-rebase-*` event for it before the hand `added -m2` (05:59Z) and `removed -m1` (06:09Z).
- **Gap G2: dead-end refusals loop with no escalation.** Fix clone (`~/.claude/daemon-overlays/fde6cfdae10394e1.events.jsonl`): `auto-rebase-needs-you` for lane/unfreeze-fix-top-1030a-m1 at 06:55Z (stage resolve, "agent failed or incomplete"), then 07:47Z, 08:19Z, 08:56Z, 11:33Z (stage tests, "test selection over 100; human review required", we:scripts/lib/daemon-rebuild/auto-rebase.mjs:221). Each retry re-does the clone, the Codex resolve and the selection only to hit the same fixed refusal. The `needs-you` goes only to the overlay events file and the alerts jsonl (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:34-43); it never reaches the needs-you feed the operator reads, unlike overlay-main-sync (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:174 `publishAttention`). The resolve-stage failure also drops Codex's own exit reason (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:86-89).
- **Gap G3: a no-PR conflicting overlay wakes nobody.** `overlay-conflict-unresolved` wakes a fixer only when `pr != null` (we:scripts/lib/daemon-rebuild/prepare.mjs:308-311). lane/forge-remote-exec-s2 (#6059's overlay, `pr:null`) logged it at 11:30Z and 11:42Z in `~/workspace/wev-fix-daemon/.conveyor/fix-dispatch-daemon.log`, with nothing started.
- **Auto-retire when main already has it: mostly exists.** we:scripts/lib/daemon-rebuild/plan.mjs:530 (`pr-merged`), :585 and :676 (`in-main`) emit `remove` decisions that we:scripts/lib/daemon-rebuild/prepare.mjs:392 applies, and the pinned path allows those exits (we:scripts/lib/daemon-rebuild/plan.mjs:436-440). Not covered: a pending auto-rebase swap whose ORIGINAL is now in main (the repair should be withdrawn, not adopted) and a no-PR pinned cure whose content main carries only after a squash. This card adds the tests and the one withdrawal rule.
- **Not a duplicate of #6687.** #6687 is the deterministic, model-free in-rebuild merge that only resolves hunks main provably already carries (its N1 forbids a model call). This card is the Codex-resolved, tested, audited replacement-ref path for real semantic conflicts. They are complementary: #6687 handles the trivial case in-tick; this card handles the rest out-of-tick.

## Design

1. **Kick on the pinned refusal (G1).** In we:scripts/lib/daemon-rebuild/prepare.mjs's `!plan.ok` branch (:327), when `plan.reason === 'pinned-overlay-conflict'` and `plan.detail.ref` is a registered overlay, call the same `autoRebase.kickAutoRebase({ root, env, lost: [{ ref, pr, sha }] })` used at :370, behind the same `resolveAutoRebaseSwitch` (:367-371). Record the kick result in the `pinned-overlay-conflict` alert detail exactly as `established-overlay-hold` records it. The clone stays held on last-good (the existing xpinskip hold at :334-347 is unchanged). The repair comes back as `<ref>-auto-<n>` registered with `stackBases: [ref]`. The planner already lets a registered repair stand beside its original (we:scripts/lib/daemon-rebuild/plan.mjs:426-427), and `finishPendingSwaps` retires the original once adopted.
2. **Kick for a no-PR conflicting overlay (G3).** At we:scripts/lib/daemon-rebuild/prepare.mjs:308, when `overlay-conflict-unresolved` has `pr == null`, kick auto-rebase for that ref (a PR-backed one keeps its fixer wake; that fixer owns the branch). Only refs registered on THIS clone qualify.
3. **Bounded test selection instead of a fixed refusal (G2a).** Replace the hard `selected.size > 100` refusal (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:221) with a declared knob `autoRebase.maxSelectedTests` (we:scripts/lib/daemon-rebuild-settings.json, standard 400, read through `cascadePolicy` like `enabled`). Run the selection in chunks of at most 100 files, each its own heavy-admission vitest run with its own JSON report, and require `alwaysRunInventory` to find every selected file across the chunk reports (the existing :254-256 check, applied to the union). Over the knob still refuses, now as an escalation (below).
4. **Escalate once per input pair, then stop retrying (G2b).** Any refusal at stages `resolve`, `tests` or `audit` writes a failure record keyed by `(clone, ref, oldSha, mainSha, stage)` next to the lock marker (the `paths()` dir, we:scripts/lib/daemon-rebuild/auto-rebase.mjs:19-22), using an atomic write. It publishes ONE needs-you feed entry through `publishAttention` (same call shape as we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:174), kind `overlay-refresh-needs-judge`, carrying the ref, both SHAs, the conflicted files, the stage, the reason and, for `resolve`, Codex's exit code, `timedOut` and the terminal event. `kickAutoRebase` skips a ref whose current `(oldSha, mainSha)` already has a failure record. A new main or a new overlay tip is a new pair, so the repair retries by itself; the same pair never loops. The judge (operator or a judge session reading the feed) resolves by pushing a fixed ref and loading it with prototype-load; nothing in this card auto-accepts a failed audit.
5. **Withdraw a repair whose original main now carries (auto-retire).** In `finishPendingSwaps` (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:304), before waiting for adoption: if the pending swap's ORIGINAL ref is gone from the registration because the planner retired it `in-main`/`pr-merged`, and the replacement's own merge base already sits in main, remove the replacement too (`removeOverlay(..., { why: 'original retired in-main; repair withdrawn', expectedOverlay })`) and delete the pending file. Today that branch throws "replacement unregistered before adoption" or leaves the repair registered forever.
6. **Semantic-conflict rule stays with the audit, stated in the prompt.** The resolve prompt (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:181) gains the 10-31 ruling in one sentence: when the overlay's behavior contradicts a rule main added later, main's rule wins and the overlay's own regression tests are kept (adjusted only where they assert the contradicted behavior). The audit prompt (:259) must name each place where it let main's rule win. The parent-tests-kept check (:192-196) is already the mechanical floor.

## MVP

Musts:
- G1 kick on `pinned-overlay-conflict`, with the hold unchanged.
- G3 kick on a no-PR `overlay-conflict-unresolved`.
- G2a chunked selection under the `maxSelectedTests` knob, all-files-executed inventory across chunks.
- G2b one needs-you feed entry per `(ref, oldSha, mainSha, stage)` plus the retry skip; Codex exit details in the evidence.
- Design 5 withdrawal of a repair whose original was retired in-main.
- Design 6 prompt sentences.

Out (Follow-ups): renaming `-auto-<n>` to `-m<n>`; a model judge that auto-accepts; #6687's deterministic in-tick path; health-watch bundle-repair changes.

## Test plan

In we:scripts/lib/__tests__/daemon-rebuild-hold-live-pinned.test.mjs (prepare-level, injected `autoRebase` double):
- `pinned-overlay-conflict kicks auto-rebase for the pinned ref` — RED today: the `!plan.ok` branch never calls `kickAutoRebase`. Asserts one kick, the alert carries `autoRebase`, `state.held.reason` is still `pinned-overlay-conflict`, and HEAD is unchanged.
- `pinned refusal with autoRebase off does not kick` — guards the switch.
- `no-PR overlay-conflict-unresolved kicks; PR-backed one only wakes its fixer` — RED today: no kick on either.

In we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs (injected git/codex/testRunner/auditor deps):
- `150 selected tests run in two chunks and register` — RED today: refusal at :221. Asserts two testRunner calls of at most 100 files and a registration.
- `one chunk's report missing a selected file refuses` — the inventory union check.
- `selection over maxSelectedTests escalates` — asserts one `publishAttention` with kind `overlay-refresh-needs-judge` and a failure record.
- `same (oldSha, mainSha) after a failure is skipped by kickAutoRebase; a new mainSha retries` — RED today: the marker is stolen after 30 min and the job reruns.
- `resolve failure evidence carries Codex exitCode/timedOut/terminal` — RED today: only "agent failed or incomplete".
- `audit not NOT WEAKENED escalates and never registers` — no `add` call; one feed entry.
- `pending swap whose original was retired in-main withdraws the repair` — RED today: throws "replacement unregistered…" or keeps the repair.
- `pending swap whose original is still registered and unadopted keeps waiting` — guards Design 5 from over-firing.
- `resolve prompt carries the main-rule-wins sentence; audit prompt asks for each main-wins site` — string check on the task file.

## Proof plan

- **Before:** the 10-31 evidence above (review-clone events with no `auto-rebase-*` before the hand -m2; fix-clone `test selection over 100` ×4; fix log `overlay-conflict-unresolved` on lane/forge-remote-exec-s2 with no kick).
- **After:** load the build on the fix daemon through prototype-load (green + audited, add-before-remove). On the next real pinned or no-PR conflict (or the still-conflicting lane/unfreeze-fix-top-1030a-m1 / lane/forge-remote-exec-s2 if they still conflict), show in that clone's events jsonl: `auto-rebase-registered` for `<ref>-auto-<n>`, then `auto-rebase-swapped` after adoption, with before/after HEAD from `rebuild-state`. Or show one `overlay-refresh-needs-judge` feed entry, and no second attempt on the same SHA pair across at least two ticks.
- No hand edits in daemon clones; the proof only reads their logs and state.

## Edge cases this change must handle

1. **Untrusted text** — conflict file contents and Codex output reach the task file and the feed entry: they stay inside `fenceUntrusted` (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:174). The feed reason keeps the existing control-character strip and 240-char cap (:35). Refs pass `isSafeBranchName` before any argv.
2. **Truncated reads** — a git or ls-remote failure, a missing or oversized chunk report, or a chunk timeout is a refusal (`requireOk`/inventory), never an empty selection or a pass.
3. **Shared state files** — the failure record and pending swap use the existing temp-plus-rename write (:92-100). Registration and removal stay under the overlay list mutex with `expectedOverlay` compare-and-set (:275, :348).
4. **Fail closed** — any error keeps the clone on last-good and the old ref registered. A failed `publishAttention` still leaves the alerts-file record. An unreadable failure record counts as "no record" for retry only after the 30-min marker rule, never as "accepted".
5. **Identity scoping** — the failure record key is clone + ref + oldSha + mainSha + stage. A kick only targets refs registered on this clone. Withdrawal checks `expectedOverlay` identity, not just the ref name.
6. **State over time** — a moved main or overlay tip makes a new pair and retries. A restart mid-swap resumes from the pending file (existing). A record whose ref is no longer registered is ignored and pruned on the next kick.
7. **Who wrote it** — the repair ref is pushed by the daemon identity (`REBUILD_IDENTITY_ENV`). Withdrawal and swap act only on refs whose registration reason is `auto-rebase of <ref>` (we:scripts/lib/daemon-rebuild/plan.mjs:427), never on a hand-registered -mN.

## Non-goals

- [N1] No auto-accept of a semantic conflict: a failed test or audit always ends at the judge, never at "adopt anyway".
- [N2] Not #6687's deterministic in-rebuild merge, and no change to overlay-main-sync's clean-only rule.
- [N3] No hand edits to daemon clones; live proof goes through prototype-load.

## Acceptance

- [A1] **Executable** — the Test plan cases above in we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs and we:scripts/lib/__tests__/daemon-rebuild-hold-live-pinned.test.mjs fail on main 2ee4dcbf9b and pass after.
- [A2] **Must refuse** — a failed resolve, a missing test, an over-cap selection or an audit other than `NOT WEAKENED` never registers a repair, never removes the original, and publishes exactly one needs-you per input pair. Docs, config and settings JSON conflicts get the same test-and-audit path as code: no file kind is exempt.
- [A3] **Add before remove** — the original is removed only after the clone's adopted HEAD contains the repair (unchanged rule, covered by the existing tests that must stay green).
- [A4] **Live proof** — the Proof plan's after-evidence on a daemon clone.

## Follow-ups

- Rename `-auto-<n>` to the hand convention `-m<n>` (or teach tooling both) so operators read one naming.
- A Codex judge that reads `overlay-refresh-needs-judge` entries and proposes a resolution for the operator to accept.
- Health-watch bundle-repair: route its `unresolvable-conflict` stop into this same kick.
- Prune stale `.auto-rebase/*.lock` files (some date from 10-25) in the lease reaper.
