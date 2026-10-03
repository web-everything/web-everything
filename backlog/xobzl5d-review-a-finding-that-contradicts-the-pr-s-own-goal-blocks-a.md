---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:skills-src/jury/panel-fanout.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/lib/review-loop-policy.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/lib/__tests__/review-loop-policy.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:skills-src/jury/__tests__/panel-fanout.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-03"
preparedAgainstSha: "a4687bea96bcde71038823a9ffeee3ff774c04f2"
tags: []
---

# Review: a finding that contradicts the PR's own goal blocks, and non-blocking findings on an accepted PR become cards

Live 2026-10-01, PR #3215 (builder round cadence): all five review seats accepted, yet the findings included that the new networked PR-count fallback (we:scripts/readiness/dispatch-plan.mjs:1054) can add GitHub calls every round, which contradicts the PR's own goal of shorter rounds; it was rated a test-coverage gap, so the panel verdict was "accept" and it reached the operator as ready. The operator sent it back. Two gaps: (1) a finding whose consequence defeats the change's declared purpose (from the card's goal / PR description) must be classed blocking, not advisory; (2) every non-blocking finding on an accepted PR must either be fixed in the advisory-fix round or auto-filed as a follow-up card with its file:line, so "accept + findings" never silently drops them. Change the finding classification and the reduce step in we:scripts/lib/review-core.mjs (and the advisory-fix path), with tests replaying #3215's finding.

## Progress

