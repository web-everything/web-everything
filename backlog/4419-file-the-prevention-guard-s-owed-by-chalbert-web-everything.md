---
bornAs: xe52oqu
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-backlog-item.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "a0b98a3a8a5cb131567cedd58c4105c3b5874a12"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2876's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:58` — Add a prepare-time checklist item, or a lint on backlog cards that name a new `health-smells/*.mjs` file, requiring a grep of the sibling smells for the same signal.
2. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:2` — A Zod or similar JSON schema validator applied to backlog frontmatter during `npm run check:standards`, enforcing the presence of the `workItem` key with an allowed value (`story`, `epic`, or `task`).

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2876@becb0c99a110c53513c815b0854b5ef24adae5e7

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "sibling smell"` fails before this item lands (the detector does not exist) and passes after.

## Progress

- **Premise check (2026-10-07, main `a0b98a3a8`):** neither guard is delivered as stated, but guard 2 is stale.
  - Guard 2 (`workItem` frontmatter validator): `workItem` no longer exists. The #466/#487 ruling collapsed `type` + `workItem` into one `kind` field (`we:scripts/backlog/migrate-kind.mjs:3-12`). `validateBacklogItem` already errors on a missing `kind` (`we:scripts/check-standards-rules.mjs:374-378`) and on one outside `BACKLOG_KINDS` (`we:scripts/check-standards-rules.mjs:385-386`). **Delivered under a new name; dropped from this card.** The owed debt is closed by this note: the builder records "guard 2 delivered by #487 `kind` validation" in the resolve summary.
  - Guard 1 (sibling-smell grep guard): no lint or prepare checklist mentions sibling smells (grep of `we:scripts/check-standards-rules.mjs` and the prepare briefs finds nothing). Still owed.
- **Scope correction:** old `scope:` pointed at the resolved #4378 card (a citation target, not code this item changes). New scope is the lint host and its test file.

## Design

Add a pure detector `findNewHealthSmellWithoutSiblingCheck({ scope, body, fileExists })` beside `findBuriedForkSections` (`we:scripts/check-standards-rules.mjs:676`). It returns the scope entries that match `^we:scripts/conveyor/health-smells/[a-z0-9-]+\.mjs$`, do not yet exist on disk (a *new* smell; `fileExists` is injected so the test is pure), and whose card body has no line mentioning `sibling smell` (case-insensitive, outside code fences). The smell dir is `we:scripts/conveyor/health-smells/` (auto-discovered by `we:scripts/conveyor/health-smells/index.mjs`), so a new smell is exactly a new scope path there.

The detector strips a leading `we:` before matching, so `we:scripts/...` and bare `scripts/…` both match. Call it from `lintBacklogItemRendering` (`we:scripts/check-standards-rules.mjs:1175`, signature `{ item, body, pocRegistry, knownBacklogIds }`) next to the buried-fork warning (`:1217`). Add an optional `fileExists` parameter whose **default is `() => true`** (fail closed: with no probe supplied the lint never warns, so existing callers and tests are unchanged). Thread a real probe (`existsSync(join(ROOT, path))`; the rules file does not import `existsSync` today, so import it in the callers) through both callers: `we:scripts/check-standards.mjs:964` and `we:scripts/check-backlog-item.mjs:100`. Emit it as a **warning** for `status: open|active` story/task cards, with the message naming the file and the fix: grep the other `health-smells/*.mjs` for the same signal (probe name / threshold) and note the result under a line containing "sibling smells". Warning, not error: the signal is heuristic and existing open cards must not go red. Scope entries are read from `item.scope` (array of `we:`-prefixed paths).

## MVP

Musts only:
- The detector, its call site, and a warning message.
- Tests below.

Out of scope (Follow-ups): the prepare-brief checklist wording, promoting the warning to an error, and checking that the grep was actually done.

## Test plan

Every test name contains "sibling smell" (the Done-when `-t` filter). The quiet cases below each sit beside the flagged control (case 1), so they cannot pass vacuously from an always-empty detector.

- *flags a new smell file with no sibling note* — scope `[we:scripts/conveyor/health-smells/new-x.mjs]`, `fileExists` false, body without "sibling smell" → one hit. RED before: the function is not exported.
- *quiet when the body has a "sibling smells" line* — same scope, body "Sibling smells grepped: none overlap." → no hit.
- *quiet when the file already exists* — `fileExists` true → no hit (editing an existing smell is not a new one).
- *quiet for unrelated scope paths* — `we:scripts/conveyor/health-watch.mjs` and a `__tests__/` path under health-smells → no hit.
- *a note inside a code fence does not count* — "sibling smell" only in a fenced block → still flagged.
- *wired into the lint* — `lintBacklogItemRendering` on an open task with the flagged scope emits the warning; a resolved one does not.

## Proof plan

Run `node we:scripts/check-backlog-item.mjs <n>` (the scoped per-item validator, `npm run check:item`) on a throwaway card in the lane naming `we:scripts/conveyor/health-smells/proof-only.mjs` in `scope:` — show the warning appears; add a "Sibling smells grepped" line — show it disappears. Then run the full `npm run check:standards` (heavy-admission, via the package script) before and after, capture the output to a file in the lane, and show the backlog warning lines are identical (`diff` empty apart from this card).

## Edge cases this change must handle

1. **Untrusted text** — n/a: card body and scope are only pattern-matched, never reach a shell, argv, path join or regex built from them; the file name is echoed into the warning message only after the strict `[a-z0-9-]+\.mjs` match.
2. **Truncated reads** — n/a: reads local files only; no `gh`/`git` call.
3. **Shared state files** — n/a: pure detector, writes nothing.
4. **Fail closed** — an unreadable or non-array `scope` yields no hits (no lint), not a throw; `fileExists` failing is treated as "exists" so a read error never raises a false warning.
5. **Identity scoping** — n/a: keyed on the card's own scope entries; both `we:`-prefixed and bare repo-relative spellings are matched.
6. **State over time** — a smell that lands later exists on disk, so the warning self-clears on the card that built it.
7. **Who wrote it** — n/a: the lint grants no trust; it only nudges.

## Follow-ups

- Add one line to the prepare briefs' edge-case checklist for new smells (touches the brief rule ledger, so a separate item).
- Promote the warning to an error once the existing backlog stays clean for a release.
