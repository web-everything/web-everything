---
kind: story
size: 8
status: open
blockedBy: ["xdjrqkz"]
scope: ["we:scripts/operator/dispatch.mjs", "we:scripts/operator/converge.py", "we:scripts/operations/land-advance-io.mjs", "we:scripts/workflows/review-parked-prs.mjs", "we:scripts/review-ledger-check.mjs", "we:scripts/conveyor/status-artifact.mjs", "we:scripts/lib/swept-repos.json", "we:scripts/lib/poc-branches.json", "we:scripts/broadcast-inject.mjs", "we:scripts/lib/marker-authorship.mjs", "we:scripts/operations/land-advance.mjs", "we:scripts/operations/record-verdict-io.mjs", "we:scripts/conveyor/session-verdicts-io.mjs", "we:scripts/lib/poc-branches.mjs", "we:.github/workflows/ci.yml", "we:.github/workflows/deploy.yml", "we:.github/workflows/update-visual-baselines.yml", "we:.github/workflows/codex-sandbox-proof.yml"]
dateOpened: "2026-10-08"
tags: []
---

# Migrate hardcoded repo slugs to the repo identity registry, daemon paths first

Once the registry exists, move every live hardcoded org/repo slug onto it in three risk batches: daemon paths first (operator dispatch and converge, land-advance, review-parked-prs, the legacy alias copies), then CI workflows, then prompts, plist examples and skill text. Shrinks the guard allowlist to zero. Sibling repos plateau-app and frontierui get their own follow-up.

## Batches (inventory 2026-10-08)

1. **Breaks daemons** — `we:scripts/operator/dispatch.mjs` (10 literals, incl. `gh pr checks/edit/run` calls), `we:scripts/operator/converge.py` (11), `we:scripts/operations/land-advance-io.mjs` (3 `gh --repo` calls), `we:scripts/workflows/review-parked-prs.mjs` (a second copy of the repo table), `we:scripts/review-ledger-check.mjs` and `we:scripts/conveyor/status-artifact.mjs` (`DEFAULT_REPO`/`REPO` constants), `we:scripts/lib/swept-repos.json`, `we:scripts/lib/poc-branches.json`, `we:skills-src/drain/review-park-state.json`.
2. **Breaks CI** — `actions/checkout repository:` for frontierui in `we:.github/workflows/ci.yml` (6), `we:.github/workflows/deploy.yml` (3), `we:.github/workflows/update-visual-baselines.yml`, `we:.github/workflows/codex-sandbox-proof.yml` (still `chalbert/web-everything`). Use a repo variable (`vars.FUI_REPO`) set once per org, since workflow YAML cannot import JS.
3. **Cosmetic / agent text** — agent prompts and briefs in `we:skills-src/` (fix, CI-heal, review, stuck-PR briefs; free-scope, finish, pr-reconcile, progress-board skills), plist `.example` clone URLs, `we:scripts/lib/converge-daemon-schedulers.mjs` doc link. Render the slug from the registry where text is generated; leave historic backlog cards, reports and agent memory as they are.

## Acceptance

- [A1] **Executable** — the guard's allowlist from #xdjrqkz is empty and `npm run check:standards` passes.
- [A2] Batch 1 lands first, in its own commit, and is proven live: one review-daemon pass, one fix-dispatch pass and one land-advance dry run each show the slug coming from the registry (log line or `--json` field), before vs after.
- [A3] With a test-only registry override that renames the WE owner, the batch-1 call sites emit the new slug (unit test, no network).
- [A4] Follow-up cards are filed for plateau-app (`plateau-app:scripts/lib/repo-slugs.mjs`, `plateau-app:vite.config.mts`, `plateau-app:src/wip/`, its workflows) and frontierui (`fui:.github/workflows/ci.yml`, `fui:src/_data/site.js`), each reading one declared setting instead of copies.

## Non-goals

- [N1] No rename and no remote rewrite of lanes or daemon clones (that is the runbook, #xmkjis9).
- [N2] Historic records (backlog cards, reports, run records, agent memory, gh-etag cache) are not rewritten; readers handle old names through the alias table.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — prompts that embed the slug get it from the registry, never from PR text.
2. **Truncated reads** — n/a: static config only.
3. **Shared state files** — ledgers already key on internal repo keys (`we#123`); no ledger format changes.
4. **Fail closed** — a call site that cannot resolve a slug refuses the `gh` call instead of falling back to a literal.
5. **Identity scoping** — each call site names its repo by key, so a FUI daemon never resolves the WE slug.
6. **State over time** — the CI repo variable must exist before the YAML switches; batch 2 checks it first.
7. **Who wrote it** — n/a: no authored records.
