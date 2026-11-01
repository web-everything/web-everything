---
bornAs: xjba691
kind: decision
size: 8
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/forge-gate-options.mjs"]
dateOpened: "2026-11-01"
tags: []
---


# Elastic Forge slots (policy only): grow a job to N slots when Forge is idle

R331 (2026-11-01 11:22 ET) "Ok idle first": v1 is idle-time growth only. R350 (2026-11-01 17:29 ET) "1. Split": this card keeps ONLY the policy; all mechanics are in the build story xzzsdv9. R324 (09:44 ET): allow a single job to use multiple slots before adding smaller slots.

## The axis

- Forge has 32 CPUs and 62G RAM; each of 8 slots is capped at 800% CPU and 12G, under a parent cap of 2800% CPU and 56G. 8 slots already exceed the parent, so slots are a fairness lane and the parent is the real cap.
- Known occurrences: Kubernetes burstable QoS, GitHub Actions larger runners, Bazel `--local_cpu_resources`, make `-jN` job tokens (borrow only while others idle).

No real fork survives. The call to ratify is the five rulings below plus the statute amendments.

## Rulings to ratify (none is a fork)

- **Idle-only growth.** A job may take more than 1 slot only when Forge is idle, meaning at least `idleFreeSlots` (4 of the 8) slots are free and the Forge runner confirms parent CPU and memory headroom for the request (the Mac cannot see Forge load). Priority claiming is off and deferred to a later slice; no caller-spellable signal raises a grant.
- **At most 3 slots per job** (`maxSlots` = 3, from the parent CPU and memory ceilings).
- **Off until proven.** `remote.elastic.enabled` is `false` until a live before/after proof is attached; then the operator sets it true (a platform-preferences change) citing that proof.
- **Fail closed to 1 slot.** Any doubt grants exactly 1 slot, today's behaviour. An optimisation failure never denies a run.
- **Ordering.** Elastic lands first; shrinking to about 16 smaller slots is a later card that depends on this one.

Mechanics (grant function, polling, starvation bound, timeout, grant contract, runner slice and clamp, lease and marker reaping, settings and env layers, proof steps) are NOT decided here: see build story xzzsdv9.

## Acceptance

- [A1] **Executable** - the ratified policy is recorded and the amended statute text lands in we:docs/agent/platform-decisions.md; the build story xzzsdv9 is unblocked.
- [A2] **Must refuse** - this card changes no code; elastic stays disabled until the build story's live proof.

## Where this card amends the statute (for ratification)


Statute `#heavy-command-admission-queue` in we:docs/agent/platform-decisions.md (line ~4671), amended by v1 (idle growth only). Replacement wording:
0. Scope (add a sentence after the four clauses): "Elastic slots apply to the `remote.*` (Forge) path only; the local pool is unchanged."
1. Clause 1: replace "v1 ships as a plain named SET, not weighted" with "v1 ships as a plain named SET; every heavy command weighs one token, except that on an idle Forge a job may weigh up to `maxSlots` tokens."
2. Clause 2: replace "queues on a capacity semaphore" with "queues on a counting semaphore (one token per slot; a job acquires N tokens at once)".
3. Clause 4: after "env/config-overridable per machine" add "for the local pool; the Forge (`remote.*`) leaves, including `maxConcurrent` and `remote.elastic.*`, are standard-then-platform-preferences only, as they already are", and "the cap counts one job as up to `maxSlots` tokens".
4. Re-entrance paragraph: after "gives its child `WE_HEAVY_ADMISSION_HELD=1`" add "carrying the granted slot count N", so a nested wrapper neither re-acquires nor double-counts.
5. Reaper sentence: add "a multi-slot `waiting` marker is one owner holding N tokens; reaping it releases all N".
Unchanged: clause 3 (waiting-for-capacity tick). Consistent with, not amended: "a running holder is never preempted" (code comment at we:scripts/readiness/heavy-admission.mjs:135).

## Non-goals

- [N1] Not adding smaller slots; not priority claiming; no pre-emption or mid-run growth.
- [N2] Decision-only: no runner or admission code here.

## Edge cases this change must handle

1. **Untrusted text** - n/a: policy only; the build story handles it.
2. **Truncated reads** - n/a: policy only; fail closed to 1 slot covers it.
3. **Shared state files** - n/a: policy only; see xzzsdv9.
4. **Fail closed** - any doubt grants exactly 1 slot.
5. **Identity scoping** - n/a: policy only; see xzzsdv9.
6. **State over time** - n/a: policy only; see xzzsdv9.
7. **Who wrote it** - n/a: policy only; admission decides, never the requester.

## Ratified — 2026-11-01 (R354)

Operator chalbert, 2026-11-01 17:34 ET: "\"Ratify as is\" for xjba691."

Statute amendments 0–5 to `#heavy-command-admission-queue` are ratified as written. The statute text change itself lands with the build (xzzsdv9).

## Known gaps (close in build xzzsdv9)

Six second-screen flags, recorded at ratification and carried into the build story as acceptance items:

1. Values: `maxSlots` 3; idle = at least 4 of 8 slots free.
2. Anchor amendment 0.
3. Anchor amendment 3's second insertion.
4. Amendment 3's unverifiable "as they already are".
5. Amend the re-entrance "one slot, not two" note.
6. Waiting-marker token semantics, to be decided in the build.
