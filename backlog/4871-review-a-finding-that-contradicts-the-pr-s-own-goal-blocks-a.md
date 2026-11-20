---
bornAs: xobzl5d
kind: story
size: 3
status: open

dateOpened: "2026-10-01"
tags: []
---

# Review: a finding that contradicts the PR's own goal blocks, and non-blocking findings on an accepted PR become cards

Live 2026-10-01, PR #3215 (builder round cadence): all five review seats accepted, yet the findings included that the new networked PR-count fallback (we:scripts/readiness/dispatch-plan.mjs:1054) can add GitHub calls every round, which contradicts the PR's own goal of shorter rounds; it was rated a test-coverage gap, so the panel verdict was "accept" and it reached the operator as ready. The operator sent it back. Two gaps: (1) a finding whose consequence defeats the change's declared purpose (from the card's goal / PR description) must be classed blocking, not advisory; (2) every non-blocking finding on an accepted PR must either be fixed in the advisory-fix round or auto-filed as a follow-up card with its file:line, so "accept + findings" never silently drops them. Change the finding classification and the reduce step in we:scripts/lib/review-core.mjs (and the advisory-fix path), with tests replaying #3215's finding.

## Progress

- Premise check (2026-10-03): not delivered. `git log --grep=4871` shows only the card-filing merge (PR #3309); no code change names it. Goal stands.
- Scope corrected: the card names `we:scripts/lib/review-core.mjs`, but that file is only a facade that re-exports the classifier. The real seams are `we:scripts/lib/jury-core.mjs` (`normalizeFinding` :365, `deriveFindingDisposition` :320, `earnsRound` :337, `deriveVerdict` :945) and `we:scripts/lib/review-loop-policy.mjs` (the unattended accept/filing policy). Corrected scope is exactly the frontmatter `scope:` list: we:scripts/lib/jury-core.mjs (classification and the mandate wording, in `buildSubjectMandate`), we:skills-src/jury/panel-fanout.mjs, we:scripts/operations/review-pr.mjs, we:scripts/lib/review-loop-policy.mjs, we:scripts/operations/review-loop-cli.mjs, plus their five test files. `we:scripts/lib/review-core.mjs` is dropped: it is only a re-export facade.
- The #3215 citation (we:scripts/readiness/dispatch-plan.mjs:1054) is only the example finding; it is replayed as test data, not edited.

## Design

Today a finding blocks only if it is a `blocker`: `deriveFindingDisposition` (we:scripts/lib/jury-core.mjs:320) returns `blocker` only when all three direction tests say introduced + worseThanBase + not parallelizable; everything else is a `carve-out`, which `earnsRound` (:337) lets through, so `deriveVerdict` (:945) returns `accept`. #3215's finding (new networked fallback adds GitHub calls, defeating the "shorter rounds" goal) failed the "worse than base" test as the juror read it, so it was a carve-out.

**Gap 1 — goal-contradiction blocks.** Add one strict-boolean finding field `contradictsGoal` ("does shipping this defeat the goal quoted in the goal block?"). `normalizeFinding` (:365) carries it like the other direction booleans (strict boolean, else no key). `deriveFindingDisposition` returns `blocker` when `contradictsGoal === true`, ahead of the three-test routing. This only ever makes a finding MORE blocking, so it respects the existing no-self-un-blocking rule (the comment block at :433-453). The mandate (`buildSubjectMandate`, we:scripts/lib/jury-core.mjs ~:2042-2080, the goal block) gains one question asking for the field, only when a goal is supplied. Undeclared stays as today (byte-stable). `deriveFindingDisposition` gains a fourth input (`contradictsGoal`), and `normalizeFinding` must carry the field BEFORE it calls it (we:scripts/lib/jury-core.mjs ~:448). The field is never read to un-block anything. The finding schemas are hand-listed in more than one place, and a field added only to `normalizeFinding` + the mandate ships inert (as `impactIfUnfixed` once did), so the same field is added to we:skills-src/jury/panel-fanout.mjs (prompt ~:192, schema ~:247) and we:scripts/operations/review-pr.mjs (schema ~:911), with a parity test. The mandate wording lives in `buildSubjectMandate` (we:scripts/lib/jury-core.mjs), not we:scripts/lib/review-core.mjs, which is dropped from scope. Existing withholding paths (`scopeFindingsToCitedFiles`, `admitFindingsByEvidence`) still apply to a goal-contradicting finding; that is intended and pinned by a test. Over-blocking is bounded by the existing round cap and anti-spiral clause.

**Gap 2 — accept + findings never drops.** `deriveVerdict` stays unchanged. In we:scripts/operations/review-loop-cli.mjs, on an accepted run, every outstanding carve-out/nit finding is filed as a follow-up card through the same `file-item` landing-job binding the prevention filing already uses (`fileItemForPreventionViaLandingJob`, :180), with a pure input builder in we:scripts/lib/review-loop-policy.mjs beside `buildPreventionFilingInput`, and the same per-anchor dedupe as `findFiledPreventionCard` (:233).

- **Findings with no `file`.** A goal-level or cross-cutting finding often has no `file`. It is filed too, never skipped: the card body anchors it by its summary text (the same no-file fallback `preventionGuardAnchor` already has), and the dedupe keys on that anchor. A finding with a `file` carries its `file:line` in the body.
- **Overlap with the prevention path.** The prevention filing runs only when the verdict is `prevention-outstanding` (`isPreventionOutstandingParked`, we:scripts/operations/review-loop-cli.mjs:406); on a clean `accept` (`deriveVerdict` returns ACCEPT at we:scripts/lib/jury-core.mjs:959) it never runs. `hasUncapturedPrevention` is deliberately wider than `blocksAcceptance`, so a carve-out can owe a below-bar prevention and still reach a clean accept. So the exclusion is conditional: a finding already filed by the prevention path is excluded from Gap 2 only on a `prevention-outstanding` run, which resumes to an accept after that filing. On a clean accept, Gap 2 files every outstanding carve-out/nit, including one that also owes a below-bar prevention, and the card body carries its `prevention` text.
- **Failure behavior (the opposite of the prevention path).** The prevention path, on a failed filing, leaves the run parked and records nothing (we:scripts/operations/review-loop-cli.mjs:439-455), because that debt must be tracked before an accept. Follow-up cards are not a gate: a failed follow-up filing never undoes or blocks the accept. It is caught, reported loudly (a `followUpFilingError` field in the JSON payload and a printed line), and the accept proceeds. Do not copy the prevention path's park-on-failure branch.
- **Sanitization.** The new builder writes juror-supplied text (from LLM jurors reading attacker-influenceable PR content) into an auto-landed card. It must route every `finding.file` through `cleanFindingFile` (we:scripts/lib/review-loop-policy.mjs:386, the PR #2766 guard against frontmatter injection) and pass the free prose through the same `findUnmarkedLocusRefs` locus-prefix pass `buildPreventionFilingInput` uses (:346), so an unprefixed path in a summary cannot make the write-time scan refuse the card.

## MVP

Musts:
1. `contradictsGoal` field: normalized, carried, forces `blocker` disposition; mandate asks for it when a goal exists; panel-fanout and review-pr schemas carry it (parity test).
2. Accepted unattended run files each outstanding non-blocking finding as one follow-up card (with `file:line` when it has a file, else anchored by its summary), deduped on re-run; a filing failure never undoes the accept. This is the OPPOSITE of the prevention path, which parks on failure (we:scripts/operations/review-loop-cli.mjs:439-455).
3. The new builder sanitizes juror-supplied text: `finding.file` goes through `cleanFindingFile`, free prose through the locus-prefix pass.

Gap 2 hooks the accepted-run branch of the unattended CLI (a new branch beside the prevention-outstanding one at we:scripts/operations/review-loop-cli.mjs ~:395-430), with its own title, head marker and anchor matcher (the prevention matcher filters on `hasUncapturedPrevention` and cannot be reused); a finding that is both uncaptured-prevention and a carve-out is filed once: by the prevention path on a `prevention-outstanding` run, by Gap 2 on a clean accept. The #3215 finding reached the operator through the review panel's accept; gap 1 is what would have stopped it, so gap 2 is delivered here for the unattended path only.

Out of scope (see Follow-ups): the human-driven review-pr operation (we:scripts/operations/run.mjs), and the interactive advisory-fix round. The card's gap 2 is therefore only partly delivered.

## Test plan

Capability cases (RED today) are the #3215 replay, the mandate-text case, the schema-parity case, the policy-builder case, and the CLI filing cases (RED until the filer exists; today an accepted run files nothing). Cases marked "preservation" pass today and name their mutation proof: dropping the new branch from `deriveFindingDisposition` turns the replay RED.

- jury-core preservation (mutation: bypass the withholding guard — make `scopeFindingsToCitedFiles` / `admitFindingsByEvidence` pass the finding through; removing the `contradictsGoal` branch would NOT redden this case, since a weakly cited finding stays withheld either way): a finding with a weak citation that `scopeFindingsToCitedFiles` withholds is still withheld even with `contradictsGoal:true`. Run the bypass mutation and require this case to fail.
- Parity: panel-fanout's prompt/schema and review-pr's schema both list `contradictsGoal` (RED today).

- jury-core: a #3215-shaped finding (`introduced:true, worseThanBase:false, parallelizable:true`, `contradictsGoal:true`) normalizes to `blocker` and `deriveVerdict` returns `changes`. Fails RED today: the key is dropped and it routes to carve-out → `accept`.
- jury-core: `contradictsGoal:false` or absent leaves the carve-out routing unchanged (regression guard); a non-boolean (`"yes"`) adds no key.
- jury-core: `contradictsGoal:true` still cannot be undone by a declared `disposition:'nit'`.
- mandate: with a goal, the mandate text asks for `contradictsGoal`; with no goal it does not (RED today: the text is absent).
- review-loop-policy: the new builder turns outstanding carve-out/nit findings into a filing input carrying every `file:line`, and returns null for none (RED: builder does not exist).
- review-loop-policy (degenerate input): a carve-out with no `file` and no `line` is still included in the filing input, anchored by its summary; the dedupe matches it on a second run.
- review-loop-policy (injection): a finding whose `file` is `x\nscope: ["we:evil"]` or contains a quote yields a card input with no injected frontmatter key (the value goes through `cleanFindingFile`); a summary with an unprefixed path does not make the locus-prefix scan refuse the card.
- CLI (we:scripts/operations/review-loop-cli.mjs): an accepted run with two carve-outs files once, a second run with the same findings and head files nothing; a filing failure leaves the accept intact AND reports `followUpFilingError` (the opposite of the prevention path, which parks).
- CLI (intersection): a clean-accept run (no finding at or above `PREVENTION_IMPACT_BAR`) whose carve-out also owes a below-bar uncaptured `prevention` files that finding through Gap 2 (it is not dropped); on a `prevention-outstanding` run the same finding is filed once, by the prevention path, and not again by Gap 2.
- CLI (no file): an accepted run with a goal-level carve-out that has no `file` files it.

## Proof plan

Replay the #3215 finding (reconstructed from the card text, since the original JSON is not in the repo) through `deriveVerdict` before and after (accept → changes), and run we:scripts/operations/review-loop-cli.mjs against a hand-built accepted run fixture with carve-outs, injecting a temp filing root through the `fileItem` / filed-card-lookup seams (the production filer spawns a detached landing job), showing the card written with its `file:line` and a second run filing nothing.

## Follow-ups

- Same follow-up filing for the human review-pr path (the other half of the card's gap 2).
- Advisory-fix round option to fix a non-blocking finding in place instead of filing it.
- Calibrating how often jurors set `contradictsGoal` (false-positive rate on real PRs).

## Done when

1. **Executable** — vitest on every test file in this card's scope: we:scripts/lib/__tests__/jury-core.test.mjs, we:scripts/lib/__tests__/review-loop-policy.test.mjs, we:scripts/operations/__tests__/review-loop-cli.test.mjs, we:skills-src/jury/__tests__/panel-fanout.test.mjs and we:scripts/operations/__tests__/review-pr.test.mjs passes with the #3215 replay, the schema-parity, filing, intersection, no-file and injection cases, and fails before this item lands.
2. **Must (error path)** — a filing call that errors never undoes a recorded accept (the only new obligation here; fail-closed normalization already holds), pinned by the CLI filing-failure case in Done-when #1's executable.
3. **Must (non-code inputs)** — `contradictsGoal` is keyed on the finding, not the file type, so a finding on a docs/config/data file blocks the same way; one test uses a `.md` file.

## Findings (standalone worker, 2026-11-19)

The build-dispatch daemon held #4871 with:

> worker-declined: Not prepared: #4871 — could-not-prepare. The card requires filing failures to preserve acceptance, but 'we:docs/agent/platform-decisions.md:6650' ('#post-accept-advisory-cards') requires failed filing to keep the PR parked, one card per PR, and staged activation. The unresolved choice is whether #4871 follows that ratified policy or explicitly requests an exception. I cannot choose that policy change during preparation. No files changed or stamps added. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
