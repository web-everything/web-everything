---
bornAs: xpd5nhi
kind: epic
parent: "2445"
status: open
dateOpened: "2026-10-08"
tags: []
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
