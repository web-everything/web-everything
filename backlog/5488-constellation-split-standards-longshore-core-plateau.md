---
bornAs: xpd5nhi
kind: epic
parent: "2445"
status: open
dateOpened: "2026-10-08"
tags: []
relatedTo: ["5785", "8629", "8628", "8627", "8634"]
preparedDate: "2026-11-20"
---

# Constellation split: standards, Longshore core, Plateau

Split the web-everything repo by what each part is: web standard definitions and conformance go to everstandards, the delivery machinery becomes the Longshore open core (longshoreai), and every other piece of implementation goes to Plateau. Operator ruled all seven split decisions (S1-S7) on 2026-10-08; this epic carries the rulings and the migration steps as slices. Plan: operator handoff note plan-code-backlog-split-opus.

Parent: #2445 (Plateau Loop extract), not #5407. This epic is the physical extraction of the delivery machinery out of WE, which is #2445's goal; #5407 is about the protocol content of the Delivery standard and is a sibling under #2445.

## Rulings (operator, 2026-10-08 ~18:00 ET)

- **S1 Backlog record** — one backlog per repo. Longshore holds the tooling and the default git-files store; Plateau is an optional hosted combined index, never where cards live. Confirms #3129's declared destination.
- **S2 Longshore packaging** — one repo, several packages (start: @longshore/kit, @longshore/backlog, core). **S2+** — also publish one all-in-one meta package depending on the others.
- **S3 Conformance runner** — the runner and the web rule pack (WE conformance) live in everstandards with no Longshore dependency; each standard has its own rule pack. The delivery rule pack ships with Longshore and runs on every managed repo, WE included.
- **S4 Consumption** — WE consumes Longshore as a pinned npm package, linked locally in dev. **Addition:** ALL implementation in WE that does not go to Longshore moves to Plateau. WE keeps zero implementation: definitions plus validate/conformance tooling only (the runner and web rule pack go to everstandards per S3).
- **S5 History** — keep full history (filter-repo) after a clean secret scan; fall back to a squashed fresh start plus a pointer if the scan finds anything.
- **S6 Licence and visibility** — Longshore is Apache-2.0, public after the daemon switch-over and a clean secret scan.
- **S7 Which cards move** — all cards by topic, resolved included, old numbers kept as aliases.

### Where these rulings are recorded

The S1–S7 rulings remain recorded lineage. Related decisions now carry prepared proposals dated 2026-11-20; those proposals are not ratification and still require the operator call and any statute amendment. Each card below should cite this epic at ratification:

- #5403 (licence) — S6 answers it: Apache-2.0, public after the switch-over and a clean scan.
- #5410 (open line) — S6 is consistent with its default; the line itself stays open.
- #3129 (per-repo backlog, resolved) — S1 confirms it and adds Plateau as an optional index only.
- #5404 (re-home delivery standards) — S3 places the conformance runner and web pack in everstandards and the delivery pack in Longshore.
- #2446 / #5402 (engine home; separate repo now or incubate) — S2 and the step order answer both: incubate as packages inside WE, then extract to one Longshore repo.
- #5405 (names) and #5409 (governance) — untouched by these rulings; the org names come from the slug plan.

## Slices (dependency order)

Step numbers follow the plan. Steps 0a, 0b and 1 can start in parallel. Nothing before the mirror creates a new repo.

| Step | Card | Size | Blocked by |
|---|---|---|---|
| 0a | #5502 repo identity registry + guard (reused, in PR #4506) | 5 | — |
| 0a | #5503 migrate slug call sites (reused, in PR #4506) | 8 | #5502 |
| 0b | #3533 locus on every id (reused) | 5 | — |
| 1 | #5481 ownership map, re-classified under S4 | 3 | — |
| 1 | #5482 boundary guard (ratchet) | 3 | #5481 |
| 2a | #5489 split rules into web / backlog / delivery packs | 8 | #5482 |
| 2b | #5485 shared helper kit | 5 | #5482 |
| 2c | #5487 daemon entry points out of skill folders | 5 | #5482 |
| 2d | #5483 declared entry module for plateau-app | 3 | #5482 |
| S3 | #5490 standalone conformance runner + web pack | 5 | #5489, #5485 |
| 3 | #5491 daemons read coreRoot | 3 | #5487 |
| 3 | #5492 move into Longshore packages with shims | 8 | 2a–2d, #5491 |
| S2+ | #5496 package manifests + all-in-one meta package | 2 | #5492 |
| 4 | #5493 private mirror via filter-repo + secret scan | 5 | #5492 (+ #5502 once PR #4506 lands) |
| 5 | #5494 dual-run passes, verify, review, fix | 5 | #5493 |
| 5 | #5495 dual-run build-dispatch, drain last | 5 | #5494 |
| 6 | #5497 flip: WE consumes pinned @longshore | 5 | #5495, #5496, #5490 |
| S6 | #5499 Apache-2.0 + public | 2 | #5497 |
| 7 | #5484 Plateau-bound code to plateau-app | 5 | #5481, #5483 |
| 8 | #5486 formerly alias + redirect stubs | 3 | #3533 |
| 8 | #5500 move cards by topic | 5 | #5497, #5484, #5486 |
| 8 | #5498 split skills, agent docs, memory | 5 | #5497 |
| 9 | #5504 org rename runbook (reused, in PR #4506, held) | 3 | #5503 |

