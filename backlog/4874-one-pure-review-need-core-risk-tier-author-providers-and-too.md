---
bornAs: xoopd0u
kind: story
size: 3
parent: "4936"
status: resolved
scope: ["we:scripts/lib/review-need.mjs", "we:scripts/lib/__tests__/review-need.test.mjs", "we:scripts/review-core-cli.mjs", "we:scripts/__tests__/review-core-cli.test.mjs"]
dateOpened: "2026-10-03"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "4a2606bc2f711efd86849e250db36b1b100a0fa4"
tags: [review, routing]
---

# One pure review-need core: risk tier, author providers and tool need from the touch-set and commits

Add we:scripts/lib/review-need.mjs: from a PR's changed files and commits, derive the model tier (haiku/sonnet/opus), the author providers (claude/codex/unknown), the provider a mandatory seat must come from, and which lenses need tools. Reuses buildShapePlan and criticalWorkVerdict; no new taxonomy. Surface it on review-core-cli shape --json.

## Progress

Preparation (2026-10-03) verified the inputs this core composes. Nothing is built yet.

- The touch-set already yields subject, care level, reasons and `humanRequired` through `we:scripts/review-core-cli.mjs#buildShapePlan` (line 519), which composes `we:scripts/lib/review-escalation.mjs#scoreEscalation` (line 694) and `we:scripts/lib/decision-routing.mjs#routeReviewShape` (line 701). `classifyReviewSubject` (line 612) fails closed: an empty touch-set is CODE.
- The critical predicate already exists: `we:scripts/lib/critical-work.mjs#criticalWorkVerdict` (line 135) flags gate-self, statute, irreversible (CI, deploy), security paths, human-required, `risk: high` and the `security` tag. An empty file list is critical (`unknown-scope`).
- Live probe on this checkout (the `shape --files=<f> --json` subcommand of we:scripts/review-core-cli.mjs, and `criticalWorkVerdict`): a backlog card is `none`/`prose`/not critical; `we:docs/agent/testing.md` is `code` and critical (statute); `we:scripts/lib/auto-land-seam.mjs` is `elevated` with gate-derivation and critical (gate-self); `we:scripts/operations/review-seat-caps.mjs` is not critical; `we:.github/workflows/ci.yml` is critical (irreversible).
- Commit authorship is readable today. Claude: `we:scripts/lib/ai-pr-authorship.mjs#isAiCommit` (line 30). Codex: delivery commits carry `Co-Authored-By: Codex <noreply@openai.com>` from `we:scripts/operations/deliver-item-wrapper.mjs#coAuthorTrailerFor` (line 1993); orchestrated Codex jobs write a `Written by Codex (...)` body line instead (for example commit e1c7feeb9). The last 200 main commits carry 35 Codex trailers, 49 Claude trailers and 4 `Written by Codex` lines. Merge and drain bookkeeping commits are already filtered by `isMechanicalMergeCommit` (line 91) and `isDrainBookkeepingCommit` (line 138).
- The "protected list" in the operator's target has no single home on main yet. Its parts on main are the critical-work groups above. The judge protected list proposed by 5062 is still in open PR #3771; see Follow-ups.

Implementation proof (2026-10-03):

- Before: the new focused suite failed to resolve the absent module; the existing CLI suite passed all 53 tests. `git cat-file -e origin/main:we:scripts/lib/review-need.mjs` (with the repository alias removed for Git) also confirmed the module is absent on origin/main.
- After: Vitest on we:scripts/lib/__tests__/review-need.test.mjs and we:scripts/__tests__/review-core-cli.test.mjs passed all 114 tests (47 core, 67 CLI). Regressions cover malformed/missing scope and commits, operative prose, both authorship stamps, bookkeeping filtering, CLI JSON and text output, and the existing empty-input refusal (exit 2).
- Compatibility: loaded the original HEAD version of we:scripts/review-core-cli.mjs in memory and compared 10 touch-sets across four care overrides; all 40 plans retained byte-identical serialized pre-existing fields after removing the additive `need` field.
- Mutation proof: temporarily replaced the critical predicate branch in we:scripts/lib/review-need.mjs with `if (false)`. The core suite failed 14 tests, including the CI gate file we:.github/workflows/ci.yml and empty-list cases; restored the original branch before final verification. The we:scripts/lib/auto-land-seam.mjs case correctly remained Opus through its independent gate-derivation trigger.
- Final gate: `node we:scripts/verify-lane.mjs` (repository alias removed when executing) passed 5,314 tests across 80 files and ran `npm run check:standards`: zero errors, 5,274 warnings. No tests or gates were weakened.
- Live proof uses `gh pr view <n> --json state,files,commits`, passing its file paths via `--files` and its unchanged JSON via `--commits-file=/dev/stdin` to `we:scripts/review-core-cli.mjs shape --json`; no helper files.

