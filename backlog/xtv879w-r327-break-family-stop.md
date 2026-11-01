---
kind: decision
size: 3
status: active
scaffoldedBy: "r327-cards-ab-lane-26-fb353f00"
dateScaffolded: "2026-11-01"
dateOpened: "2026-11-01"
preparedDate: "2026-11-01"
preparedAgainstSha: "efcde8598ff71c020c47fa7eba2ae2471d35dd6f"
tags: []
---

# Stop granting fix rounds after 3 new red-team break families on a PR and route it back to /prepare

The review daemon counts NEW red-team break families per PR lineage. At 3 it stops granting fix rounds and routes the PR back to `/prepare` with a "needs-design" hold. Motivated by #6033, which was never prepared and drew a new break family every round for 7+ rounds (inventory: [#7582](/backlog/7582-decide-the-fate-of-6033-overlay-generation-s1-keep-and-card/), 12 classes). Operator ruling R327 (2026-11-01): "Do as suggested". This card is policy only. Mechanics, files, settings and rollout live in the build child `xccdjyl`.

Terms. A **severity class** (`broken`/`degraded`/`unconfirmed`) says how bad a finding is. A **break family** says what kind of defect it is. This card adds the second and leaves the first alone.

## Acceptance

- [A1] **Executable** (after the child lands) — a replay test over the frozen #5964/#6033 red-team history shows the stop firing no later than round 5 of the lineage's own history (the lineage ran 8 or more rounds), and a control history of converging rounds shows no stop. Test path is the child's.
- [A2] **Observable** — a live dry-run of the review daemon on #6033's real comments reports the stop with the family count and round; the same dry-run before the change reports none. Before/after pair in the child PR.

## Non-goals

- [N1] Not a review of #6033 and not its fate (that is #7582). This sets the exit rule that would have ended its loop early.
- [N2] No change to severity classes.
- [N3] No bypass, waiver or operator override of the stop. Only Fork 3's clear condition lifts it.

## Edge cases this change must handle

1. **Untrusted text** — red-team comment bodies are model output over PR content. Only structured fields of the existing trusted parse are read; comment text is never executed or interpolated. See the threat model.
2. **Truncated reads** — an unreadable or truncated comment list, or a comment format the parser no longer reads, makes the count "unknown", and unknown fails toward the hold (visible), never toward more rounds.
3. **Shared state files** — n/a: the count is derived from PR comments each tick; nothing new is stored.
4. **Fail closed** — a finding the parser cannot place counts as a new family.
5. **Identity scoping** — the count belongs to the PR lineage, not the head sha, so a rebase or force-push does not reset it (Fork 2).
6. **State over time** — within a window the count only grows. Only Fork 3 opens a new window.
7. **Who wrote it** — applies to agent and operator PRs alike; only comments from trusted authors count.

## Digest and verdict

**Verdict: go.** #6033 grew from a design note planned at about 250 lines to 8,424 added lines, with no stated invariant set and no threat model. Each round the red team found the next lookup that did not use the registration id. The existing per-PR round cap counts rounds, and operator grants kept extending it. Counting NEW families measures non-convergence directly: three different kinds of break in one PR is a design problem, and more fix rounds cannot cure a design problem.

Prior art: the existing cap and severity routing handle "how bad" and "how many rounds". The delta is a second, orthogonal counter. R327 fixes the threshold at 3 and the destination (`/prepare`, "needs-design" hold); retuning later needs no new card.

## Trust boundary and threat model

**Adversarial.** Red-team comment text (model output over PR content that may carry attacker-shaped strings) and PR-body links to a design card.
**Trusted.** Only the structured fields of a finding from trusted authors, and the linked card file on main. Nothing is executed or used to build a path or command.
**Failure sources.** (T1) Wording or file variation that splits one family into many, forcing a premature stop; this is also a denial-of-service on honest PRs. (T2) Wording that merges distinct families so the stop never fires. (T3) A forged "design card linked" claim in a PR body. (T4) An edited or stale comment changing the count later. (T5) A red team that downgrades findings to unconfirmed or unverifiable to dodge counting. (T6) A PR author who reshapes files so findings land in one place and lump into one family.
**Controls.** T1 and T2: the kind of defect is normalized so wording variation cannot split or merge it, and the key is deliberately coarse (Fork 1), leaning toward firing, because a stop is a visible `/prepare` ticket and a missed stop is today's status quo. T3: the clear condition reads the linked card from main and requires it to cover the PR's files (Fork 3). T4: only trusted comments count. T6: accepted limit. Dodging the count means restructuring a PR to avoid a hold meant to help its author, and the operator sees the hold and its inputs. T5: unconfirmed or unverifiable findings do not count, but a PR with repeated ones is reported as an advisory to the operator. Out of scope: a hostile repo admin who edits comments.
**Design red-team:** see the Skeptic lines and the recorded red-team run.

## Fork 1 — what makes a break family "new"

*Fork-existence:* the stop is a gate decision, and a gate must replay to the same answer from the same comments. A key that two re-reads can resolve differently (option c), or one the red team writes about itself (option b), is excluded as the gate's key.

| Option | Description | Verdict |
|---|---|---|
| **(a) default** | Mechanical key from the kind of defect (normalized) and the file it lives in. A finding with no file keys on kind alone. A key already seen earlier in the lineage is not new. Coarse on purpose: several #6033 classes (C3 and C6) share one file and collapse to one family, which matches their shared root cause (a lookup not bound to the registration id). | Deterministic, replayable. Can under-count two defects in one file and over-count one cause across files. |
| (b) | The red team self-reports a root-cause label. | Excluded on merit: a self-reported label is gameable by the red team and not replayable from the comments. |
| (c) | An LLM judge clusters findings into families. | Excluded: non-deterministic for a gate. May be added later as an advisory label only. |

