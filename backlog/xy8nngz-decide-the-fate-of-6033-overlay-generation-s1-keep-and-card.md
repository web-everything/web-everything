---
kind: decision
size: 3
status: open
scope: ["we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-overlay-auto-retire.mjs"]
dateOpened: "2026-11-01"
preparedDate: "2026-11-01"
preparedAgainstSha: "7a8f51570435bc14cb2e13114cb1c7484119daf4"
tags: []
---

# Decide the fate of #6033 (overlay generation S1): keep and card the residual, rebuild, or narrow scope

PR #6033 (S1 of the #5964 split) is at review round 7/8 and keeps drawing a new red-team break class each round. This card holds the break-class inventory, the threat model the design lacked, the forks, and a pick. Stacked PRs #6044 and #6046 are held on it. Raised by R325/R326.

## Acceptance

- [A1] **Executable** (after the ratified path lands) — `npx vitest run we:scripts/lib/__tests__/daemon-overlays-generation.test.mjs` passes with two NEW tests that fail on head d12af703: T12 "re-registration never inherits a historical pin, and a same-id pin survives a restart" (class C6) and T13 "duplicate-ref registry keeps both ids in the snapshot" (class C12).

## Non-goals

- [N1] This card does not review or approve #6033's code, change any review label, or push to its branch. It sets the disposition and the exit rule; the fix itself is a child item.
- [N2] A hostile same-user writer is out of scope (see the threat model). So is the soundness of the closure-scope feature (classes C8, C9), which gets its own card.

## Edge cases this change must handle

1. **Untrusted text** — n/a for the decision. The closure-scope classes (C8, C9) execute branch content and are carded separately.
2. **Truncated reads** — the inventory below is built from PR comments read in full per advisory; per-head fix status is marked "not re-reproduced" where only absence of a re-raise supports it.
3. **Shared state files** — the overlay list and `state.adopted` are shared; I1 to I6 below govern every writer.
4. **Fail closed** — I5: ambiguity keeps the registration and skips the tick; refusals must be loud and self-clearing.
5. **Identity scoping** — the whole card: evidence is bound by registration id, never by ref, PR number or time.
6. **State over time** — class C7 and I5 (a refusal must clear when fetched main provably carries the pin).
7. **Who wrote it** — n/a: all writers are the same local user.

## Digest and verdict

#6033 is not converging because it was never designed against a stated invariant set, and its scope grew far past the plan. The design note planned S1 at about 250 lines: generation token, migration, snapshot, CAS. The PR is 8,424 added lines in 83 files, and it also carries S2 (auto-retire), S4 (retired-source archives) and a closure-scope feature (import-closure, LaunchAgent discovery) that the design never mentioned. Each red-team round attacks a different part of that surface, which is why a "new class" appears every round. Of 12 classes found across #5964 and #6033, 9 are fixed or fail-closed, 3 are open at d12af703: **C6** (a historical pin is rebound to a replacement registration), **C7** (deleted branch freezes rebuilding in shadow mode), **C12** (duplicate-ref registry collapses in the snapshot map, no test). C6 and C12 break S1's own invariant, so they cannot be carded away. C7 fails safe in shadow mode (the only mode I traced), so it can.

## Break-class inventory

Sources: red-team advisories on #5964 (4 heads) and #6033 (4 heads), the operator-ruled referral on we:scripts/lib/daemon-rebuild/adopt.mjs:177, and the mandatory-referral lists. "Fixed" means the code at d12af703 visibly handles it; "not re-raised" means a later head's red team did not repeat it (this is weaker, I did not re-run the probes).

