---
bornAs: xmy3fl4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-03"
preparedAgainstSha: "0f7d4f1b50b82c6845e8008a312e3e3caab780fc"
tags: []
---

# Prevention — Add a check:standards rule that fails a backlog card whose 'Done when' still contains the 'TODO: a comm… (from chalbert/web-everything#3443 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4767-keep-the-review-across-a-ci-heal-that-leaves-the-pr-own-chan.md:14` — Add a check:standards rule that fails a backlog card whose 'Done when' still contains the 'TODO: a command that fails' placeholder at status open→in-progress. Also require a fail-closed line on cards that loosen a refusal.
2. `we:backlog/4737-review-a-pr-only-once-its-required-checks-are-green-fix-the.md:14` — Standards check on gate-type cards: require an explicit 'on error/unknown, refuse' Must line. Same gate as above.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3443@13db05aa1cbb73df10aa09641b2c30952b064cbc

## Progress

Premise check against current `main` (no commit delivers it; `git log --grep 4858` shows only the card-filing PR #3448):

- **Part 1 (placeholder).** Still open. `check:standards` has no rule on the `TODO: a command that fails` text. The scaffold emits it at we:scripts/backlog/scaffold.mjs:113. The only related check is `resolvedWithTodo`, which lives in the review corpus (we:scripts/review-corpus/__tests__/gates.test.mjs:185) and covers resolved cards only, not the claim moment.
- **Part 1b (fail-closed line on loosening cards).** Already delivered by #4409: `findGuardRelaxationGaps` at we:scripts/check-standards-rules.mjs:972, wired at we:scripts/check-standards-rules.mjs:1228 (WARNING).
- **Part 2 (gate-type cards need an "on error/unknown, refuse" Must).** Still open, but there is no deterministic "gate-type card" signal. See Follow-ups.
- **Scope.** The card's old scope listed the two source cards that were reviewed. The real touch-set is the rule file and its test, so scope is corrected below.
- **Severity evidence.** 9 cards at `status: active` still hold the placeholder today (e.g. we:backlog/4032-wire-ci-heal-s-executed-vendor-gate-predicate-into-we-script.md), so a hard error would redden the gate. Sibling prose rules (#4332, #4409, #4438) are all WARNING.

## Design

Add a pure `findUnfilledDoneWhen(body)` next to `findGuardRelaxationGaps` in we:scripts/check-standards-rules.mjs (near line 972). It finds the `## Done when` section and returns one finding if any line still contains the scaffold placeholder text `TODO: a command that fails` (exact scaffold phrase, so a card that quotes it in prose elsewhere is not hit). Export the phrase as a constant from we:scripts/backlog/scaffold.mjs (beside `GUARD_RELAXATION_HINT`, line 16) and build the scaffold line at line 113 from it, so the scaffold and the rule cannot drift.

Wire it in `lintBacklogItemRendering` (we:scripts/check-standards-rules.mjs:1143), next to the #4409 block at line 1228, firing only when `item.status === 'active'`. `open` is exempt because the scaffold legitimately produces it; `resolved` is exempt as history. Emit a WARNING, matching the sibling prose rules and the 9 existing active cards. The message names the card and says to replace the placeholder with a real failing-then-passing command before building.

## MVP

Musts:

1. `findUnfilledDoneWhen` pure detector, exported from we:scripts/check-standards-rules.mjs.
2. Fires only at `status: active`; silent for `open`, `preparing`, `resolved`.
3. Placeholder phrase shared as one constant between scaffold and rule.
4. Wired into `lintBacklogItemRendering` as a WARNING (shared by the whole-repo gate and the single-item `check-backlog-item` script, which both call it; that script is not edited). Severity is WARNING by deliberate choice, not the card's literal "fails": 9 active cards hold the placeholder today and every sibling prose rule warns.

Out of scope: hard-error severity, part 2 (gate-type "refuse on error" line), cleaning the 9 existing active cards. See Follow-ups.

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "unfilled Done when"` fails before this lands (export missing) and passes after. Covers Musts 1-4.

## Test plan

All in we:scripts/__tests__/check-standards-rules-content-lint.test.mjs, describe `unfilled Done when (#4858)`:

- **Placeholder present → one finding** (capability, RED today: `findUnfilledDoneWhen` is not exported).
- **Real command in Done when → `[]`** (capability, RED today for the same reason).
- **Placeholder only outside `## Done when` → `[]`** (preservation; mutation proof: scan the whole body instead of the section and this case fails).
- **`lintBacklogItemRendering` with `status: 'active'` warns; `open`, `preparing`, `resolved` stay silent** (capability, RED today: no warning exists). Asserts the warning text names the placeholder, not just a non-empty list, so unrelated warnings cannot satisfy it.
- **Build must also run the tests that pin scaffold output** (`we:scripts/__tests__/check-backlog-item.test.mjs`, `we:scripts/__tests__/backlog-cli-snapshot.test.mjs`) — the constant keeps the exact text, so they must stay green. The Done-when `-t` filter must match a describe literally named `unfilled Done when`; a filter matching no test is not a RED.
- **Scaffold output contains the shared constant** (preservation; mutation proof: change the constant's text in the scaffold only and the case fails).

## Proof plan

Live before/after on a real card: run `node we:scripts/check-backlog-item.mjs 4032` (`npm run check:item -- 4032`; the whole-repo gate has no `--item` flag) (an active card with the placeholder) on `main` (no warning) and in the lane (warning names the placeholder). Then run `npm run check:standards` in full and show it still exits 0 with the placeholder warnings appearing only for the active cards.

## Follow-ups

- Part 2 of this card: require an explicit "on error/unknown, refuse" Must on gate-type cards. Needs a deterministic definition of "gate-type" first (tag or kind signal); file as its own item once one exists.
- Promote the placeholder rule from WARNING to error after the 9 existing active cards are filled in.
- Fill the placeholder on those 9 active cards (each is its own builder's job).

## Also raised by

- Also raised by web-everything/web-everything#5493 (finding 1: `we:backlog/6194-fixer-treats-operator-decisions-scope-baseline-and-main-regr.md:31` — Add a check:standards rule that fails when a card whose scope touches scripts/conveyor/ still has 'TODO' on the Untrusted-text or Who-wrote-it edge-case lines, before status can move from open to in-progress.) · key `approval-prevention-key:web-everything/web-everything#5493@3364a0972aa0a6d7b47220c80623103aa4f697c9`
