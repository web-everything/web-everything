---
bornAs: xa2b8x5
kind: story
size: 3
parent: "4075"
status: active
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/land-overlap-yield.mjs", "we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs", "we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs", "we:scripts/__tests__/backlog-cli-snapshot.test.mjs"]
dateOpened: "2026-09-28"
dateStarted: "2026-09-30"
preparedDate: "2026-09-30"
preparedAgainstSha: "e20756915ef4a1d7bf0bea1e0926dae2cf2acc99"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2887's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:1810` — Add a wiring test that runs `buildOverlapRows` with a non-candidate Y whose PR body declares blockedBy X. Then derive Y's `dependsOn` from its listing `body` (already fetched in CONTEXT_LIST_FIELDS) via the lane-manifest parser.
2. `we:scripts/backlog.mjs:1049` — Add the two snapshot cases in `we:scripts/__tests__/backlog-cli-snapshot.test.mjs`. A broader guard would be a check-standards rule requiring every verb that mutates a tracked file to have a lane-guard refusal test.
3. `we:scripts/conveyor/land-overlap-yield.mjs:310` — Deterministic gate: comprehensive unit test coverage on IO shell modules to assert documented fallback behaviors.
4. `we:scripts/conveyor/land-overlap-yield.mjs:400` — Deterministic gate: unit tests for API parsing functions injecting fake `ghExec` responses to verify temporal ordering logic and empty states.
5. `we:scripts/conveyor/land-overlap-yield.mjs:360` — Deterministic gate: unit test providing a mocked `exec` function and asserting call counts to strictly verify memoization.
6. `we:scripts/backlog.mjs:1030` — Deterministic gate: CLI input validation tests covering all mutually exclusive and invalid inputs for new flags.
7. `we:scripts/merge-ai-prs.mjs:1814` — A unit test in `we:merge-ai-prs-overlap-yield.test.mjs` proving `planLabelDrain` does not yield when a non-candidate (Y) has `blockedBy` pointing to the candidate (X), using a raw `openPrContext` fixture that lacks a verdict for Y.
8. `we:scripts/conveyor/land-overlap-yield.mjs:256` — A unit test in `isExemptItem` specifically verifying that it correctly parses exemptions from a file named exactly `${itemId}.md` without a hyphen.
9. `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:141` — A deterministic lint rule or review lens requiring tests that differentiate between two fallback paths to use distinct expected values for each path.
10. `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:101` — A code review lens requiring test fixtures to instantiate the exact number of entities described in the test's prose comments.
11. `we:scripts/merge-ai-prs.mjs:1814` — A unit test in `we:merge-ai-prs-overlap-yield.test.mjs` verifying that `buildOverlapRows` correctly extracts `dependsOn` (by parsing the body) for a PR that exists in `openPrContext` but has no entry in `verdicts`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2887@c2750804c0769a654d0b62b3685bfcdae122f7db

## Done when

1. **Executable** — `npx vitest run` over `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs`, `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs` and `we:scripts/__tests__/backlog-cli-snapshot.test.mjs` fails before this item lands (the new `dependsOn`-from-body cases are RED) and passes after.

## Premise check (2026-09-30, against `main` @ e2075691)

Still owed — not superseded. #4308 (`c2750804c`) landed the overlap-yield feature; none of the guards below exist yet:

- **Real code gap (items 1, 7, 11):** `buildOverlapRows` (`we:scripts/merge-ai-prs.mjs:1795`) builds `dependsOn` only from the drain *verdict* (`v?.blockedBy`, `v?.stackParents`). A non-candidate open PR Y has no verdict, so its `dependsOn` is empty even when its body's lane-manifest block declares `blockedBy: [X]`. Rule 4 (`dependsOnCandidate`, `we:scripts/conveyor/land-overlap-yield.mjs:182`) then never fires and X yields to a Y that is itself waiting on X — a deadlock until X's budget expires. `CONTEXT_LIST_FIELDS` (`we:scripts/merge-ai-prs.mjs:2099`) already fetches `body`, and `extractManifestFromBody` (`we:scripts/readiness/lane-manifest.mjs:258`) is the existing parser.
- **Test gaps only (items 3, 4, 5, 8):** `isShallowRepository`, `gitHistoryConfigAtReader` (incl. its `memo`), `readyToMergeLabelTimeMs` and `isExemptItem`'s filename match have no direct test (`we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs` covers them only through injected fakes of the *callers*).
- **Test gaps only (items 2, 6):** `we:scripts/__tests__/backlog-cli-snapshot.test.mjs:327-351` covers `--show`, `--set-window` and bad `--set-window`; it lacks the `--set-enabled` invalid-value cases and the primary-checkout lane-guard refusal (`we:scripts/backlog.mjs:1058`).
- **Not mechanically testable (items 9, 10, and the check-standards half of 2):** lint/review-lens asks → Follow-ups.
- **Scope corrected:** dropped `we:scripts/backlog.mjs` (no change needed — only its tests), `we:scripts/__tests__/merge-ai-prs.test.mjs` and `we:scripts/__tests__/backlog.test.mjs` (the latter does not exist); added the `merge-ai-prs-overlap-yield` and `backlog-cli-snapshot` test files, where the owed tests belong.

## Design

One production change, the rest is tests.

