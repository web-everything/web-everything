---
bornAs: x4ujrqz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-06"
preparedAgainstSha: "75c39659a06fefd7ee76fb1af223d53880109a25"
tags: []
---

# Prevention — Add a prepare-brief or planning-gate check: when a card introduces a hard-error standards rule, the car… (from chalbert/web-everything#3685 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4800-prevention-add-a-check-standards-rules-that-fails-when-a-prep.md` — Add a prepare-brief or planning-gate check: when a card introduces a hard-error standards rule, the card must run the rule against the current corpus and either name a sequenced reconcile item or a baseline allowlist. A review lens can enforce this until a gate exists.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3685@b122542042d0bbb1337fde8a5444b57e1623becf

## Progress

- **Old premise / scope:** `scope:` named card 4800 (a different card, cited by a stale slug). That is the sibling guard "reject prepared cards that supersede their own scope rationale", not this item's subject.
- **Corrected scope:** the pure rule and its wiring live in `we:scripts/check-standards-rules.mjs` (sibling card lints `findGuardRelaxationGaps` line 972, `findTestPlanGaps` line 1014, `findMustWithoutDoneWhen` line 1091, wired in `lintBacklogItemRendering` lines 1195–1236); tests go in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` (existing sibling describes at lines 679 and 784).
- **Premise check:** `git log -S4722` and `bornAs 4722` show no delivering commit; a search of `we:scripts/check-standards-rules.mjs` finds no detector for "hard-error rule without corpus reconcile". Not already delivered.

## Design

Add a pure `findHardErrorRuleReconcileGaps(body)` to `we:scripts/check-standards-rules.mjs`, next to `findGuardRelaxationGaps`, and call it from `lintBacklogItemRendering` beside the guard-relaxation block (line ~1229). It follows that sibling's contract: scan only the card top (break at `## Design` / `## Test plan` / `## Progress`, exactly like `findGuardRelaxationGaps` l.980), skip fenced code, split into sentences, return `[{ kind, detail }]` (`[]` = no gap).

Trigger: one sentence that both names a new rule/check/lint and says it is a hard error (`hard error`, `hard-error`, `fails check:standards`, `exits non-zero`, `err(`). Satisfied only when the same top region has a corpus phrase (`against the (current )?corpus` or `corpus run`) AND either `baseline allowlist` / `allowlist` or a `reconcile` word with a `we:backlog/<id>` ref. A bare `baseline`, a bare `#NNN`, or a bare backlog ref never satisfies it. Otherwise return one gap `missing-corpus-reconcile`.

Reported as a WARNING for open/active cards only, like its siblings: the resolved corpus predates the rule and the prose trigger is heuristic. The message tells the author to run the rule against the current corpus and name a sequenced reconcile item or a baseline allowlist (model: `we:scripts/readiness/check-standards-scope-replay-baseline.json`).

## MVP

**Must:**

1. The pure detector with the trigger and satisfy conditions above, fenced code ignored.
2. Wiring into `lintBacklogItemRendering` as an open-card-only warning.
3. Tests per the Test plan.

**Out of scope** (see Follow-ups): promoting the warning to a hard error, a prepare-brief line, a script that actually runs the rule against the corpus.

## Test plan

In `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`:

- Hard-error card with no baseline/allowlist/reconcile ref → one `missing-corpus-reconcile` gap. Red today: the function does not exist.
- Same card saying it ran against the current corpus and names a baseline allowlist → `[]`. A card with only the bare word `baseline` or only `#123` still yields the gap. Red today: no function.
- Same card saying it ran against the corpus and citing a reconcile item `we:backlog/<id>` → `[]`. Red today: no function.
- A card whose top uses the word `rule` with no hard-error phrase → `[]`. GREEN today; mutation: widening the trigger to bare `rule` makes it fail.
- Trigger text inside a fenced block → `[]`. GREEN today; mutation: dropping the fence skip makes it fail.
- `lintBacklogItemRendering({ item, body })` puts the message in `warnings` for an open card and not a resolved one. Red today: no warning exists.
- This card's own body (hard-error text only below `## Design`) → `[]`. GREEN today; mutation: scanning past `## Design` makes it fail.

## Proof plan

Run `npm run check:standards` on the lane with a throwaway card in the corpus that says it adds a hard-error rule and names no reconcile: the new warning appears. Add a corpus run plus baseline allowlist mention: the warning disappears. Delete the throwaway card afterwards. Also run the full gate on the real corpus and report how many existing open cards the warning hits (expected: few), so the baseline noise is known before shipping.

## Follow-ups

- Promote the warning to a hard error once the open-card hit count is zero.
- Add a one-line check to `we:skills-src/conveyor/prepare-item-agent-brief.md` telling the preparer to run any new rule against the corpus.
- A script that executes a card's named rule against the corpus and lists the hits.

## Done when

1. **Executable** — `npm run test:unit -- -t "findHardErrorRuleReconcileGaps"` (new describe in we:scripts/__tests__/check-standards-rules-content-lint.test.mjs) fails before this lands (function missing) and passes after (Musts 1-3).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
