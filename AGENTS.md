# AGENTS.md — Web Everything

**Canonical agent instructions.** Read by Claude, Copilot, Cursor, and any other agent.
`CLAUDE.md` and `.github/copilot-instructions.md` are stubs that point here. This file is the
**always-loaded router** — keep it small. Detail lives in `docs/agent/` and is read on demand.

## Mental model
**Web Everything** defines browser-aligned standards to unify the web ecosystem. Two layers:
- **Plugs** — core primitives that patch/extend browser APIs (CustomStore, CustomAttribute, InjectorRoot), usable on `window` in **plugged mode** or tree-shakeable in **unplugged mode**. The plugs **runtime is implementation owned by Frontier UI** (`@frontierui/plugs`, ruling [#606](backlog/606-where-does-the-plugs-platform-layer-runtime-live-web-everyth.md)); **WE owns only the plug *contracts*** (`src/_data/plugs.json`) and consumes the runtime as a client in its demos. (The `plugs/` tree here is the vendored copy pending the [#170](backlog/170-plugs-duplicated-across-webeverything-frontierui.md) re-point.)
- **Blocks** — reusable implementations built on plugs (SimpleStore, OnEventAttribute, CallParser), likewise implementation owned by Frontier UI; WE keeps the **block protocols** (the per-block contracts). Imported directly.

**Reach ambition:** the standards are *contracts*, not a JS lock-in. The browser/JS runtime is the first realization, not the only one — the goal extends to making contracts realizable in **any server runtime** (.NET, Java, Go…) so the standard reaches the **enterprise** tier where those stacks live. The lever is **forward (generation) adapters**: one internal source of truth projected *outward* into ecosystem-native code — the inverse of the bottom-up **ingest** adapter (incumbent → internal pivot). *Direction under exploration, not yet ratified* — see decision #463 (polyglot MaaS origin), gated on the canonical JS origin #461.

[Frontier UI](../frontierui/) is the **reference implementation** of these standards. This repo is canonical for shared terminology, naming, **protocols** (conformance contracts owned by a Project, surfaced via `/protocols/`), and **intents** (UX preference vocabularies, surfaced via `/intents/`). Frontier UI points back here.

> **`../plateau/` is the abandoned single-repo prototype** — superseded by this repo + Frontier UI + plateau-app. New implementation work lands in **Frontier UI**, never plateau. You *may* read plateau as a **non-authoritative reference** when nothing more recent exists (a behavioral sketch to adapt), but it is **not a model**: it predates current decisions and may contradict them, so anything taken from it must be re-derived against the live spec/conventions and called out as plateau-sourced — never copy its architecture wholesale. (`plateau-app` is a live product and is fine.)

## The spec data is the source of truth (and "WE" names two things)
`src/_data/*.json` + `src/_includes/*-descriptions/*.njk` are the **source of truth**. Implementation follows documented API. If it isn't documented, document it first. These specs are large — **query one entry at a time** (grep/jq), never load whole.

**Naming (#2006):** "**Web Everything / WE**" = the zero-implementation **standard** (the intent/block/plug/protocol/semantic defs, meta-schemas, conformance gate, backlog). "**the WE website / WE-docs**" = the **product surface** — the 11ty+Vite render that *consumes* those defs, a mis-homed product being extracted (end-state gated on #872; interim `site/**` boundary + fail-closed classifier per constellation rule 1). The spec **data** is WE; the **site** that renders it is not. Don't say "the website is the spec" — it conflates them.

## Hard rules (always apply)
1. **Design-first**: document in JSON/njk before implementing. Respect `designDecisions`; discuss before overriding one.
2. **Naming is enforced**: traits `with[Capability]` (never `use*`), registries `Custom[Name]Registry`, injector domains start with `@`, event attrs `on:event`. Full list → [conventions.md](docs/agent/conventions.md).
2a. **Compose an existing trait — don't hand-roll a covered pattern**: before wiring any interaction, search the trait registry and compose the existing WE trait/behavior (disclosure → `nav:section`, roving focus → `nav:list`); hand-rolling a covered pattern with ad-hoc `addEventListener` is a **conformance defect** the `check:standards` block-drift gate catches. New behavior ships as a *new trait*, never per-block wiring. Statute → [platform-decisions.md#compose-dont-handroll](docs/agent/platform-decisions.md#compose-dont-handroll) (#933).
3. **New terms** introduced by any block/plug/intent **must** be added to `src/_data/semantics.json` (term-first).
4. **Tests required**: 80% coverage minimum across the unit-tested standards/impl planes (`blocks/` + the ~27 planes in `vitest.config.ts` `coverage.include`) — **enforced** via `npm run test:coverage`, wired into `regression` and CI (#2082). Exercise apps (`demos/`), 11ty templates (`src/`), and build tooling (`scripts/`/`tools/`) are gated separately (Playwright/conformance/`check:standards`), not by this bar. Unit/integration `*.test.ts` (Vitest), E2E `*.spec.ts` (Playwright).
5. **Demo edits**: keep the `text/plain#demo-js-source` and the running `type="module"` sections of `demos/declarative-spa.html` in sync.
6. **Browser-support floor is Baseline-2024**: assume modern primitives exist (FACE/`ElementInternals`, popover, `:state()`, `:user-invalid`, anchor positioning). Below Baseline-2024 is **out of scope** — don't shim it by default. Polyfills are an **opt-in enhancement layer** (a plug/trait the consumer adds), never a baseline assumption, so specs stay single-substrate. Decision [#031](backlog/031-polyfill-baseline-floor.md); substrate detail in `reports/2026-06-02-native-platform-substrate.md`.
7. **Prove claims by observation — never assert an untested cause.** Before telling the user something works, is fixed, or is broken-because-X, back it with a **real probe of the running system** (curl the served HTML, drive the browser, run the gate, grep the actual output). "Cache / stale tab / hard-reload / it's just uncommitted" are **hypotheses to test and rule out by observation**, never diagnoses to hand over. If you haven't run the probe, you haven't diagnosed — say "let me check" and check. When a probe itself could be wrong (a guessed key/port/selector), say so rather than presenting an inconclusive run as proof. Full discipline → [testing.md](docs/agent/testing.md#proof-based-verification--observe-before-you-claim).

## Definition of Done (run before finishing)
- Changed an API? Update its `.njk` description **and** its `src/_data/*.json` entry.
- **Added or changed a standard's feature?** Its conformance demo must reflect the **full** feature set — add a shared **fixture/case** for it (demos are fixture-driven, so one fixture updates the demo *and* its unit tests at once). A shipped feature with no demo case is **not done**. See [demo-workflow.md](docs/agent/demo-workflow.md).
- **Changed a rendered page, template, or layout** (`src/*.njk`, `src/_layouts/**`, `src/_includes/**`, `src/css/**`, nav/header/footer)? It must pass the **rendered-site a11y gate** (`@axe-core/playwright` over the route allowlist — `npx playwright test tests/a11y`; #770) and clear the **static template a11y lint** in `check:standards` (#772). Review the structural a11y checklist by hand — axe can't see all of it: **`aria-current="page"`** on the active nav link (#762), landmark regions (`<main>`/`<nav>`/`<header>`/`<footer>`), heading order (one `<h1>`, no skipped levels), focus order + a visible `:focus-visible` ring, and accessible names on controls/links. Contrast cues never rely on colour alone (WCAG 1.4.1).
- Introduced a term? Add it to `semantics.json`.
- Wrote a `reports/*.md` report? It's **outside the 11ty build** — expose it: promote it to a `/research/` topic, or mirror it with a **backlog pointer item** (`relatedReport`, no body). `check:standards` fails on a hidden report (see [backlog-workflow.md](docs/agent/backlog-workflow.md) → "Three homes — nothing stays hidden").
- Added/removed a block, plug, or intent? Run `npm run gen:inventory` (refreshes the generated summary below — never edit it by hand).
- Run `npm run check:standards` — it must pass (it also fails if the inventory is stale).
- Run affected tests (`npx vitest run <path>`); for broad changes, `npm test`.
- Learned something durable (new pattern, gotcha, decision)? Add it to the **specific** `docs/agent/*.md` file it belongs to — not here.
- **Ratified a `type: decision` that establishes (or refines) a reusable rule?** Promote the *rule* into [docs/agent/platform-decisions.md](docs/agent/platform-decisions.md) (or the topical doc it belongs to) and set `codifiedIn:` on the item pointing there — or set `codifiedIn: one-off` for a narrow call with no reusable rule. The decision keeps the *lineage*; the guideline carries the *rule* (don't make the next person re-derive it). `check:health` flag **G6** surfaces resolved decisions still missing `codifiedIn`.

## Where to look (read on demand)

| Task | Read |
|------|------|
| **Where does X live? / a placement, naming, monetization, or WE↔FUI-boundary question** — the standing cross-cutting rulings (the "statute" promoted from ratified decisions). **This doc is the SINGLE source of truth for settled orientation: read & cite its named anchor — do NOT reason from or cite the `backlog/` `#NNN` decision chain unless you need the _history_ (the chain is an archive, not the reference). A missing/stale rule here is a codification gap to fix, not a licence to cite the work item.** | [docs/agent/platform-decisions.md](docs/agent/platform-decisions.md) |
| Naming, glossary, code style, icons | [docs/agent/conventions.md](docs/agent/conventions.md) |
| Writing/changing tests, web cases | [docs/agent/testing.md](docs/agent/testing.md) |
| Plugs/blocks, injectors, registries, parsers, debugging | [docs/agent/architecture.md](docs/agent/architecture.md) |
| Adding a block/plug/intent/adapter, doc requirements, the standard-authoring method | [docs/agent/design-first.md](docs/agent/design-first.md) (Claude: `/new-standard` triggers it) |
| Processing `plans/` → research pages, reports | [docs/agent/research-workflow.md](docs/agent/research-workflow.md) |
| Capturing ideas/issues/decisions/reviews, report open questions → `/backlog/` (one md file per item in `backlog/`; every item needs a `workItem` story/epic/task + Fibonacci `size` on stories/unstoried-epics — feeds the `/backlog/` burndown) | [docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) → "Agile sizing" |
| Picking the next item to work on (dev-ready first) | [docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) → "Selecting the next item to work on" (Claude: `/next-backlog-item` triggers it; `/next decision` surfaces the one call to make) |
| **Driving an item from card to merged** — spawning review that is genuinely independent (a subagent is NOT a second actor), writing a mandate that finds things, the mutation discipline on a fix, and when to stand down instead of iterating | [docs/agent/delivery-loop.md](docs/agent/delivery-loop.md) (`/pr` opens one, `/review` performs one; this is the loop around them) |
| **Building new dispatch/mechanical infrastructure** meant to replace or extend a production path — a new provider, wrapper, or dispatch kind. Park until genuinely exercised end-to-end (passing tests are not evidence it works); the driver+observer live-test pattern, the checklist scorecard, the fix-loop discipline, and the graduation gate | [docs/agent/prototype-based-dev.md](docs/agent/prototype-based-dev.md) |
| Preparing an open decision *ahead* of the call — research + author its forks to "ready to ratify" (no human judgment yet; sets `preparedDate`) | [docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) → "The prepared-fork shape" (Claude: `/prepare` triggers it) |
| Building or changing a runtime demo under `demos/` | [docs/agent/demo-workflow.md](docs/agent/demo-workflow.md) |
| Building a new UI surface (console/board/panel/screen) — the sighted mock → review-pixels → rule-the-forks → webcases method | [docs/agent/build-ui.md](docs/agent/build-ui.md) (Claude: the build-ui skill) |
| **Ruling a high-leverage fork** (a durable, high-fan-out design/decision call) — the jury-refinement method: fresh single-lens panel → expose forks → per-option 1–5 ratings → weak-flag + search → truth-check → red-team → human-gate | [docs/agent/jury-refinement-method.md](docs/agent/jury-refinement-method.md) (Claude: the `/jury` skill runs it) |
| Building/continuing a flagship **exercise app** (#314) — the platform-first loop (WE is primary, the app is a forcing function) | [docs/agent/exercise-app-workflow.md](docs/agent/exercise-app-workflow.md) (Claude: `/exercise-app`) |
| Marking an external reference dead/replaced, or adding a structured reference home | [docs/agent/reference-retirement.md](docs/agent/reference-retirement.md) |
| **Running in a cloud VM** (claude.ai/code, mobile, `claude --cloud`) — shallow clones, no lane pool, siblings attached rather than cloned, and uncommitted work dies with the box | [docs/agent/vm-sessions.md](docs/agent/vm-sessions.md) (`node scripts/bootstrap-session.mjs` reports on a workstation and applies on an ephemeral VM; `… install` is the explicit opt-in) |
| Adding or editing a Claude **skill** — author only `skills-src/<name>/SKILL.md` (git-tracked source; `.claude/skills/` is a symlink to it, `~/.claude/skills/` is a synced copy — never hand-edit either), keep it a trigger+pointer, not a copy of the rubric | [docs/agent/skill-authoring.md](docs/agent/skill-authoring.md) |
| Choosing a **vision capability** — tiny on-device classifier vs. small VLM vs. hosted, and where each runs (the cascade) | [docs/agent/vision-tiers.md](docs/agent/vision-tiers.md) |
| **How an automated writer reaches `main`** — the writer operating model: automation **isolates by default** (clone → `lane/*` → integrator auto-merge), `main` is **convergence-only for automation**, the human is the single trusted writer with direct commit/push; near-term enforcement is **convention** (the serial `/batch` still commits on the current branch per Rule 104 as the interim) + the future server-side **bot-principal** branch rule | [platform-decisions.md#pr-flow-rollout-mechanism](docs/agent/platform-decisions.md#pr-flow-rollout-mechanism) |
| **Manually developing / testing an edit in a lane** — pick a lane, boot its own dev pair (export `.env.local` ports), the FUI-sibling symlink (#1943), rendering via static build | [docs/agent/testing.md](docs/agent/testing.md) → "Developing & manually testing in a lane" |
| Comparing **Claude Code / Codex / Antigravity CLI** capabilities — hooks, permissions, tools, config, models, streams, identity, resume; source evidence and open questions | [docs/agent/agent-cli-capability-map.md](docs/agent/agent-cli-capability-map.md) |
| Dev environment & scripts | `DEV_GUIDE.md` |
| Canonical specs (per-entry) | `src/_data/{blocks,plugs,intents,protocols,semantics,references}.json`; backlog = `backlog/*.md` |

## Repository inventory
<!-- AUTO-GENERATED:inventory — run `npm run gen:inventory`; do not edit by hand -->
- **Plugs** 60 — 31 active · 26 concept · 1 draft · 2 experimental
- **Blocks** 81 — 39 active · 12 concept · 30 draft
- **Intents** 100 — 6 active · 37 concept · 57 draft
- **Glossary terms** 345 · **Research topics** 325 (321 open)
- **Projects** 46: range-anchor, suggested-edit, webadapters, webanalytics, webaudit, webbehaviors, webblocks, webcases, webcharts, webcompliance, webcomponents, webcontexts, webdecisions, webdirectives, webdocs, webediting, webevents, webexpressions, webgraph, webguards, webidentity, webinjectors, webintents, webintl, webisolation, weblayout, weblifecycle, webmanifests, webnotifications, webplugs, webpolicy, webportals, webpositioning, webprocess, webrealtime, webregistries, webreliability, webreporting, webresources, webrouting, webstates, webtheme, webtraces, webtraits, webvalidation, webworkflows
<!-- /AUTO-GENERATED:inventory -->

## Commands
```bash
npm start                 # Vite (3000) + 11ty (8080); browse http://localhost:3000
npm test                  # unit + integration (Vitest)
npm run test:integration  # E2E (Playwright; needs npm start)
npm run check:standards   # consistency & convention checks — part of Definition of Done
npm run check:app-conformance  # exercise-app platform-conformance benchmark (--app=demos/<id> [--json --strict])
npx @11ty/eleventy        # build docs site (verify page count after adding research)
```