1. **Production fix (`we:scripts/merge-ai-prs.mjs:1795`).** In `buildOverlapRows`, union the verdict's `blockedBy`/`stackParents` with `extractManifestFromBody(p.body)?.blockedBy` / `.stackParents` (normalised with the same `asItemId` the verdict path uses, `we:scripts/merge-ai-prs.mjs:1395`) so a PR with no verdict still carries its declared dependencies. Verdict wins where present (union, never replace). A missing/invalid manifest contributes nothing (extractor returns null) — same as today.
2. **Tests, `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs`.** (a) `buildOverlapRows` with a raw PR whose body embeds a manifest (build it with `embedManifestInBody`) and no verdict → row `dependsOn` contains X's item (items 1, 11). (b) `planLabelDrain` end to end: X (candidate, item 100) and non-candidate Y whose body declares `blockedBy:[100]`, larger, overlapping, in review; run `buildOverlapRows` → `overlapYieldWaits` (hand-set `readyAtMs`/`windowMs`; NOT `computeOverlapContext`, which does real gh/git IO) → `planLabelDrain` and assert X does NOT defer with `overlap-yield` (item 7).
3. **Tests, `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs`.** `isShallowRepository` (`true`/`false`/garbage/throw → `true`/`false`/`null`/`null`); `gitHistoryConfigAtReader` with a mocked `exec` — shallow → `{trusted:false}`, no-commit → `{trusted:true, windowMinutes:null}`, good commit → the window, `git show` throws → `windowMinutes:null`, and a call-count assertion that two `configAt(ms)` calls with the same `ms` invoke `exec` once (memoization, item 5); `readyToMergeLabelTimeMs` with a fake `ghExec` and a temp `dir` — multiple `labeled` events → the LAST wins, other labels ignored, empty/invalid JSON → `null`, no slug/sha → `null` with no exec call, second call with same sha served from cache (exec count 1) (item 4); `isExemptItem` (item 8): the card's wording asks it to parse a file named exactly `<id>.md`, but the code (`we:scripts/conveyor/land-overlap-yield.mjs:297`) deliberately matches only the `<id>-` prefix, and every card file in `backlog/` is named number, hyphen, slug. This plan REJECTS the card's wording and pins the real convention: a hyphen-less `<id>.md` is not matched (not exempt), and id 100 does not match a `1000-`-prefixed file. No code change.
4. **Tests, `we:scripts/__tests__/backlog-cli-snapshot.test.mjs`.** In the `overlap-yield-config` describe: `--set-enabled=yes|1|TRUE` each → exit 1, file unchanged; `--set-window=-5|Infinity` → exit 1 (item 6). Plus the lane-guard case (item 2): copy `scripts/` into `<tmp>/ws/webeverything/scripts` (a `PRIMARY_REPOS` name, `we:scripts/guard-lane.mjs:100`) and run the verb from there → exit 1 with "BLOCKED", config untouched. The builder confirms this simulates "primary" for `laneGuardDecision`; if the harness cannot, fall back to a direct `laneGuardDecision` unit assertion on the same path and say so.

## MVP

Musts only: the `dependsOn`-from-body production fix + its two merge-ai-prs tests; the owed unit tests for items 3, 4, 5, 8; the CLI validation + lane-guard snapshot cases for items 2 (snapshot half), 6. **Out:** the check-standards rule for verb lane-guard tests, and the lint / review-lens asks (items 9, 10) — see Follow-ups.

## Test plan

- `buildOverlapRows` derives `dependsOn` from a body-only manifest — RED today: `dependsOn` is `new Set([])`, assertion `has(100)` fails.
- `planLabelDrain` does not yield to a non-candidate Y blocked by X — RED today: X defers `overlap-yield:#Y`.
- `gitHistoryConfigAtReader` memo: `exec` called once for repeated `ms` — guards against removing the memo (would double git calls; currently passes, so this is a regression guard — proven RED by mutating the memo out locally during build).
- `readyToMergeLabelTimeMs`: last-label-wins, cache hit, bad JSON → null — same mutation proof (flip to first-wins → RED).
- `isShallowRepository` / `gitHistoryConfigAtReader` fallbacks: each branch asserts a distinct value so a swapped branch fails.
- `isExemptItem` hyphen-less/prefix-collision cases.
- CLI: invalid `--set-enabled` values and the primary lane-guard each exit 1 with the file byte-identical.

Only the first two are RED on unmodified code; the rest are regression guards and each gets a one-line mutation-proof in the PR body.

## Proof plan

Before/after on the real wiring: run the two merge-ai-prs tests against `main` (RED, output captured) and the lane (GREEN). Then the live-case probe: capture the REAL open-PR listing now (`gh pr list --state open --json number,title,body,labels,statusCheckRollup,headRefName,headRefOid,baseRefName,isDraft,files`), feed it through `buildOverlapRows` on `main` and on the lane, and print each open PR's `dependsOn` — before: empty for every non-verdict PR even where its body carries a manifest `blockedBy`; after: populated from the body. If no live open pair currently has a blocked Y overlapping a ready X, the builder says so explicitly and additionally splices a manifest block into ONE real captured PR body (an in-memory copy, nothing posted) to show the before/after wait map. Mutation proofs for the regression-guard tests as above.

## Follow-ups

Each is filed as its own backlog card by the BUILDER (standard delivery step 4) — not left as prose.

Design note: the fix re-parses `p.body` rather than reusing the drain's `manifestByPr` (`we:scripts/merge-ai-prs.mjs:1426`) because `buildOverlapRows` is fed raw listings (and raw test fixtures) that carry no reduced context.

- check-standards rule: every verb that mutates a tracked file must have a lane-guard refusal test (item 2's broader guard).
- Lint rule / review lens: tests that distinguish two fallback paths must use distinct expected values per path (item 9).
- Review lens: test fixtures must instantiate the entity count their prose comments claim (item 10).
