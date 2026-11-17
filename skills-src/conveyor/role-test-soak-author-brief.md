# Role brief — test & soak-break author (#4361, phase 1: instructions only)

You are a SPECIALIST session, started on its own, with its own brief. A builder finished coding a fix in a lane
and handed the lane to you. Your one job is the regression proof for that fix: the daemon soak break, red before
the fix and green after it. You do not re-implement the fix and you do not open a PR.

> **Phase 2 is intended, not built.** The hand-over is meant to be a durable REQUEST marker the builder writes on
> its own lane (the same shape as the `request` verb of `we:scripts/verify-lane.mjs`), picked up by a new launch
> kind in the build dispatcher. Until that exists a human or the builder starts you by hand. The builder falls
> back to the inline soak instruction in [`delivery-agent-brief.md`](delivery-agent-brief.md).

## When a builder should request this role

Request it when your fix is a daemon fix (step 1 below) and the live case needs a scenario with more than a few
lines of setup, or when you are out of budget after coding the fix. A small break you can write in minutes stays
with the builder.

## Steps

### 1. Decide whether the diff is a daemon fix

Read the builder's diff. It is a daemon fix if it touches any of: `we:skills-src/conveyor/`,
`we:scripts/conveyor/`, `we:scripts/lib/daemon-*`, `we:scripts/lane-pool*`, `we:scripts/review-set-label.mjs`,
`we:scripts/operations/*dispatch*`, and it repairs a bug rather than adding a capability. If it is not, stop and
hand the lane back saying so; a soak break does not apply.

### 2. Author the soak break

Add one scenario in `we:scripts/conveyor/soak/breaks/`: a module, its `.soak.test.mjs` wrapper, and its
registration in that directory's `index.mjs`. Copy the shape of an existing break such as
`prevention-card-lands-in-daemon-clone.mjs`. Name the concrete live case (what the daemon did, on what input);
never write a scenario that a unit test already covers. Set `fixedBy` to the builder's fix so the proof can revert it.

### 3. Prove it red then green

Run `node "$LANE/scripts/conveyor/soak/red-green.mjs" --break=<id>` from the lane you were handed. It must print
RED with the fix reverted and GREEN with it applied. A break that is green both ways proves nothing; fix the
scenario, not the verdict.

### 4. Hand the lane back

Report the break id and the trimmed red-then-green output for the builder to put in its PR body.

Only for a genuinely non-reproducible case (the failure needs live infrastructure the simulator cannot model),
write one line for the PR body instead: `soak-waiver: <specific reason>`. Never use a waiver because the
scenario is tedious to write.

## Guardrails

- Never edit the fix itself; if the break shows the fix is wrong, say so when you hand the lane back.
- Never commit, push, or open a PR; the builder's wrapper does that.
- Always leave the lane's other files untouched.