Related, not re-filed: #5407 (Delivery standard: the protocol content Longshore implements), #2472 (multi-repo registry), #3963 (real multi-repo conveyor), #2158 (FUI checkout in the WE site build), #186 (legal review).

## Acceptance

- [A1] **Executable** — n/a: an epic. Done when every slice above is resolved: WE holds only standard definitions plus conformance, Longshore and plateau-app hold the rest, and each repo has its own backlog.
- [A2] Every step ships alone and can be reverted, as each slice's rollback states.

## Non-goals

- [N1] Choosing the org move date (#5504 stays held for the operator).
- [N2] Ruling #5405 names or #5409 governance.

## Update 2026-11-20 (D1, decisions page)

Ask: Build the new core in Longshore, switch old jobs one at a time after comparison, and keep shared data shapes in Ship's specs. Confirm whether a bare Longshore repo may start now while Ship shapes wait.

### Digest

Prepared, not ratified. The end-state and move-plan research yields two forced invariants: **hybrid migration** and **one normative home for Ship-observable shapes**. These amend the earlier WE-incubation sequence; S1–S7 above retain their lineage. No public flip is authorized.

### Fork 1 — Transition architecture

Forced invariant: stable interfaces must not freeze legacy shapes.

- (a) Clean rewrite with one cutover: without tap/shadow evidence it lacks equivalence proof; with that evidence it becomes (c). Same-day flips remain a schedule setting.
- (b) Move WE scripts with shims (#5492 → #5497). *Excluded:* preserves labels as state, append-order ledgers, startup-frozen settings and the `we` hub default as canonical interfaces.
- (c) **Hybrid (default): end-state kernel in Longshore; legacy roles go tap → shadow diff → flip → delete.** Port pure modules; preserve C1–C3 async-fixer work. Legacy shapes live only in `adapters/legacy-we`.

Evidence:
- `longshore-end-state-2026-11-20` §2.2–4; `we:scripts/lib/merge-gate-ci.mjs:49` and `we:scripts/conveyor/decide.mjs:7` show legacy assumptions.
- [Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html), [legacy displacement](https://martinfowler.com/articles/patterns-legacy-displacement/), [GitHub Scientist](https://github.com/github/scientist), fetched 2026-11-20.
- Per-role flip requires zero unexplained shadow action diffs (ci-heal: 24 h), declared intended differences in its ADR, replay of tapped events, crash/371-break harness and tested rollback. Delete old readers only after the flip holds.

Skeptic: SURVIVES-WITH-AMENDMENT; removed timing-based rejection of (a), which composes with (c). Screen: clear after separating architecture from schedule.

### Fork 2 — Who owns shared contract shapes

Forced invariant: two normative homes invert the standard/implementation boundary.

- (a) **Ship owns WorkItem, Claim, Verdict, Policy, Handoff, Role/Authority and envelope bindings (default); Longshore pins them.** Longshore authors may draft directly in Ship. Engine-internal store/scheduler/adapter interfaces, PluginManifest, FlowEngine and conformity schemas may land now. Classify Run against #5348; classify authority-register/claim-generation fields against Ship modules.
- (b) Longshore defines contracts and Ship standardizes later. *Excluded:* engine choices harden into the standard. The draft engine `pass|refuse|unknown` already differs from Ship's researched `pass|fail|unknown`.

Evidence:
- `2026-11-20-ship-benchmark` §1, §5; `2026-11-20-es-adopted-norms` SE-VRD-001; #5407 protocol drafts.
- `longshore-end-state-2026-11-20` §1.2; operator settings `standards.shipFirst` (20:55) and `longshore.moveNowWithConformity` (20:56).

Skeptic: SURVIVES-WITH-AMENDMENT; gates Ship shapes, not every schema or who drafts first. Screen: clear.

### Supported by default

- Bare bootstrap, minimal seed, conformity tool, sim copy and pure ports may start now; use `x-status: pending` placeholders for absent Ship shapes.
- Hybrid step 5 (kernel ci-heal in shadow) emits claims/verdicts and waits on #5407 drafts; track it as #8638, blocked by #5407.
- Seq-only order, three gate outcomes, per-tick snapshots, one scheduler per tenant and drain-last remain engineering defaults. Capacity: #8628; store: #5785.

### Must-hold rules from the threat-model red team

- Missing/unmatched decisions count as diffs; tap-off soaks are invalid.
- Switches start fresh review rounds; import holds as commands, never old approvals.
- Switch/rollback requires logged authorized commands; unreadable registers refuse.
- Pin Ship shapes, suites and norm schemas by commit and content hash; no network schema-reference lookups.

Details: `_redteam-format-group`.

### What ratifying unlocks

Amend #5492/#5497 into pure-port and per-role flip slices, start D2's tool-first plan, and gate Ship-emitting kernel work on drafts. “D1 yes” accepts (c)/(a).

### Trust boundary and threat model

Tap and forge records are untrusted, snapshotted per soak; shadow execution never writes to the forge. Ratifying this card runs nothing.

Full prep (Standards decisions-prep set):

```text
D1-5488.md
```

## Update 2026-11-20 (D2, decisions page)

Ask: Confirm tool first, then self-contained ports, then jobs one at a time. Copies do not reduce WE CI time until a job switches.

### Digest

**No real fork: tool → pure modules → role executors.** Tool-first is the operator invariant; daemon-first lacks a pure decide/fold. The measured `we:scripts/conveyor/decide.mjs` closure is 516 files / 188,094 lines. Ordering ports by closure is scheduling.

### Supported by default

- Order: bootstrap/seed → conformity → sim → replay-substrate (1 file/64 lines), pr-event-feed (2/713), policy-cascade (3/405), run-store (12/2,843) → pure decide after WE tap and planReconcile split → role flips (ci-heal first, drain last).
- Copies until flip; WE takes no Longshore dependency beforehand. S5 keeps filter-repo after clean secret scan, squashed fallback.
- Retain no-IO, replay/same-log-same-actions, crash/unknown-input and latency/cost checks. Tool custody is #8627.

### First five PRs and CI effect

Bootstrap commit is PR 0. All are in Longshore:
1. Minimal seed: Node 22 ESM/JSDoc, workspaces, test CI, README/AGENTS/Apache licence (private), ADRs 0001–0004; workflow ADR pending. PluginManifest is engine-internal.
2. Conformity T1–T9 fixtures, initially red.
3. Conformity implementation and its internal schemas; strict profile; committed read-only WE baseline. Depends on seed, not Ship contracts.
4. Sim copy in `packages/sim`, provenance and ratchet for its 8 top-level lets.
5. Pure ports under `ports/we/`, secret scan, provenance and staging baseline; promote only at zero blocking findings.

These copies save **0 WE CI minutes**. Longshore CI estimate is 1–2 min, to measure. Each flip removes its WE tests; full #5497 estimate reduces test-shard to one 3–4 min shard and WE PR wall time from 19–20 to about 7 min. These are move-plan estimates, not new measurements.

Evidence:
- `longshore-move-plan-2026-11-20`, `longshore-conformity-tool-prep`, `longshore-end-state-2026-11-20` §1.8/4.
- [ESLint suppressions](https://eslint.org/docs/latest/use/suppressions) and [ArchUnit freezing](https://www.archunit.org/userguide/html/000_Index.html) §8.6 ground only-shrink baselines (fetched 2026-11-20).

Defaults: orchestrator bootstrap under delegated authority; waivers ≤90 days with card/reason; warn >500 lines, block new files >1,000. WE tap and seq ordering remain separate WE work.

Skeptic: SURVIVES-WITH-AMENDMENT; corrected CI estimate, dependency argument and schema placement. Screen: sequencing, not a merit fork.

### Must-hold rules from the threat-model red team

- Inherit D1's logged authorized switch/rollback, fresh rounds and imported holds.

Details: `_redteam-format-group`.

### What ratifying unlocks

File bounded build cards for PRs 0–5 after D1. “D2 yes” confirms order; existing move approval is not requested again.

### Trust boundary and threat model

WE scanning is host-side/read-only without credentials in Longshore CI. Staged copies remain untrusted until secret scanning; never publish `ports/`.

Full prep (Standards decisions-prep set):

```text
D2-5488.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-adopted-norms.md
2026-11-20-ship-benchmark.md
D1-5488.md
D2-5488.md
_redteam-format-group.md
longshore-conformity-tool-prep.md
longshore-end-state-2026-11-20.md
longshore-move-plan-2026-11-20.md
```
