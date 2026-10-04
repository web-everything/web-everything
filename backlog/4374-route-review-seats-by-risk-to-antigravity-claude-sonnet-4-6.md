---
bornAs: xh701hj
kind: story
size: 3
parent: "4936"
status: resolved
blockedBy: ["4874", "4815"]
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-09-28"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "4a2606bc2f711efd86849e250db36b1b100a0fa4"
tags: [review, routing]
---

# Mandatory review seats pick their Claude model size and tools from the review need (Haiku, Sonnet, Opus)

The two mandatory review seats take their Claude model from the review-need tier: Haiku for inert prose (card-only, notes), Sonnet by default, Opus for gate, statute, security, irreversible or human-required changes. A seat gets tools only when its lens must run code. The tier comes from the verified net diff, never from caller input. Every seat records the model, tools and reason it ran with. Re-aimed 2026-10-03 from the Antigravity-Sonnet route, because Antigravity review seats are now off.

## Progress

**Implementation preflight (2026-10-03).** Blocked in checkout HEAD
`79afdb836d2709c3ddd0210f2e927e66d7ea1084`: reading
`we:scripts/lib/review-need.mjs` returned `No such file or directory`, and
`git ls-tree HEAD` queried for that path returned no entry. Dependency
#4874 remains open and its Progress says “Nothing is built yet”; #4815 also
remains open. The scoped implementation cannot import the required
`reviewNeedFor` until #4874 is present, and the MVP explicitly requires landing
after #4815. Before/after: mandatory routing remains the existing literal
Sonnet configuration; no implementation or tests changed. No mutation or live
tier proof is claimed, and this card remains unresolved. Implementing the
missing module would exceed this card's declared scope and the instruction to
create no helper files.

Required verification was invoked with `node we:scripts/verify-lane.mjs`.
It selected the card-only related-test check plus `npm run check:standards`,
then acquired admission capacity after 134171ms. The card-only Vitest selection
found no test files and exited 0. Standards passed with 0 errors and 5295
warnings; the verifier exited 0 and recorded green. This validates the
card-only change, not the unimplemented routing feature. The resolve operation
was not run because the Done-when requirements are unmet.

**Re-aim (2026-10-03).** Old premise: route `none`/`low` mandatory seats to Antigravity-Claude Sonnet 4.6, with a 1-in-5 native comparison and a new `mandatory-review` probation role (prepared 2026-09-30 against b1e5ed4e). Corrected premise: the operator has disabled the Antigravity and Gemini seats. The review daemon plist sets `WE_REVIEW_SEAT_CAP_AGY_CLAUDE=0` and `WE_REVIEW_SEAT_CAP_AGY_GEMINI=0`, and `we:scripts/operations/review-extra-seats.mjs:97` defaults `agy-gemini` to 0 ("Gemini too weak for review until Gemini 4"). Codex is set to 5000, which is effectively uncapped. The operator's target (2026-10-03) is model size by risk on native Claude, plus a cross-provider seat on Codex.