- Premise check (2026-10-03): not delivered. `git log --grep=xobzl5d` shows only the card-filing merge (PR #3309); no code change names it. Goal stands.
- Scope corrected: the card names `we:scripts/lib/review-core.mjs`, but that file is only a facade that re-exports the classifier. The real seams are `we:scripts/lib/jury-core.mjs` (`normalizeFinding` :365, `deriveFindingDisposition` :320, `earnsRound` :337, `deriveVerdict` :945) and `we:scripts/lib/review-loop-policy.mjs` (the unattended accept/filing policy). Corrected scope: we:scripts/lib/jury-core.mjs, we:scripts/lib/review-core.mjs (mandate wording), we:scripts/lib/review-loop-policy.mjs, we:scripts/operations/review-loop-cli.mjs, plus the jury-core, review-core and review-loop-policy tests.
- The #3215 citation (we:scripts/readiness/dispatch-plan.mjs:1054) is only the example finding; it is replayed as test data, not edited.

## Design

Today a finding blocks only if it is a `blocker`: `deriveFindingDisposition` (we:scripts/lib/jury-core.mjs:320) returns `blocker` only when all three direction tests say introduced + worseThanBase + not parallelizable; everything else is a `carve-out`, which `earnsRound` (:337) lets through, so `deriveVerdict` (:945) returns `accept`. #3215's finding (new networked fallback adds GitHub calls, defeating the "shorter rounds" goal) failed the "worse than base" test as the juror read it, so it was a carve-out.

**Gap 1 — goal-contradiction blocks.** Add one strict-boolean finding field `contradictsGoal` ("does shipping this defeat the goal quoted in the goal block?"). `normalizeFinding` (:365) carries it like the other direction booleans (strict boolean, else no key). `deriveFindingDisposition` returns `blocker` when `contradictsGoal === true`, ahead of the three-test routing. This only ever makes a finding MORE blocking, so it respects the existing no-self-un-blocking rule (the comment block at :433-453). The mandate (`buildSubjectMandate`, we:scripts/lib/jury-core.mjs ~:2042-2080, the goal block) gains one question asking for the field, only when a goal is supplied. Undeclared stays as today (byte-stable). `deriveFindingDisposition` gains a fourth input (`contradictsGoal`), and `normalizeFinding` must carry the field BEFORE it calls it (we:scripts/lib/jury-core.mjs ~:448). The field is never read to un-block anything. The finding schemas are hand-listed in more than one place, and a field added only to `normalizeFinding` + the mandate ships inert (as `impactIfUnfixed` once did), so the same field is added to we:skills-src/jury/panel-fanout.mjs (prompt ~:192, schema ~:247) and we:scripts/operations/review-pr.mjs (schema ~:911), with a parity test. The mandate wording lives in `buildSubjectMandate` (we:scripts/lib/jury-core.mjs), not we:scripts/lib/review-core.mjs, which is dropped from scope. Existing withholding paths (`scopeFindingsToCitedFiles`, `admitFindingsByEvidence`) still apply to a goal-contradicting finding; that is intended and pinned by a test. Over-blocking is bounded by the existing round cap and anti-spiral clause.

**Gap 2 — accept + findings never drops.** `deriveVerdict` stays unchanged. In we:scripts/operations/review-loop-cli.mjs, on an accepted run, every outstanding carve-out/nit finding with a `file` is filed as a follow-up card through the same `file-item` landing-job binding the prevention filing already uses (`fileItemForPreventionViaLandingJob`, :180), with a pure input builder in we:scripts/lib/review-loop-policy.mjs beside `buildPreventionFilingInput`, and the same per-`file:line` dedupe as `findFiledPreventionCard` (:233). The finding's `file:line` goes in the card body.

## MVP

Musts:
1. `contradictsGoal` field: normalized, carried, forces `blocker` disposition; mandate asks for it when a goal exists; panel-fanout and review-pr schemas carry it (parity test).
2. Accepted unattended run files each outstanding non-blocking finding as one follow-up card with `file:line`, deduped on re-run; a filing failure never undoes the accept (same as the prevention path).

Gap 2 hooks the accepted-run branch of the unattended CLI (a new branch beside the prevention-outstanding one at we:scripts/operations/review-loop-cli.mjs ~:395-430), with its own title, head marker and `file:line` matcher (the prevention matcher filters on `hasUncapturedPrevention` and cannot be reused); a finding that is both uncaptured-prevention and a carve-out is filed once, by the prevention path. The #3215 finding reached the operator through the review panel's accept; gap 1 is what would have stopped it, so gap 2 is delivered here for the unattended path only.

Out of scope (see Follow-ups): the human-driven review-pr operation (we:scripts/operations/run.mjs), and the interactive advisory-fix round. The card's gap 2 is therefore only partly delivered.

## Test plan

Capability cases (RED today) are the #3215 replay, the mandate-text case, the schema-parity case, the policy-builder case, and the CLI filing cases (RED until the filer exists; today an accepted run files nothing). Cases marked "preservation" pass today and name their mutation proof: dropping the new branch from `deriveFindingDisposition` turns the replay RED.

- jury-core preservation (mutation: remove the `contradictsGoal` branch): a finding with a weak citation that `scopeFindingsToCitedFiles` withholds is still withheld even with `contradictsGoal:true`.
- Parity: panel-fanout's prompt/schema and review-pr's schema both list `contradictsGoal` (RED today).

- jury-core: a #3215-shaped finding (`introduced:true, worseThanBase:false, parallelizable:true`, `contradictsGoal:true`) normalizes to `blocker` and `deriveVerdict` returns `changes`. Fails RED today: the key is dropped and it routes to carve-out → `accept`.
- jury-core preservation (mutation: treat any truthy `contradictsGoal` as true): `contradictsGoal:false`, absent, or a non-boolean (`"yes"`) leaves the carve-out routing unchanged and adds no key.
- jury-core preservation (mutation: let a declared `nit` overwrite the derived blocker): `contradictsGoal:true` with `disposition:'nit'` still routes `blocker`.
- mandate: with a goal, the mandate text asks for `contradictsGoal`; with no goal it does not (RED today: the text is absent).
- review-loop-policy: the new builder turns outstanding carve-out/nit findings into a filing input carrying every `file:line`, and returns null for none (RED: builder does not exist).
- Capability (RED today: an accepted run files nothing) — CLI (we:scripts/operations/review-loop-cli.mjs): an accepted run with two carve-outs files once, and a second run with the same findings and head files nothing.
- Capability (RED until the filer exists) — CLI: a filing failure leaves the recorded accept intact.

## Proof plan

Replay the #3215 finding (reconstructed from the card text, since the original JSON is not in the repo) through `deriveVerdict` before and after (accept → changes), and run we:scripts/operations/review-loop-cli.mjs against a hand-built accepted run fixture with carve-outs, injecting a temp filing root through the `fileItem` / filed-card-lookup seams (the production filer spawns a detached landing job), showing the card written with its `file:line` and a second run filing nothing.

## Follow-ups

- Same follow-up filing for the human review-pr path (the other half of the card's gap 2).
- Advisory-fix round option to fix a non-blocking finding in place instead of filing it.
- Calibrating how often jurors set `contradictsGoal` (false-positive rate on real PRs).

## Done when

1. **Executable** — vitest on we:scripts/lib/__tests__/jury-core.test.mjs and we:scripts/lib/__tests__/review-loop-policy.test.mjs passes with the #3215 replay and the filing cases, and fails before this item lands.
2. **Must (error path)** — a filing call that errors never undoes a recorded accept (the only new obligation here; fail-closed normalization already holds).
3. **Must (non-code inputs)** — `contradictsGoal` is keyed on the finding, not the file type, so a finding on a docs/config/data file blocks the same way; one test uses a `.md` file.
