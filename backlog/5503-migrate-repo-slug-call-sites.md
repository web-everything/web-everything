---
bornAs: x8d6s6j
kind: story
size: 8
status: open
blockedBy: ["5502"]
scope: ["we:scripts/lib/repo-slug-allowlist.json", "we:scripts/operator/dispatch.mjs", "we:scripts/operator/converge.py", "we:scripts/operations/land-advance-io.mjs", "we:scripts/workflows/review-parked-prs.mjs", "we:scripts/review-ledger-check.mjs", "we:scripts/conveyor/status-artifact.mjs", "we:scripts/lib/swept-repos.json", "we:scripts/lib/poc-branches.json", "we:.github/workflows/ci.yml", "we:.github/workflows/deploy.yml", "we:.github/workflows/update-visual-baselines.yml", "we:.github/workflows/codex-sandbox-proof.yml", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:skills-src/conveyor/stuck-pr-inspect-brief.md", "we:skills-src/review/review-agent-brief.md", "we:skills-src/free-scope/SKILL.md", "we:skills-src/finish/SKILL.md", "we:skills-src/pr-reconcile/SKILL.md", "we:skills-src/progress-board/SKILL.md", "we:skills-src/conveyor/com.we.conveyor-pass-daemon.stuck-pr-watch-we.plist.example", "we:skills-src/conveyor/launchd/com.we.build-dispatch-daemon.plist.example", "we:skills-src/conveyor/launchd/com.we.fix-dispatch-daemon.plist.example", "we:skills-src/conveyor/launchd/com.we.health-watch.plist.example", "we:scripts/lib/converge-daemon-schedulers.mjs", "we:scripts/operator/__tests__/repo-resolution.test.mjs", "we:scripts/operations/__tests__/land-advance-repo-resolution.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Migrate hardcoded repo slugs to the repo identity registry, daemon paths first

Once the registry exists, move every live hardcoded org/repo slug onto it in three risk batches: daemon paths first (operator dispatch and converge, land-advance-io, review-parked-prs; the legacy alias copies are already done by #5502, which owns those files), then CI workflows, then prompts, plist examples and skill text. Shrinks the guard allowlist to zero. Sibling repos plateau-app and frontierui get their own follow-up.

## Batches (inventory 2026-10-08)

1. **Breaks daemons** — `we:scripts/operator/dispatch.mjs` (10 literals, incl. `gh pr checks/edit/run` calls), `we:scripts/operator/converge.py` (11), `we:scripts/operations/land-advance-io.mjs` (3 `gh --repo` calls), `we:scripts/workflows/review-parked-prs.mjs` (a second copy of the repo table), `we:scripts/review-ledger-check.mjs` and `we:scripts/conveyor/status-artifact.mjs` (`DEFAULT_REPO`/`REPO` constants), `we:scripts/lib/swept-repos.json`, `we:scripts/lib/poc-branches.json`. (The first inventory also named a drain review-park state file; it is not a tracked file and holds no slug literal, so it is dropped.)
2. **Breaks CI** — `actions/checkout repository:` for frontierui in `we:.github/workflows/ci.yml` (6), `we:.github/workflows/deploy.yml` (3), `we:.github/workflows/update-visual-baselines.yml`, `we:.github/workflows/codex-sandbox-proof.yml` (still `chalbert/web-everything`). Use a repo variable (`vars.FUI_REPO`) set once per org, since workflow YAML cannot import JS.
3. **Cosmetic / agent text** — agent prompts and briefs (`we:skills-src/conveyor/fix-agent-brief.md`, `we:skills-src/conveyor/fix-agent-ci-brief.md`, `we:skills-src/conveyor/stuck-pr-inspect-brief.md`, `we:skills-src/review/review-agent-brief.md`, `we:skills-src/free-scope/SKILL.md`, `we:skills-src/finish/SKILL.md`, `we:skills-src/pr-reconcile/SKILL.md`, `we:skills-src/progress-board/SKILL.md`), the four plist `.example` clone URLs (stuck-pr-watch-we, build-dispatch, fix-dispatch, health-watch), `we:scripts/lib/converge-daemon-schedulers.mjs` doc link. Render the slug from the registry where text is generated; leave historic backlog cards, reports and agent memory as they are.

## Acceptance

- [A1] **Executable** — the guard's allowlist from #5502 is empty and `npm run check:standards` passes.
- [A2] Batch 1 lands first, in its own commit, and is proven live: one review-daemon pass, one fix-dispatch pass and one land-advance dry run each show the slug coming from the registry (log line or `--json` field), before vs after.
- [A3] With a test-only registry override that renames the WE owner, the batch-1 call sites emit the new slug (test `overrideRenamesBatch1Slugs` in `we:scripts/operator/__tests__/repo-resolution.test.mjs`, no network).
- [A4] **Executable** — fail closed. Test `unresolvedRepoDoesNotInvokeGh` in `we:scripts/operator/__tests__/repo-resolution.test.mjs` (covers `we:scripts/operator/dispatch.mjs`, `we:scripts/workflows/review-parked-prs.mjs`, `we:scripts/review-ledger-check.mjs` and `we:scripts/conveyor/status-artifact.mjs`, plus `we:scripts/operator/converge.py` driven through a subprocess with a stubbed `gh` on PATH and the registry lookup forced to return `null` through a test-only env override that converge.py reads) and in `we:scripts/operations/__tests__/land-advance-repo-resolution.test.mjs` (covers `we:scripts/operations/land-advance-io.mjs`): for a missing key, an unknown key, and a registry lookup stubbed to `null`, assert the stubbed `gh` records zero invocations and the entry point exits non-zero. This is the test that fails if a migrated call site keeps a literal fallback.
- [A5] **Executable** — identity scoping. Test `fuiKeyNeverYieldsWeSlug` in the same `we:scripts/operator/__tests__/repo-resolution.test.mjs`: resolving the `frontierui` key (and an unknown key) at every batch-1 call site, the six entry points named in [A4] included, never returns the `we` slug, and a FUI-keyed run never passes the WE slug to `gh --repo`.
- [A6] Follow-up cards are filed for plateau-app (`plateau-app:scripts/lib/repo-slugs.mjs`, `plateau-app:vite.config.mts`, `plateau-app:src/wip/`, its workflows) and frontierui (`fui:.github/workflows/ci.yml`, `fui:src/_data/site.js`), each reading one declared setting instead of copies.

## Non-goals

- [N1] No rename and no remote rewrite of lanes or daemon clones (that is the runbook, #5504).
- [N2] Historic records (backlog cards, reports, run records, agent memory, gh-etag cache) are not rewritten; readers handle old names through the alias table.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — prompts that embed the slug get it from the registry, never from PR text.
2. **Truncated reads** — n/a: static config only.
3. **Shared state files** — ledgers already key on internal repo keys (`we#123`); no ledger format changes.
4. **Fail closed** — a call site that cannot resolve a slug refuses the `gh` call instead of falling back to a literal (tested by [A4]).
5. **Identity scoping** — each call site names its repo by key, so a FUI daemon never resolves the WE slug (tested by [A5]).
6. **State over time** — the CI repo variable must exist before the YAML switches; batch 2 checks it first.
7. **Who wrote it** — n/a: no authored records.