Live merged PR #3810:

```json
{
  "tier": "haiku",
  "tierReasons": [
    "inert-prose"
  ],
  "needsTools": {
    "correctness": false,
    "security": false
  },
  "authors": [
    "claude"
  ],
  "authorsKnown": true,
  "crossProvider": {
    "required": "codex",
    "satisfiedBy": null,
    "reason": "Claude or unknown authors: require a Codex seat"
  }
}
```

Live merged PR #3800:

```json
{
  "tier": "sonnet",
  "tierReasons": [
    "standard-review"
  ],
  "needsTools": {
    "correctness": true,
    "security": true
  },
  "authors": [
    "codex"
  ],
  "authorsKnown": true,
  "crossProvider": {
    "required": null,
    "satisfiedBy": "claude-mandatory-seats",
    "reason": "Codex-only authors: Claude mandatory seats cross providers"
  }
}
```

Live merged PR #3507:

```json
{
  "tier": "opus",
  "tierReasons": [
    "critical:never-spot-check: gateSelf"
  ],
  "needsTools": {
    "correctness": true,
    "security": true
  },
  "authors": [
    "claude",
    "codex",
    "unknown"
  ],
  "authorsKnown": false,
  "crossProvider": {
    "required": "codex",
    "satisfiedBy": null,
    "reason": "Claude or unknown authors: require a Codex seat"
  }
}
```

## Design

New pure module `we:scripts/lib/review-need.mjs`. No fs, no process, no clock. It composes existing derivations and adds only the routing table.

```js
export const REVIEW_TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);
export const AUTHOR_PROVIDERS = Object.freeze(['claude', 'codex', 'unknown']);

/** @returns {Array<'claude'|'codex'|'unknown'>} one or two providers per commit, sorted, de-duplicated. */
export function authorProvidersOfCommit(commit)

/** Union over substantive commits (merge and drain bookkeeping commits skipped). [] when no commits are given. */
export function authorProvidersOfPr(commits)

/**
 * @param {{ shapePlan: ReturnType<buildShapePlan>, critical: ReturnType<criticalWorkVerdict>,
 *           commits?: object[] | null }} o
 * @returns {{ tier: 'haiku'|'sonnet'|'opus', tierReasons: string[],
 *             needsTools: Record<string, boolean>,
 *             authors: string[], authorsKnown: boolean,
 *             crossProvider: { required: 'codex'|null, satisfiedBy: 'claude-mandatory-seats'|null, reason: string } }}
 */
export function deriveReviewNeed({ shapePlan, critical, commits })

/** Convenience: runs scoreEscalation + routeReviewShape + criticalWorkVerdict over the list, then deriveReviewNeed. */
export function reviewNeedFor({ changedFiles, commits, careLevel, tags, risk })
```

**Tier rule** (first match wins; each match adds a reason string):

1. `opus` when `critical.critical`, or `shapePlan.humanRequired`, or any reason starts with `gate-derivation`. An empty or unreadable touch-set is critical (`unknown-scope`), so it lands here. This is the fail-closed direction.
2. `haiku` when `shapePlan.subject === 'prose'`, `careLevel === 'none'` and not critical. Only inert prose qualifies, for example backlog cards and research notes. Operative prose (`we:docs/agent/**`, `we:AGENTS.md`, skill sources) is already CODE or critical, so it never reaches Haiku.
3. `sonnet` otherwise. This matches today's `JUDGE_MODEL` (`we:scripts/operations/review-pr.mjs:794`).

**Tool need:** `needsTools[lens] = shapePlan.subject === 'code'` for each mandatory lens (correctness, security). Prose PRs need no execution. Code PRs keep tools on both seats, which is today's behaviour (`REVIEW_JUROR_TOOLS`, `we:scripts/operations/review-pr.mjs:792`).

**Author providers:** for each commit, from `authors[]`, `messageBody` and `messageHeadline`:

- `codex` when a co-author or trailer names Codex (`/co-authored-by:\s*codex\b/i`, `noreply@openai.com`), or a body line matches `/^written by codex\b/im`;
- `claude` when `isAiCommit(commit)`;
- `unknown` when neither matches, for example a human-only commit.

