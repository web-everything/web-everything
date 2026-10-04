---
bornAs: xp33bdf
kind: story
size: 5
parent: "4936"
status: open
blockedBy: ["4874", "4374", "4815"]
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/pr-view-transport.mjs", "we:scripts/lib/__tests__/pr-view-transport.test.mjs", "we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/__tests__/review-loop-policy.test.mjs", "we:scripts/lib/model-probation.mjs", "we:scripts/lib/model-probation.json", "we:scripts/lib/__tests__/model-probation.test.mjs", "we:config/defineConfig.ts", "we:config/platformDefaults.ts", "we:config/__tests__/config-contract.test.ts"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "4a2606bc2f711efd86849e250db36b1b100a0fa4"
tags: [review, routing, independence]
---

# A Codex mandatory seat on every Claude-authored PR, so one blocking seat always comes from another provider

On a PR with any Claude-authored commit (or unknown authorship), seat a blocking Codex correctness juror beside the two Claude mandatory seats. A Codex-only PR needs nothing new: its Claude seats are already cross-provider. If Codex is unavailable, the review still runs but cannot clear: an accept parks review:human with the reason. Records author and seat providers on the verdict.

## Progress

Preparation (2026-10-03) grounded the seams. Nothing is built yet.

- **Today every mandatory seat is Claude.** `JUDGE_SEATS` holds `judge` and `judgeSecurity` (`we:scripts/operations/review-pr.mjs:305`). Both use `JUDGE_MODEL` with tools, and the review job pins `--provider=claude` (`we:scripts/operations/review-job.mjs:259`). Most PRs are Claude-written, so their mandatory reviewers are the same provider as the author. Decision 5079 (opened 2026-10-03 in open PR #3771, not on `main`) names this gap for the judge seat. This card closes it for review seats.
- **A Codex seat already exists, but only as advisory.** `CORRECTNESS_ADVISORY_SEAT` (`we:scripts/operations/review-pr.mjs:452`) is built by `buildReviewCorrectnessAdvisoryJudgeRequest` (line 1378). It pins `providerName: 'codex'`, returns the mandatory `REVIEW_JUDGE_SHAPE`, and sets `gracefulOnUnavailable: true`. It is opt-in through `correctnessAdvisoryFromEnv` (line 478). Its findings are excluded from the verdict at line 2377 (`!ADVISORY_SEAT_STEPS.includes(seat.step)`).
- **Codex must be tool-free in the adapter.** `TOOL_FREE_JUDGE_PROVIDER_NAMES` includes `codex` (`we:scripts/operations/cli-adapter.mjs:649`). A tool-bearing request is refused (line 833). Codex still gets a real read-only shell through `-s read-only` (`we:scripts/lib/codex-judge-spawn.mjs`). So the Codex seat can read and grep but cannot run tests. The Claude correctness seat keeps execution.
- **Capacity.** The daemon plist sets `WE_REVIEW_SEAT_CAP_CODEX=5000`, so Codex is effectively uncapped. Antigravity and Gemini are at 0. The cap gate in `we:scripts/operations/review-extra-seats.mjs` governs only the added seats, not `review-pr` judge steps.
- **Commits are not read today.** `PR_VIEW_FIELDS` (`we:scripts/lib/pr-view-transport.mjs:90`) has no `commits`. `review-pr` therefore cannot see who wrote the PR. `TRANSPORT_VIEW_FIELDS` (`we:scripts/produce-pr-view.mjs:42`) is derived from it, so the file transport follows automatically.
- **Probation.** `PROBATION_ROLES` is `['delivery', 'advisory-review']`, and `advisory-review` is `NEVER_BLOCKING` (`we:scripts/lib/model-probation.mjs:68,81`). `codex::gpt-6-astra` holds `advisory-review: probation` in `we:scripts/lib/model-probation.json`. A blocking Codex seat needs a role that is not declared never-blocking.
- **The unattended accept seam.** `reviewLoopAutoConfirm` (`we:scripts/lib/review-loop-policy.mjs:149`) answers an agent-addressed confirm, or declines so the run stays parked for a human. Declining is how this card parks an accept it cannot clear.

## Design

1. **Read authorship.** Add `'commits'` to `PR_VIEW_FIELDS`. In `shapeReadFinding`, pass the raw `commits` into `reviewNeedFor` (story 4874), so `read.need.crossProvider` and `read.need.authors` are set. A missing or unparseable `commits` field gives `authorsKnown: false` and `required: 'codex'`, which fails closed.
2. **New mandatory step `judgeCrossProvider`.** It is declared always, not behind the advisory env flag. Its request comes from `buildReviewCrossProviderJudgeRequest({ read, aim })`:
   - correctness mandate and `REVIEW_JUDGE_SHAPE`;
   - `providerName: 'codex'`, no `allowedTools`, and the same `CODEX_ADVISORY_SANDBOX_CORRECTION` text the advisory seat appends (line 1243);
   - effort from `CODEX_TIER_EFFORT[read.need.tier]` (`we:scripts/lib/codex-model-routing.mjs:110`): low, medium or high;
   - `gracefulOnUnavailable: true`, so an outage becomes a recorded skip, not a crash.

   When `read.need.crossProvider.required` is `null` (Codex-only authors), the step records `skipped: 'author-not-claude'` and spawns nothing. The step's lens is `MANDATORY_LENSES[0]` (correctness). Its admitted findings join the verdict like the other mandatory seats. Extend the registration assertion at the bottom of `reviewPrOperation` to cover the new step.
3. **No double Codex correctness seat.** When `judgeCrossProvider` runs, the opt-in `judgeCorrectnessAdvisory` seat is suppressed for that run. It would be the same model on the same lens.
4. **Independence record.** `reduce` adds `verdict.independence = { authors, seatProviders: { correctness: 'claude', security: 'claude', crossProvider: 'codex'|'skipped' }, crossProvider: 'met'|'not-required'|'unmet', cause }`. The value is `unmet` when the seat was required and Codex was skipped, timed out or returned an invalid answer. `renderVerdictWriteUp` (line 1500) prints one line: `Independence: authors <list>; seats <provider per lens>; cross-provider <met|not-required|unmet (cause)>`.
5. **Unmet blocks unattended accept only.** `reviewLoopAutoConfirm` declines an `accept` when `run.verdict.independence?.crossProvider === 'unmet'`. The run stays parked; the existing queued-accept notice names the cause. A human `/review` can still clear it, because a human is independent. A `changes` verdict from any seat still bounces normally.
7. **The stand-in is the `crossProviderFallback` dimension (decision 4772, ruled 2026-10-03).** The `unmet` handling in step 5 is governed by one key in the keyed `webeverything.config.*` file, declared in `we:config/defineConfig.ts` with its platform default in `we:config/platformDefaults.ts` (already landed with the ruling). Values: `park-now` (decline the unattended accept at once, the original step 5); `wait-then-park` (**default**: keep the run `review:pending`, re-dispatch when the quota-hold reset time from `we:scripts/lib/provider-quota-hold.mjs` passes, and park `review:human` once `waitTimeoutMs` has elapsed, default 24 hours); `same-provider-other-model` (opt-in only: a different Claude model, e.g. Opus on a Sonnet-authored PR, counts as the independent seat and the run records `crossProvider: met` with cause `same-provider-other-model`). `review-pr` reads the resolved value; a missing, unparseable or unknown value resolves to the default `wait-then-park`, never to `same-provider-other-model`. The judge seat (decision 5079) reads the same key.
6. **Probation role.** Add `'mandatory-review'` to `PROBATION_ROLES`, and do not add it to `NEVER_BLOCKING_ROLES`. Give the `codex::gpt-6-astra` entry `mandatory-review: probation` with `since: <build date>`, owner `4880`. Its meaning: this seat may block (veto) a PR, but its accept never clears one alone, because the Claude mandatory seats must also accept. This follows the operator's 2026-10-03 direction for a cross-provider mandatory seat. Graduation to `trusted` stays a separate human ruling (`we:docs/agent/platform-decisions.md#model-probation-graduation-criteria`).

## MVP

Steps 1-7 in one PR. Incremental behind `main`; additive. The new step is the only behaviour change, and it only adds a blocking seat or a park.

This card must land after 4815 (open PR #3507), which edits `we:scripts/operations/review-pr.mjs`, and after 4374, which edits the same request builders. It needs 4874 for `reviewNeedFor`.

Tasks: (1) add the transport field and test; (2) add the probation role and registry entry, with tests; (3) add the request builder and step, with the registration assertion; (4) add `independence` to `reduce` and the write-up; (5) add the decline rule to the loop policy; (6) read the `crossProviderFallback` dimension in `review-pr` and the review daemon's re-dispatch (the three values, the timeout, the default); (7) run the live proof.

## Test plan

- (RED today) `we:scripts/lib/__tests__/pr-view-transport.test.mjs`: `commits` is in both field lists.
- (RED today) `we:scripts/lib/__tests__/model-probation.test.mjs`: `mandatory-review` is a valid role and is not in `NEVER_BLOCKING_ROLES`. `assertRoleNeverBlocks('mandatory-review')` throws. A registry missing the entry reads `unvalidated`. The existing advisory roles are unchanged.
- (RED today) `we:scripts/operations/__tests__/review-pr.test.mjs`:
  - a Claude-authored read seats `judgeCrossProvider` on Codex with no `allowedTools` and effort from the tier;
  - a Codex-only read records `skipped: 'author-not-claude'` and spawns nothing;
  - mixed authors, unknown authors and missing `commits` each seat Codex;
  - a Codex `changes` with an admitted blocking finding flips the panel verdict to `changes`;
  - a Codex skip (quota hold) gives `independence.crossProvider === 'unmet'` and leaves the Claude verdict intact;
  - `judgeCorrectnessAdvisory` is not spawned when the cross-provider seat runs;
  - the write-up shows the independence line.
- (RED today) `we:scripts/lib/__tests__/review-loop-policy.test.mjs`: an agent-addressed `accept` with `unmet` returns `null` (decline). `met` and `not-required` answer as before. A `changes` with `unmet` is unaffected.
- (RED today) `crossProviderFallback` in `review-pr` / `review-loop-policy` tests, one case per value:
  - `park-now`: Codex skipped gives `unmet` and an immediate decline, with no re-dispatch scheduled;
  - `wait-then-park`: Codex skipped inside `waitTimeoutMs` keeps the run `review:pending` and schedules a re-dispatch at the hold's reset time;
  - `wait-then-park` timeout expiry: once `waitTimeoutMs` has elapsed with the seat still unavailable, the run parks `review:human` with the reason;
  - `same-provider-other-model`: a different Claude model seats as the independent seat and the run records `met` with that cause;
  - default: with no config key, with an unknown value and with a malformed value, the resolved policy is `wait-then-park`, and `same-provider-other-model` is never selected unless explicitly set;
  - the default `waitTimeoutMs` equals `PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS` and a non-positive or non-numeric timeout falls back to it.
- The config contract (`we:config/__tests__/config-contract.test.ts`) already asserts the three values are accepted and the default is `wait-then-park`, not `same-provider-other-model`.
- (RED today) **Must on error:** unknown authorship, a malformed `commits` field, a Codex timeout, malformed JSON or a refusal must all give `unmet` or seat Codex. None may give `not-required` or an unattended accept.
- (RED today) **Must for non-code:** a docs-only, config-only or data-only Claude-authored PR still seats Codex. The independence rule does not depend on file type. Only a Codex-only authorship skips the seat.

## Proof plan

1. Run the four scoped suites. Mutation checks: (a) delete the decline rule; the `unmet` policy test must fail. (b) Make the step always skip; the Claude-authored seating test must fail.
2. Live, from an acquired lane, using the we:scripts/operations/review-loop-cli.mjs entry point with `--pr=<n> --repo=chalbert/webeverything --cwd=<lane> --provider=claude --json`:
   - on a real Claude-authored PR, show the Codex spawn argv (`-m gpt-6-astra`, effort, `-s read-only`), its answer, and the independence line;
   - on a real Codex-authored PR, show `not-required` and no Codex spawn;
   - for `unmet`, set a provider hold through the existing quota-hold file in a scratch state directory. Show the skip and the declined accept, and label this case staged.

   Paste run ids and the write-up lines here. Passing unit tests are not proof on their own (`we:docs/agent/prototype-based-dev.md`).

## Done when

1. The scoped suites pass. Both mutation checks fail them.
2. Live evidence for the Claude-authored, Codex-authored and staged-unmet cases is recorded on this card.
3. `npm run check:standards` passes.

## Follow-ups

- Decision 4772 is ruled (2026-10-03): the stand-in is the `crossProviderFallback` dimension, default `wait-then-park` (design step 7).
- When 5079 is ruled, align the judge seat with this review-seat rule. Both should use the same author-provider reader from 4874.
- Seat-level trial records for `mandatory-review` (rate the Codex seat's blocking findings against outcomes) belong in the run-rating work. File them when 20 or more real blocking findings exist.
