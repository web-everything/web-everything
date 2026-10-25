---
bornAs: xfxc6sa
kind: story
size: 2
status: open
scope: ["we:backlog/6248-the-verify-operation-prints-a-plain-pass-fail-verdict.md", "we:agent-memory-src/feedback-edge-load-after-review-accept.md", "we:backlog/6259-drain-pass-summary-counts-each-merged-pr-once.md"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5547 (head d10d93bc0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5547 (reviewed head `d10d93bc0252692283be4603392d5b949ad1e6d1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/6248-the-verify-operation-prints-a-plain-pass-fail-verdict.md:13` — (failing-input, degraded) The nine top-priority labels do not change build priority
   - Scenario: Resume the builder with these cards ready and existing priority cards still queued. All nine cards marked 'Priority: top' are absent from we:scripts/settings/build-priority.json. A read-only probe through buildPriorityPlacement returned buildPriorityIndex:null for every one. orderQueueDetailed with equal ready inputs for 6248 and existing priority card 5919 selected 5919 first. The prose labels are not consumed by the ranker. Record the authorized ordering in the build.priority setting so these cards receive the claimed priority.
   - Claude's re-check: demonstrated break
2. `we:agent-memory-src/feedback-edge-load-after-review-accept.md:8` — (edge-case, degraded) The immediate-loading instruction includes daemons that must run main only
   - Scenario: An unmerged drain fix receives acceptance, triggering the instruction to load it immediately. we:platform-decisions.md#resident-daemon-reload-lifecycle explicitly keeps the drain and merge-orphan-sweep main-only. The latter passes mainOnly:true to rebuilding. A read-only planRebuild probe with an accepted-fix overlay and mainOnly:true returned applied:[] and overlays-refused-main-only, leaving main selected. The prescribed immediate load cannot happen through that path. Preserve an explicit exception for main-only landing daemons, which must wait for the merge.
   - Claude's re-check: demonstrated break
3. `we:backlog/6259-drain-pass-summary-counts-each-merged-pr-once.md:13` — (edge-case, degraded) Deduplicating by PR number collapses different repositories' PRs
   - Scenario: One drain pass merges web-everything/web-everything#123 and plateauapp/plateau-app#123. we:merge-ai-prs.mjs supports multiple repositories in one pass and stores merged entries as {repo,num,headSha}. Following the card's prescribed 'count distinct PR numbers' produces 1 for these two entries, although two distinct PRs merged. A direct probe confirmed distinct numeric keys count 1 and repository-qualified keys count 2. Specify deduplication by canonical repository plus PR number and include this case in the required test.
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
