---
bornAs: x9syioh
kind: decision
size: 3
status: active
scaffoldedBy: "r327-cards-ab-lane-26-fb353f00"
dateScaffolded: "2026-11-01"
dateOpened: "2026-11-01"
tags: []
---

# Require a linked prepared card before elevated or high-care builds start

Builds at elevated or high care (daemons, gates, guards) need a linked card with a `preparedDate` before the brief writer or the build dispatcher starts them. This includes work that comes from operator rulings or design notes. Motivated by #6033: a daemon build driven from a design note with no prepared card, which took 7+ red-team rounds (see [#7582](/backlog/7582-decide-the-fate-of-6033-overlay-generation-s1-keep-and-card/)). Operator ruling R327 (2026-11-01): "Do as suggested". This card is policy only. Mechanics live in the build child `7591`.

## Acceptance

- [A1] **Executable** (after the child lands) — a test shows an elevated-care brief with no prepared linked card is refused, and the same brief is accepted once a prepared card covering its files is linked. Test path is the child's.
- [A2] **Observable** — the real brief writer, given the files of #6033's build, refuses after the change and produced a brief before it. A dispatch dry-run holds an elevated card that carries only a filing-time operator-task stamp. Before/after pairs in the child PR.

## Non-goals

- [N1] No bypass flag, waiver or operator override. Urgent work files a card and gets a same-session prepare.
- [N2] Low and no-care work is unaffected.
- [N3] Cards already covered by the dispatcher's existing hold for unprepared cards are not re-prepared.

## Edge cases this change must handle

1. **Untrusted text** — a claimed prepared status in a brief or PR body counts for nothing; only the card file on main counts.
2. **Truncated reads** — a missing or unreadable card means "not prepared": refuse.
3. **Shared state files** — n/a: read-only against the backlog on main.
4. **Fail closed** — no declared files, or an unreadable card, is treated as elevated care with no prepared card: the work is held and routed to `/prepare`.
5. **Identity scoping** — the card must cover the files the work touches (Fork 2).
6. **State over time** — a stamp older than the existing freshness window, or whose scope files changed since it was stamped, is stale, by the same rule the dispatcher already uses; one definition for both entry points.
7. **Who wrote it** — operator-originated and agent-originated work are gated the same way.

## Digest and verdict

**Verdict: go.** The dispatcher already holds a card with no truthful `preparedDate`. Two doors still bypass that: (1) the brief writer renders a brief from free-text purpose and files with no card link at all, and (2) a card filed as an operator task is stamped prepared at filing without a full prepare. Work that comes from a ruling or design note walks through either. #6033 walked through the first. The existing care dial reads the diff, so it exists only after a build; the delta is a care estimate before build and one prepared-card rule shared by both doors.

## Trust boundary and threat model

**Adversarial.** A brief's purpose/files text, a card's claimed link, PR bodies, and the operator-task flag (card front matter any author can write).
**Trusted.** Only the card file on main: its stamp, the commit it was stamped against, its scope; and the brief's declared files, compared as path prefixes. Nothing is executed.
**Failure sources.** (T1) A brief that under-declares its files so the work reads as low care. (T2) A forged card link. (T3) A prepared card with a very wide scope used to unlock anything, or a scope path written to escape its prefix. (T4) An operator-task stamp standing in for a design.
**Controls.** T1: the files are checked at start from the declaration and again at PR open from the real diff (Supported by default); until the second check ships, T1 stays open and the build child must say so. T2: the card is resolved by id from main. T3: Fork 2's width limit, applied to normalized paths. T4: Fork 1. Out of scope: an actor who edits main directly.
**Design red-team:** see the Skeptic lines and the recorded red-team run.

## Fork 1 — do operator-task stamps count as prepared at elevated or high care

*Fork-existence:* a filing-time operator-task stamp validates Design, MVP, Done-when, Edge cases, Test plan and Proof plan sections (the "Complete operator task briefs" section of the backlog workflow). It does not require forks, a pre-mortem, a skeptic pass, a fresh-context screen, or a threat model, and the flag itself is front matter any author can write. For daemons, gates and guards, "prepared" would then mean "briefed", which is the failure being fixed. Counting them is the excluded branch at these bands.

