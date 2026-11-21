---
bornAs: xpd5nhi
kind: epic
parent: "2445"
status: open
dateOpened: "2026-10-08"
tags: []
relatedTo: ["5785", "8629", "8628", "8627", "8634"]
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

No sanctioned ruling path applies yet: the related decision cards are not prepared (no `preparedDate`), and ratifying needs prepare, red-team and a statute anchor. So the rulings are recorded here, and each card below should cite this epic when it is prepared and ratified:

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

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.
Decision id: D1 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

### Digest / context

Proposed amendment, not a recorded ruling: build the new end-state kernel directly in Longshore, then migrate roles one at a time. This replaces the earlier “incubate as packages inside WE, then extract” sequence above if ratified; S1–S7 remain historical lineage. Source: [handoff end-state design](designs/longshore-end-state-2026-11-20.md) §1, §3–5. About 60 PRs/day and the legacy-shape risks are source observations, not measurements repeated here.

### Fork 1 — Transition architecture

Fork-existence: the canonical new core cannot both originate in Longshore with legacy only behind adapters and freeze the legacy WE shapes as its canonical package interfaces. Role migration can be incremental under either, so the distinction is the architecture at the boundary.

- (a) Clean rewrite: clean target, but freezes delivery while chasing a moving system.
- (b) Plain progression / WE incubation: smaller moves, but carries label authority, append-order ledgers and startup-only caps.
- (c) **Hybrid (default): end-state kernel in Longshore, legacy roles in WE until tap → shadow diff → flip → delete.** Preserve ongoing C1–C3 work; port useful pure modules instead of rewriting them.

Skeptic: A parallel kernel can diverge indefinitely. Require replay fixtures, declared intended differences, zero unexplained shadow action diffs and per-role rollback; adapters are deleted after each successful flip.
Screen: pending a fresh preparation pass on this architectural amendment; it is not a standards-format ruling.

What ratifying unlocks: an amended extraction sequence, ci-heal first and drain last, keeping the target quality bar and existing delivery active. Operator answers: “D1 yes” accepts (c), without authorizing a public flip.
Prep still needed: compare strangler/rewrite precedents, reconcile #5492/#5497 dependencies and run an independent skeptic/screen. This update preserves existing card status; no new prepared stamp is claimed.

## Update 2026-11-20 (D2, decisions page)

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.
Decision id: D2 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

### Digest / supported by default

The page records a 20:56 yes to moving code measured by the conformity tool; the move plan/order remains outstanding. **Tool first → pure modules → daemons (default).** This is sequencing, not a rival architecture. The agent must bring the first five PRs and their CI effect; no plan is represented as completed here.

Context: [handoff end-state design](designs/longshore-end-state-2026-11-20.md) §2–4 lists port candidates (decide, foldProjection, policy-cascade, run-store/feed, simulator) and proposes seed/contracts, WE decision tap, seq ordering, pure-core port and shadow ci-heal as its first five steps. These are source proposals; reconcile them with the page’s tool-first order rather than claim they are the final five PRs.

Supported by default: tool → modules → role executors; tool ownership/interface is D17. Alternatives (module-first, daemon-first) are possible sequencing settings but do not waive conformity and equivalence. The default retains kernel no-IO, replay, crash/unknown-input and latency/cost checks; no bulk copy of WE scripts.

Skeptic: Tool-first can become an infrastructure detour. Scope it to executable end-state checks exercised by the first port, then show the first five bounded PRs and measured CI effects.
Screen: pending prep; sequence is priority/dependency work, not a standards merit fork.
What ratifying unlocks: a concrete tool-first move plan aligned with D1. Operator answers: “D2 yes” confirms this order; the already recorded move approval is not re-requested.
Prep still needed: survey existing conformity tools, inventory exact pure-module dependencies, reconcile the five-step sketch and run an independent skeptic pass. No runtime moves occur in this cards-only task.
