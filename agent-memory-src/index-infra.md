---
name: index-infra
description: This repo’s gates, build, and tooling quirks: check:standards skips the 11ty build, blocks/ has no typecheck gate, build:plugs pollutes the tree, FrontierUI happy-dom test quirks, vite config plugin≠alias, dev ports, write-time enforcement hooks + hookable-vs-judgment, intents.json escaping footgun, bootstrap-patches inject footgun, blocks per-file virtual anchor, dev-panel duplication, explorer report inflation, deliberate NUL sentinels in three committed scripts (plain grep reports nothing). Recall when running gates/tests/builds, grepping the scripts tree, or touching repo tooling.
metadata:
  type: reference
---

Testing · Gates · Build Infra cluster — open a leaf with `node scripts/memory-resolve.mjs <N>` (or `--cat`):

- 34. Explorer Report Inflates Per-State — per-state re-counts same element; dedupe findings.json; #1575
- 43. Enforce Shared Gate At Write-Time — PreToolUse(Edit|Write) hook scans content + denies the write; #883
- 51. Hookable vs Judgment Rule — script-decidable→hook (deterministic); judgment stays in context; footguns first
- 65. webeverything Dev Ports — npm start = Eleventy docs :8080 (/backlog/) + Vite demo :3000
- 112. Dev-Panel Plugin Duplicated — backend DE-DUPED→Plateau (#1579); frontend dev-panel.html still copied/drifted
- 113. Vite Config Plugin ≠ Alias — resolve.alias never rewrites config's OWN plugin imports; share via sibling pkg; #1579
- 118. Bootstrap-Patches Inject Footgun — FUI Vite plugin skips bootstrap inject if a demo names literal /plugs/bootstrap.ts
- 120. intents.json Mixed-Escaping Footgun — never JSON.stringify-roundtrip the whole file; splice changed entries
- 121. Blocks Per-File Virtual Anchor — #882 split blocks.json→blocks/<id>.json; blocks.json#<id>=virtual graduatedTo anchor
- 124. check:standards Skips 11ty Build — gate skips docs build; `npm run verify` when touching templates/_includes/_data
- 125. Blocks/ Has No Typecheck Gate — WE never tsc-checks `blocks/`; type errors ride to FUI's stricter build; #658
- 126. FrontierUI happy-dom Test Quirks — happy-dom: instanceof lies, setters don't reflect; branch on a bool; #870
- [UI change → 3 musts](ui-change-needs-before-after-visual-check.md) — ANY UI/CSS edit: /review-design (#1034) + Playwright before/after + committed test in tests/; not throwaway
- [AI runs regression after each change](ai-runs-regression-after-each-change.md) — agent runs the MATCHING lane (visual/unit/smoke/standards) after edits; git hook is the wrong fit
- [SSR-card dogfood regressed the a11y ratchet](ssr-card-dogfood-regressed-a11y-ratchet.md) — test:a11y NOT in check:standards; #2019 broke 5 enforced routes; fix #2164
- [Local gate green, CI red = untracked artifacts](local-gate-green-ci-red-untracked-artifacts.md) — CI-red/local-green usually = untracked reports/researchTopics; commit them, don't regen; #2160
- [jsdom query cache stale after move](jsdom-query-cache-stale-after-move.md) — querySelectorAll/children lie after in-place insertBefore; assert via childNodes; minimum-move reorders; #2002
- [Dogfood & parity keystones missing](dogfood-and-parity-keystones-missing.md) — both "resolved" themes actually blocked; do #2016 + #2017 first; #1243 shadcn is a stub
- [UI loader ↔ CLI engine field parity](ui-loader-cli-engine-field-parity.md) — backlog.js & engine.mjs derive batchable/tier/filler independently; a rule live in one isn't live in the other; #2014
- [Committed scripts carry deliberate NUL sentinels](committed-scripts-carry-nul-sentinels.md) — `scripts/guard-bash.mjs`, `scripts/backlog/renumber-collisions.mjs`, `scripts/lib/component-render-build-hook.cjs` hold intentional NUL delimiters, so plain `grep` calls them binary and prints NOTHING (exit 1) — use `grep -a`; and `grep $'\x00'` matches EVERY line, so use `grep -P '\x00'`. NOT Write-tool corruption; don't "repair" them
- [Cloudflare deploy state](cloudflare-deploy-state.md) — WE site LIVE+gated on Cloudflare Workers (pivoted off #1135 Pages); auto-deploy unwired; domain held for #2127
- [Never write scratch files under .git/](feedback_avoid_bash_heredoc_file_writes.md) — `.git` is a Claude Code hardcoded protected path, never auto-approved by an allow rule; use a plain path inside the working directory instead, not os.tmpdir(); confirmed live 2026-08-17
- [Cloud VM: git works, the GitHub API does not](workflow-cloud-vm-github-api-boundary.md) — `gh` INSTALLS fine (apt) and still cannot authenticate: GraphQL refused by proxy policy, REST 403 with or without `GH_TOKEN`. Only the session connector holds a working credential; git pushes because the proxy injects into git transport. Also: a fresh clone fetches `main` ONLY, so no `origin/<lane>` tracking ref exists until you widen the refspec
- [Never commit a host-local path](feedback-no-local-paths-committed.md) — no `/Users/<name>/` or `/home/<name>/` in tracked files; reference host resources by NAME resolved on the host via an env var (e.g. `WE_GITHUB_APP_KEY_DIR`); ratchet gate `lint-host-paths.mjs`; operator 2026-10-13