| Option | Description | Verdict |
|---|---|---|
| (a) | Yes, a filing-time stamp is enough everywhere. | Excluded at elevated and high. |
| **(b) default** | No at elevated and high: they need a full `/prepare`. At low and none the existing stamp still works. | Keeps the fast path for small work. None on merit. |

**Default: (b).**
Skeptic: SURVIVES-WITH-AMENDMENT - 'briefed is not prepared' beat the stamp-is-enough attack; amended to cite the sections the stamp does and does not require and that the flag is author-writable front matter.
Screen: clear - rigor of preparation vs speed is a merit/correctness call.

## Fork 2 — what "linked" means

*Fork-existence:* if any prepared card unlocks any work, the gate is satisfied by name only, and a prepared small card could unlock an unrelated daemon build. Name-only linking is the excluded branch.

| Option | Description | Verdict |
|---|---|---|
| (a) | Any prepared card id on the brief. | Excluded. |
| **(b) default** | The card's scope must cover every file the work touches and must be bounded and narrow, so no broad scope can unlock unrelated work. A ruling or design note is recorded as the card's origin, never accepted as the link itself. | Ties permission to the actual files, and a design owns a bounded surface. |

**Default: (b).**
Skeptic: SURVIVES-WITH-AMENDMENT - file-covering links beat the name-only attack; amended with a depth and entry-count width limit and normalized paths.
Screen: clear - name-only vs file-covering is a merit call.

## Supported by default (not forks)

- **Both doors, one rule.** One shared rule runs where the work starts (from declared files) and again at PR open (from the real diff). Each alone leaves a hole: start-only trusts declarations, PR-open-only spends the build first.
- **Care band rule.** Work is elevated or higher if it touches a daemon, a gate, a guard, a statute path or a human-required path (the paths the review rules already treat as needing a human). No declared files means elevated and held for `/prepare`, because an unstated scope is the case this card exists to catch, and guessing low would reopen the door. The band is derived once from these files by this rule; the existing diff-based care dial is unchanged.
- **Statute composition.** A refusal here is a route to `/prepare` (the same destination as the dispatcher's existing hold for unprepared cards), never a hard block with no way forward, so it complies with `#blast-radius-advisory-care-not-a-gate` ("gate means route to a human"); the care band only selects which work needs the prepared card and does not decide a land verdict. Independence of the preparer follows `#agent-convergence-independent-validation`.
- Rulings and design notes are inputs to a card, never a substitute: they state a decision, not the invariants and test plan that prepare produces.

## Pre-mortem

1. **False elevated**: routine work routed to prepare. Guard: only the named path classes raise the band; "no files declared" holds the work and asks for files, it does not guess.
2. **Hand-typed briefs skip the start check.** Guard: the PR-open check from the real diff catches elevated work with no prepared card; this is the backstop and is in scope.
3. **Prepare becomes a rubber stamp to unlock builds.** Guard: the preparer's skeptic and screen are separate agents, and the sibling card on break-family stops (`7592`) catches PRs that still do not converge.
4. **Stale stamps** unlock changed code. Guard: the shared freshness rule.
5. **Rollout window**: until the PR-open check is enforcing, T1 stays open. Named; the child reports it.

## Test and proof plan

- **Rule coverage** for each case the policy distinguishes: band, card state, scope coverage and width, staleness, operator-task stamp.
- **Replay on #6033.** The files #6033's build declared (from #7582's inventory), with no linked card, must be refused. The same files with a prepared fixture card whose scope covers them and is narrow must pass. The fixture is a test card, not #7582 (which is a decision, not a build card).
- **Live before/after** with the real brief writer and a dispatch dry-run on those inputs.
- Rollout order and the audit gate are the child's.

## Build child

`7591` holds the mechanics.