| ID | Class | Round | Mechanism | Status at d12af703 | Where |
|---|---|---|---|---|---|
| C1 | Stale tip evidence survives re-registration | #5964 r1, r2; #6033 r6 (recurred) | `addOverlay` minted a new id but kept `sha`/`headSha`; with a missing remote branch, classify trusts it and retires the new registration as ancestor-of-main | Fixed. All tip fields cleared on re-registration (operator ruled "keep 553443c9") | we:scripts/lib/daemon-overlays.mjs:297,333 |
| C2 | Carrier recovery restores an obsolete registration | #5964 r3 | Retire X/PR1 into C1, re-register X/PR2, retire into C2; recovery restores PR1 and skips PR2 | S4 scope (parked in the design). Code and tests ride in #6033; not re-raised | we:scripts/lib/daemon-overlays.mjs (recovery), retired-sources test |
| C3 | Pin inherited by a reused ref | #5964 r3 | Mechanism pin looked up by ref only, so the next registration of that ref inherits it | Fixed. Rows bound by `registrationId` via `appliedRowFor` | we:scripts/lib/daemon-rebuild/prepare.mjs:385-390 |
| C4 | Timestamp used as identity | #5964 r4 | `capturedAt` stamped after planning; a mid-plan re-registration looked older than the stamp and matched the old pin | Fixed. Ids plus `snapshotHolds()` at each boundary; heuristic deleted | we:scripts/lib/daemon-rebuild/prepare.mjs:244-272 |
| C5 | Recovered ready candidate skips archive protection | #6033 r7 | Saved plain-main fallback accepted without `archiveUncovered` check after auto-retire was switched on | Fixed per code (check on the ready path); not re-raised at d12af703 | we:scripts/lib/daemon-rebuild/prepare.mjs:457,723 |
| C6 | **Historical pin rebound to a replacement registration** | #6033 r8 | Pin for X (SHA B) is found by ref/PR-keyed merge history; the plan row carries no id, so the fallback stamp `row.registrationId ?? snap.get(row.ref) ?? ourRestored.get(row.ref)` gives it the new id Y | **OPEN** (red team confirmed at d12af703) | we:scripts/lib/daemon-rebuild/prepare.mjs:500 (stamp), also ref-keyed `snap.get` at :386 and :610 |
| C7 | **Deleted branch freezes rebuilding** | #6033 r8 | Availability check compares the pin to `adopted.mainSha`, not to fetched main; in shadow mode the registration stays, so `pinned-overlay-unavailable` never clears | **OPEN**, fails safe (refuses), but permanent | we:scripts/lib/daemon-rebuild/prepare.mjs:385 |
| C8 | LaunchAgent preload args missed by discovery | #6033 r5 | a `--import=<preload module>` option is not an absolute-path arg, so closure scoping drops a module Node will run | Fixed by refusing `--import/--require/--loader` forms. Not in the design | we:scripts/lib/daemon-clone-entries.mjs:60-64 |
| C9 | `Function` constructor bypasses opaque-loader guard | #6033 r5 | a dynamic import built through an async-function constructor marked closure complete | Fixed (`Function` in the opaque set, `new Function` checked). Not in the design | we:scripts/lib/import-closure.mjs:30-36 |
| C10 | CAS silently unconditional without a token | #6033 (operator-ruled block) | `expectRegistrationId: undefined` skipped the compare | Fixed. Suspect without id is kept and alerted; `removeOverlay` treats a present-but-bad key as a refusal | we:scripts/lib/daemon-rebuild/adopt.mjs:177-184, we:scripts/lib/daemon-overlays.mjs:436 |
| C11 | Migration crash window and weak proof | #6033 referrals (we:scripts/lib/daemon-rebuild/smoke.mjs:791, overlays:237/243, prepare:242) | Ids persisted before adopted-row ids (crash loses a pin); a missing adopted-row PR treated as a match; fallback replans dropped ids | Addressed in code per later heads; not re-reproduced. Migration is now one step plus a consistency check | we:scripts/lib/daemon-overlays.mjs:211-250, we:scripts/lib/daemon-rebuild/prepare.mjs:244-253 |
| C12 | **Duplicate-ref registry collapses in the snapshot** | #6033 review (degraded finding, no test) | `new Map(overlaysBefore.map(o => [o?.ref, o?.registrationId]))` keeps only the last id for a duplicated ref (and a null entry becomes an `undefined` key), so the "one snapshot" no longer represents the list and `snapshotHolds()` compares against one of them | **OPEN**, no test (T5 covers migration of duplicates, not the snapshot) | we:scripts/lib/daemon-rebuild/prepare.mjs:258 |

Count: 12 classes. Fixed or fail-closed: 9 (C1, C3, C4, C5, C8, C9, C10, C11, plus C2 as claimed). Open: 3 (C6, C7, C12). By slice from the design note: core S1 (identity, snapshot, CAS: C3, C4, C6, C10, C11, C12) is 6; S2/S3 evidence and retirement (C1, C5, C7) is 3; S4 archives (C2) is 1; closure-scope, absent from the design (C8, C9) is 2.

Reading the table: the three open classes plus C1 and C5 all come from one root, a lookup that finds evidence by something other than the registration id (a ref, a PR number, a main sha, a timestamp). Every round fixed one lookup and the red team found the next. That is a design signal: the rule "no lookup of evidence except by id taken from the same snapshot" was never stated.

## Threat model

**Assets.** (1) The overlay list: entries `{ref, pr, registrationId, tip fields, retiredSources}` plus the list `generation`. (2) `state.adopted`: `applied` rows, `mainSha`, `head`. (3) Evidence: tip shas, mechanism pins, archives. (4) The running daemon build and the plain-main fallback. (5) The operator's registered fixes (losing one silently reverts a live fix).

