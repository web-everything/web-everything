---
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
| 0a | #xdjrqkz repo identity registry + guard (reused, in PR #4506) | 5 | — |
| 0a | #x8d6s6j migrate slug call sites (reused, in PR #4506) | 8 | #xdjrqkz |
| 0b | #3533 locus on every id (reused) | 5 | — |
| 1 | #xfneuba ownership map, re-classified under S4 | 3 | — |
| 1 | #x3xrhfl boundary guard (ratchet) | 3 | #xfneuba |
| 2a | #xqpz3zp split rules into web / backlog / delivery packs | 8 | #x3xrhfl |
| 2b | #xgwmxd4 shared helper kit | 5 | #x3xrhfl |
| 2c | #xo59v8c daemon entry points out of skill folders | 5 | #x3xrhfl |
| 2d | #x6qkpev declared entry module for plateau-app | 3 | #x3xrhfl |
| S3 | #xgc6mv8 standalone conformance runner + web pack | 5 | #xqpz3zp, #xgwmxd4 |
| 3 | #xw75lku daemons read coreRoot | 3 | #xo59v8c |
| 3 | #xuxad3w move into Longshore packages with shims | 8 | 2a–2d, #xw75lku |
| S2+ | #xs1r68q package manifests + all-in-one meta package | 2 | #xuxad3w |
| 4 | #xgqueiz private mirror via filter-repo + secret scan | 5 | #xuxad3w, #xdjrqkz |
| 5 | #xmoufta dual-run passes, verify, review, fix | 5 | #xgqueiz |
| 5 | #xh1pxjn dual-run build-dispatch, drain last | 5 | #xmoufta |
| 6 | #x2cpivn flip: WE consumes pinned @longshore | 5 | #xh1pxjn, #xs1r68q, #xgc6mv8 |
| S6 | #xnfbsxx Apache-2.0 + public | 2 | #x2cpivn |
| 7 | #x0ymykb Plateau-bound code to plateau-app | 5 | #xfneuba, #x6qkpev |
| 8 | #xizfs72 formerly alias + redirect stubs | 3 | #3533 |
| 8 | #xt5yoze move cards by topic | 5 | #x2cpivn, #x0ymykb, #xizfs72 |
| 8 | #xdfzp4b split skills, agent docs, memory | 5 | #x2cpivn |
| 9 | #xmkjis9 org rename runbook (reused, in PR #4506, held) | 3 | #x8d6s6j |

Related, not re-filed: #5407 (Delivery standard: the protocol content Longshore implements), #2472 (multi-repo registry), #3963 (real multi-repo conveyor), #2158 (FUI checkout in the WE site build), #186 (legal review).

## Acceptance

- [A1] **Executable** — n/a: an epic. Done when every slice above is resolved: WE holds only standard definitions plus conformance, Longshore and plateau-app hold the rest, and each repo has its own backlog.
- [A2] Every step ships alone and can be reverted, as each slice's rollback states.

## Non-goals

- [N1] Choosing the org move date (#xmkjis9 stays held for the operator).
- [N2] Ruling #5405 names or #5409 governance.