So this card keeps its goal, routing review seats by risk, but drops the whole Antigravity executor. The old scope edited cli-adapter, review-extra-seats, provider-routing, model-probation and log-delegation-trial; it shrinks to `we:scripts/operations/review-pr.mjs` and its test. The cross-provider seat and the new probation role move to 4880. The availability gauge (#4377) is no longer needed, because native Claude needs no gauge. The old 1-in-5 comparison becomes a follow-up for the Haiku tier only.

**Grounding.**

- The seat model is a literal today: `JUDGE_MODEL = 'sonnet'` and `JUDGE_EFFORT = 'high'` (`we:scripts/operations/review-pr.mjs:794-795`). It is set on both mandatory requests in `buildReviewJudgeRequest` (line 1198). `allowedTools: REVIEW_JUROR_TOOLS` is set unconditionally (lines 792 and 1226).
- The review job pins the provider to Claude: `'--provider=claude'` (`we:scripts/operations/review-job.mjs:259`). That pin makes `createDefaultJudge` skip the policy route (`we:scripts/operations/cli-adapter.mjs:803`). With no factory `model`, it keeps the request's own `model` (line 822). So changing `request.model` in review-pr is enough; the adapter needs no change.
- The verified touch-set is available where the request is built: `shapeReadFinding` (line 944) produces `read.netChangedFiles` and the earned care level. Computing the tier there keeps run input away from argv, which is the reason `JUDGE_MODEL` is a literal (comment at line 282).
- Tool-free Claude jurors are already supported. Omitting `allowedTools` gives `--tools ''` in `we:scripts/lib/judge-spawn.mjs`, which is how `we:scripts/lib/judge-panel.mjs` seats them. An empty array is refused by `assertSafeJudgeRequest`, so tool-free means omitting the field.
- Today a prose PR with care `none` usually does not reach review at all (#2631, `we:scripts/lib/review-escalation.mjs:422`). Haiku therefore applies only to prose PRs that are parked for review on purpose.

## Design

1. In `shapeReadFinding`, compute `read.need = reviewNeedFor({ changedFiles: read.netChangedFiles, careLevel: <the earned level> })` from `we:scripts/lib/review-need.mjs` (story 4874). If commits are present in the raw view (4880 adds them), pass them too. Only the tier and tool parts are used here.
2. Replace the literal with a pure, input-free mapping: `export const JUDGE_MODEL_BY_TIER = Object.freeze({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' })`. Keep `JUDGE_MODEL = JUDGE_MODEL_BY_TIER.sonnet` as the documented default and fallback. `buildReviewJudgeRequest({ read, lens, aim })` sets:
   - `model: JUDGE_MODEL_BY_TIER[read.need?.tier] ?? JUDGE_MODEL_BY_TIER.opus`. A missing or unknown tier fails up to Opus, never down.
   - `allowedTools: REVIEW_JUROR_TOOLS` only when `read.need?.needsTools?.[lens] !== false`. The field is omitted only on an explicit `false`, so a missing need keeps tools.
   - `effort: JUDGE_EFFORT` for Sonnet and Opus. For Haiku, omit `effort` unless the live proof below shows the CLI accepts `--effort` with Haiku.
3. The advisory seats (Codex correctness, Codex advisory, Antigravity) keep their own requests unchanged.
4. Provenance: `renderVerdictWriteUp` (line 1500) gains one line per mandatory seat: `<lens>: <model>, tools <on|off> — tier <tier> (<tierReasons joined>)`. The run record's judge rows carry `{ model, tools, tier }` so run rating can compare tiers later.
5. Under-declaration guard: the caller's declared `--careLevel` can raise the tier but never lower it. Use the stricter of the declared level and the earned level, consistent with `assertDeclaredShapeHolds` (line 754).

## MVP

One PR touching `we:scripts/operations/review-pr.mjs` and its test. Incremental behind `main`. It must land after 4815 (open PR #3507), which edits the same file. This card is blocked on 4815 for that reason, and on 4874 for the `review-need` module.

Tasks: (1) compute `read.need` in `shapeReadFinding`; (2) add `JUDGE_MODEL_BY_TIER` and the tier/tools logic to `buildReviewJudgeRequest`; (3) add the provenance line and run-record fields; (4) add tests; (5) run the live proof.

## Test plan

Extend `we:scripts/operations/__tests__/review-pr.test.mjs`:

- (RED today) card-only `read` gives both mandatory requests `model: 'haiku'` with no `allowedTools`;
- (RED today) a `scripts/` non-gate file gives `sonnet` with tools;
- (RED today) `we:scripts/operations/review-pr.mjs` itself (gate-self) gives `opus` with tools;
- (RED today) `need` missing or `tier: 'bogus'` gives `opus` with tools;
- (RED today) a declared `--careLevel=high` on a prose PR does not give Haiku: the declared careLevel raises the tier and never lowers it;
- (RED today) the advisory seats' requests are byte-identical to before (snapshot);
- (RED today) the verdict write-up names the model and tier per seat;
- (RED today) the declared `judge` steps still match `JUDGE_SEATS`, so the registration assertion is unchanged.

**Must on error:** any missing, unknown or unreadable need gives Opus with tools, never Haiku and never tool-free. A test covers each case.

**Must for non-code:** docs, config and data inputs (`we:docs/agent/*.md`, we:AGENTS.md, `src/_data/*.json`, `we:.github/**`, `we:skills-src/**`) never get Haiku or tool-free seats. Only inert prose with care `none` does. Parameterize these.

## Proof plan

1. Run the suite. Mutation check: revert `buildReviewJudgeRequest` to the literal `JUDGE_MODEL`; the haiku and opus cases must fail.
2. Live, from an acquired lane, using the normal review entry point (the we:scripts/operations/review-loop-cli.mjs entry point with `--pr=<n> --repo=chalbert/webeverything --cwd=<lane> --provider=claude --json`), on three real open or recent PRs: one card-only, one ordinary `scripts/` change, one gate-file change. Capture each juror's spawn argv (`--model`, `--tools`, `--effort`) from the run record. Paste the three verdict write-up lines here. A green unit suite alone is not proof.
3. If the Haiku spawn rejects `--effort`, record the exact CLI error and keep `effort` omitted for Haiku.

## Done when

1. The review-pr suite passes with the new cases. The mutation check above fails them.
2. Live run records show `haiku`/tool-free on a card-only PR, `sonnet` with tools on an ordinary code PR, and `opus` with tools on a gate PR. The evidence is pasted here.
3. `npm run check:standards` passes.

## Follow-ups

- The Haiku tier is a step down in reviewer strength on prose. Once 20 or more Haiku reviews exist, compare their findings against a Sonnet re-run on a deterministic 1-in-5 sample. This was the old card's comparison idea, re-aimed at Haiku. File it only if Haiku review volume turns out to be material.
- Promoting a non-Claude provider to a mandatory seat is 4880, not this card.