**Default: (a).**
Skeptic: SURVIVES-WITH-AMENDMENT - the deterministic key beat the self-reported-label and LLM-judge attacks; amended to name author file-packing (T6) as an accepted limit and to state key sensitivity as a replay output.
Screen: clear - gate key is a merit call (replayable vs gameable), no WE<->FUI boundary involved.

## Fork 2 — what the count belongs to

*Fork-existence:* a count that belongs to the bare PR number resets when work is split or resubmitted, which is how #5964 became #6033. So per-PR-number only is the excluded branch.

| Option | Description | Verdict |
|---|---|---|
| (a) | Per PR number only. | Excluded: a split or re-open resets the evidence. |
| **(b) default** | Per lineage, detected mechanically and also by a declared link (split from, supersedes, shared parent card). Successors inherit the families already counted. | Closes the reset loophole without trusting the author to declare it. A false overlap could merge two unrelated PRs, which the visible hold makes cheap to undo. |
| (c) | Per linked card only. | Excluded: PRs with no card (the #6033 shape) would never be counted; the sibling card on prepared-card gating closes that gap separately. |

**Default: (b).** The replay does not prove this fork. The lineage rule is justified by the split mechanism (#5964 became #6033), not by the replay.
Skeptic: SURVIVES-WITH-AMENDMENT - the lineage rule beat the per-number and per-card attacks; amended so lineage is detected mechanically and also by declared link, not by author declaration alone.
Screen: clear - a split resetting the evidence is a merit difference visible in outcomes.

## Fork 3 — what clears the hold

*Fork-existence:* if an operator round grant could lift the stop, the stop would collapse into the existing cap and #6033 would repeat, because it ran on grants. Grants lifting the stop is the excluded branch.

| Option | Description | Verdict |
|---|---|---|
| (a) | An operator round grant clears it. | Excluded: the status quo. |
| **(b) default** | A design card linked to the PR, whose scope covers the PR's changed files and meets the same width limit as the sibling prepared-card card (`x9syioh`, Fork 2), prepared through the normal `/prepare` flow (so its skeptic and screen are separate agents, not the PR author's builder), and stamped after the stop, opens a new window and resets the count. A second stop in the same lineage stays held until another such card exists. There is no override. | Forces the missing design step, keeps independent validation, and blocks a thin card from buying unlimited windows. Slower for a PR whose families share one cause; acceptable, the hold is a ticket not a rejection. |
| (c) | Auto-clear after N days. | Excluded: turns a design stop into a timer. |

**Default: (b).**
Skeptic: SURVIVES-WITH-AMENDMENT - grants-cannot-clear held; amended with a width limit on the card scope, independent preparation (`#agent-convergence-independent-validation`), and no override on a second stop.
Screen: clear - grants vs a scoped, independently prepared design step is a merit difference.

## Supported by default (not forks)

- Threshold 3 and the `/prepare` destination: ruled by R327.
- Only confirmed `broken` and `degraded` findings count. Unconfirmed and unverifiable ones never do (they are reported as an advisory when repeated).
- **Statute composition.** The stop is a route to `/prepare`, not a hard block with no reviewer, so it complies with `#blast-radius-advisory-care-not-a-gate` ("gate means route to a human"), and it counts observed breaks, not a computed risk score. Clearing it requires an independent validator, per `#agent-convergence-independent-validation`. Unverifiable findings stay counted apart from blockers, per `#creator-owed-proof-not-reviewer-rederivation`.
- Hold wording ("needs-design") reuses the existing hold routing.

## Pre-mortem

1. **Premature stops** on a healthy PR with many small distinct bugs in separate files. Guard: only confirmed findings count, a control history must not stop, and the hold is a `/prepare` ticket.
2. **Never fires** because the red team lumps everything under one category and file. Guard: the replay must show the stop, and failing it fails the build's own acceptance.
3. **Hold deadlock**: nobody runs `/prepare`. Guard: the hold must show up where `/prepare` looks; checked in the live dry-run.
4. **Missing lineage link** so a split resets the count. Residual risk, named. Detection of an undeclared overlap is the child's job.
5. **Format drift** silently zeroes the count. Guard: edge case 2, unreadable counts as unknown and holds.
6. **Thin design card** buys another window. Guard: Fork 3 requires scope coverage and independent preparation, and a second stop stays held until another qualifying card exists.

## Test and proof plan

- **Replay on #6033's real history.** Reconstruct the frozen history from the red-team advisory comments of #5964 (its own rounds 1 to 4) and #6033 (its own rounds), using each PR's own round labels, not stitched numbering. Only classes that came from red-team advisories can be replayed. C1 to C9 are advisory-sourced. C10 to C12 came from an operator-ruled block, referrals and a review, so they are excluded from the replay and listed as such. Expected from #7582's inventory, and therefore a hypothesis the replay tests: the stop fires at round 3 of the lineage if its early classes differ in kind, and no later than round 5 if they collapse, which still saves 3 of 8 rounds. Round labels and the fixture's per-class expectations are the child's. If the real comments give a different answer, the child reports it and does not tune the key to fit.
- **Control.** A recorded PR whose rounds converge (no new family after round 2) must not stop.
- **Before/after on the live case.** The daemon's dry-run on the real #6033 comments, per A2.
- Rollout order, setting names, and the audit gate are the child's.

## Build child

`xccdjyl` holds the mechanics.