A commit can carry both providers.

**Cross-provider rule:** when `authors` is non-empty and every entry is `codex`, set `required: null` and `satisfiedBy: 'claude-mandatory-seats'`, because the two Claude mandatory seats already come from another provider. In every other case set `required: 'codex'`: any Claude commit, any unknown commit, and missing commits (`authorsKnown: false`). Unknown is treated like Claude, so the extra seat is added, never dropped.

**CLI surface:** `review-core-cli shape --json` adds a `need` field computed with `commits: null`, so `authorsKnown` is false. It also accepts an optional `--commits-file=<gh pr view --json commits output>`. The human-readable output gains one line, `tier: <tier> (<reasons>)  tools: <lens=bool,...>  cross-provider seat: <codex|none>`. All existing fields stay byte-identical.

## MVP

The module, its unit tests, and the `shape` CLI field. No caller changes: 4880, 4374, 4973 and 4875 consume this. Delivery is one incremental PR behind `main`; it is additive and changes no live behaviour.

Tasks: (1) write `authorProvidersOfCommit`/`authorProvidersOfPr` with fixtures taken from real trailers in `git log origin/main`; (2) write `deriveReviewNeed` and `reviewNeedFor`; (3) wire `need` into `buildShapePlan`'s output and the `--commits-file` flag; (4) run the tests and the gate.

## Test plan

- (RED today) New `we:scripts/lib/__tests__/review-need.test.mjs`:
  - tier table: card-only gives haiku; `src/_data/*.json` gives sonnet; a plain `scripts/` change gives sonnet; `we:scripts/lib/auto-land-seam.mjs`, `we:docs/agent/testing.md`, `we:.github/workflows/ci.yml`, a `secrets` path, `risk: 'high'` and the `security` tag each give opus; an empty list gives opus;
  - `needsTools`: prose false on both lenses, code true on both;
  - commit fixtures: a Claude trailer; a Codex trailer; a `Written by Codex` body; both trailers on one commit; a human-only commit; a merge commit (skipped); a drain bookkeeping commit (skipped); a GitHub-truncated headline;
  - cross-provider: Codex-only authors give `required: null`; Claude, mixed, unknown and `commits: null` each give `codex`.
- (RED today) Extend `we:scripts/__tests__/review-core-cli.test.mjs` (the `#3335 buildShapePlan` describe at line 331): `need` is present, existing keys are unchanged, and `--commits-file` is parsed.
- (RED today) **Must on error:** an unreadable, empty or malformed touch-set, or a commit list that is not an array, must give `tier: 'opus'` (or the stricter cross-provider value). It must never give `haiku` and never `required: null`. A test feeds each case.
- (RED today) **Must for non-code:** docs, config, data and statute prose are never Haiku unless they are inert prose with care `none` and no critical reason. Tests use `we:docs/agent/*.md`, `we:AGENTS.md`, `we:skills-src/*/SKILL.md`, `src/_data/*.json` and `we:.github/**`.

## Proof plan

Run Vitest on we:scripts/lib/__tests__/review-need.test.mjs and we:scripts/__tests__/review-core-cli.test.mjs. Mutation check: flip the opus rule's `critical` test to `false`; the gate-file and empty-list cases must fail. Live check: run `gh pr view <n> --json files,commits` for three real merged PRs: one Claude-authored card-only PR, one Codex-authored `scripts/` PR, and one gate-touching PR. Pipe each into `review-core-cli shape --json --commits-file=…` and paste the three `need` objects here. The tiers should be haiku, sonnet and opus, and the cross-provider values `codex`, `null` and `codex`.

## Done when

1. Vitest on we:scripts/lib/__tests__/review-need.test.mjs passes. It fails on `origin/main`, where the module does not exist.
2. `review-core-cli shape --json` emits `need` for a real PR. The three live outputs above are recorded on this card.
3. `npm run check:standards` passes.

## Follow-ups

- Testing lesson: we:scripts/review-core-cli.mjs emits structured refusal JSON on stdout, including for exit 2. CLI refusal tests must inspect that output. Ordinary inert documentation can qualify for Haiku under the existing subject router; operative documentation remains covered by strict non-Haiku regressions.

- When 5062 (judge protected list, open PR #3771) lands, add its list as one more opus reason. Reuse its export; do not keep a copy.
- Tier thresholds are policy. Moving them into we:scripts/lib/dispatch-routing-policy.json belongs to the policy-dimensions epic #4376 once that has a home for review rules.