**Failure sources** (all accidental; the writers are the same local user behind `withListLock`, whose lock is stale-broken after 30 s):
- F1 A second session calls `addOverlay` or `removeOverlay` at any await point inside `prepareRebuild`.
- F2 A stalled lock holder is overtaken and writes late.
- F3 Reused ref names and PR numbers; force-pushed or deleted branches; rewritten history.
- F4 Legacy data: no ids, duplicate refs, missing `pr`.
- F5 A crash between two writes.
- F6 A degraded registry (duplicates, corrupt file).
- F7 Clock reads and timestamp ties.
- F8 (separate trust boundary) branch content that the closure scope reads or that Node executes at boot. This is not an identity problem and is not in S1.

**Out of scope by design:** a hostile local user who edits the list file directly.

**Invariants.**
- I1 Identity: `(ref, registrationId)` is unique in the list. Duplicate refs are "unprovable", never silently merged.
- I2 Evidence ownership: each piece of evidence belongs to one registration id. It is bound only from the id in the tick's snapshot at the moment of writing. No lookup by ref, PR number, sha or time may attach history to a different id.
- I3 One snapshot: each tick decides on one snapshot that represents the whole list (duplicates included); every await or git boundary re-verifies it; a mismatch skips the tick.
- I4 CAS: every mutation presents the id; an absent or malformed token refuses.
- I5 Fail direction: ambiguity keeps the registration and refuses, loudly. A refusal must be self-clearing, meaning it ends when fetched main provably carries the pinned content.
- I6 Migration is idempotent and crash-safe: a crash between any two writes leaves state that the next tick can finish or safely refuse.

## Fork 1 — what to do with #6033

*Fork-existence:* one branch must be correct for the S1 invariants and the alternatives are broken or excluded: #6033 cannot both ship as is (C6 and C12 break I2 and I3) and also be called converged, and rebuilding and keeping cannot both be the S1 vehicle. Scope narrowing is the only option that changes what S1 promises.

- **(a) Keep #6033 as is, card the residual (C6, C7, C12) and approve.** Fastest to unblock #6044 and #6046. Tradeoff (merit): C6 and C12 violate the headline invariant of S1, so the PR would ship a known break of its own contract. Rejected as the default for that reason. Shadow mode limits the damage of retirement classes but not of C6, which mis-binds a pin even in shadow mode, so this option is rejected, not left as a conditional.
- **(b) Rebuild S1 against the invariants above (about 250 lines, tests T1 to T9 as property tests).** Cleanest design. Tradeoff: it throws away 8.4k lines of reviewed work, restarts the 8-round clock, forces #6044 and #6046 to rebase, and S2/S4/closure work would have to be re-split anyway. The new code would face the same red team, which still finds classes at about one per round. Rejected as the default: the cost is high and the existing code already satisfies I1, I3 (mostly), I4 and I6.
- **(c) Narrow S1's promise: declare C2, C5 (S4), C1/C7 (S2/S3), and C8/C9 (closure scope) out of S1 by design, keep the PR, and fix only the two in-scope breaks (C6, C12) in one final round.** The scope statement is what changes: S1 guarantees I1 to I4 and I6 for registration identity; it does not guarantee archive recovery, deleted-branch liveness, or closure-scope soundness. Those become cards (below) that gate the slices that depend on them. Tradeoff: the code for the out-of-scope pieces stays in the PR (reviewers still see it), and those pieces ship with "not guaranteed" labels.

**Recommended: (c).** The open classes split cleanly: C6 and C12 are in the S1 contract and are contained to we:scripts/lib/daemon-rebuild/prepare.mjs and its tests (stop stamping ref/PR-history rows with the current id, at the three `snap.get(ref)` sites :386, :500, :610; make the snapshot hold every id). C6 is more than one line, so size the child at 3; C7 fails safe and belongs to the pin-availability work; everything else already holds or is outside identity. Done this way, #6044 and #6046 unblock after one round, not a restart.

Code shape of the C6 fix (illustrative):

```js
// before (we:scripts/lib/daemon-rebuild/prepare.mjs:500): an id-less historical row inherits whatever id the ref has NOW
registrationId: row.registrationId ?? snap.get(row.ref) ?? ourRestored.get(row.ref),
// after: an id-less row is another registration's evidence; leave it unbound, so it can hold but never bind
registrationId: row.registrationId ?? null,
```

Skeptic: SURVIVES-WITH-AMENDMENT - kept (c); folded in: C6 touches three `snap.get(ref)` sites so the fix is sized 3 not 1; C7 `blockedBy` of S2 with the I5 loud-refusal text; "fails safe" is only verified for shadow mode (non-shadow modes not traced, stated below).
Screen: clear (process/scope decision, merit differs: soundness against S1 invariants versus cost and restart; (c) changes what S1 promises, so it is not prioritization). The prose conditional in option (a) is settled: (a) is rejected because C6 breaks the pin binding even in shadow mode.

## Fork 2 — the exit rule for the final round

*Fork-existence:* the current rule ("repeat red team until it finds nothing") has been shown not to terminate: 8 advisories over two PRs, never empty. A bounded loop needs one stated stop condition; "unbounded" and "bounded" cannot both hold.

- **(a) Invariant tests as the gate; red team runs once more; any NEW class it finds is carded, not fixed in this PR.** The gate is a property test that injects `addOverlay(ref)` at every await and read point of `prepareRebuild` (design test T1) plus T12 and T13; T12 and T13 are written and frozen before the fix, and the fixer may not edit them (`#agent-convergence-independent-validation`). The last red team gets the diff, the tests and the invariant list only. If the tests pass and the red team finds no I2/I3 break, the PR merges. A new I2/I3 break blocks this merge. Any other new class (liveness, closure, archive) becomes a card.
- **(b) Keep the existing loop, raise the cap.** Status quo with a bigger number. Rejected: it has never converged and each round costs about a day.
- **(c) Drop the red-team gate for this PR.** Rejected: C6 and C12 are real; the red team is the only thing that found them.

**Recommended: (a).** It ties acceptance to the invariants rather than to the count of findings, which is the structural gap. This is the same product fix as the R327 cards (count new break classes per PR and route to /prepare at 3; require a prepared card before elevated builds).

Skeptic: SURVIVES-WITH-AMENDMENT - folded in: the rule would collide with `#agent-convergence-independent-validation` (we:docs/agent/platform-decisions.md:3054) if the fixer wrote its own gate, so T12/T13 are authored and frozen BEFORE the fix, the fixer cannot edit them, and the last red team gets only the diff, tests and rubric; and a new I2/I3 class found in the last round blocks THIS merge (not only the next slice).
Screen: clear (process decision framed correctly; only (a) ties acceptance to the invariants, (b) is shown non-terminating, (c) drops the only check that found C6 and C12).

## Does #6033 at d12af703 hold the invariants?

For the classes it claims, **mostly, but not fully**.
- I1 (unique identity): holds for migration; **does not hold for the snapshot** (C12, the map collapses duplicates).
- I2 (evidence ownership): holds for tip fields (C1) and the adopted-row binding (C3, C4); **broken for historical pins (C6)**, red team confirmed with a probe at this head.
- I3 (one snapshot): holds at the boundaries I read (`snapshotHolds()` before each pinned-status call), except where C12 weakens what the snapshot represents.
- I4 (CAS): holds (C10 fixed and verified in we:scripts/lib/daemon-rebuild/adopt.mjs and `removeOverlay`).
- I5 (self-clearing refusal): **broken for C7** in shadow mode.
- I6 (migration): addressed per code; not re-reproduced by me.
Still broken: C6, C7, C12. I did not run the PR's tests or reproduce the probes; "fixed" for the rest rests on reading the cited lines and on later heads not re-raising them.

## Pre-mortem

Two weeks later, choice (c) failed. Most likely reasons:
1. The last red-team round finds yet another class, and the pressure to fix it in-PR returns. Mitigation: Fork 2 (a) makes "carded, not fixed" the rule; the exit gate is the invariant tests.
2. The C6 fix (stop rebinding via history) drops a legitimate case: same-registration pin continuity after a restart. Mitigation: T12 also asserts a same-id pin survives; bound rows are kept.
3. C7 bites in production (or in a non-shadow mode I did not trace): a deleted, merged mechanism branch freezes rebuilds in shadow mode and the operator has to remove the registration by hand. Mitigation: card it ahead of S2 and make the refusal alert name the manual step.
4. The out-of-scope cards (closure scope, archives) are never picked up, and S2 later trusts closure scope that was never made sound. Mitigation: file them as `blockedBy` of S2/S4, so they cannot be skipped.
5. #6044 and #6046 conflict on rebase after the final round. Mitigation: they stay stacked on the same branch; the final round only touches we:scripts/lib/daemon-rebuild/prepare.mjs and tests.

## Children to file once ratified

- C6 + C12 fix with T12 and T13 (in-scope for #6033; size 2).
- C7: pin availability vs fetched main in shadow mode (blocks S2).
- Closure-scope soundness (C8, C9 and the opaque-loader family), own owner (blocks any slice that trusts closure scope).
- S4 archives (C2) stays parked; link this inventory.
- R327 cards A and B are the process fix; this card is their live case.

## Related

PR #6033, #5964, #6044, #6046; design note design-5964-split (handoff); rulings R325, R326, R327.
