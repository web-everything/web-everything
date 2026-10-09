---
bornAs: xtxbr56
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "830e38bebf867d9a4b8dba24577e9526f13f5388"
tags: []
---


# File the prevention guard(s) owed by chalbert/web-everything#2929's independent review

Make the existing backlog classification guard strictly reject invalid `kind` values. The approval review requested required-field/schema enforcement using the retired `workItem` name; the current required field is `kind`. Missing values already fail, but falsy non-string values bypass the enum check. Preserve the original prevention goal by closing that demonstrated gap in the existing validator.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2929@71ae1ee3bfef12cb812f572fdf9b1ddd19cacca3

## Progress

- **Original premise/scope:** the two mechanically filed review findings both requested a strict JSON-schema check for required `workItem` across `we:backlog/*.md`, citing `we:backlog/4470-builder-builds-only-prepared-cards-unprepared-ones-get-a-pre.md:2`. Scope contained only that card. Line 2 is `bornAs`, not a validator; its classification is already `kind: story` on line 3.
- **Corrected premise:** `we:scripts/check-standards-rules.mjs:220` documents the merged classification axis; its required-field loop at line 370 already requires `kind`, and its enum check at line 381 already rejects unknown truthy values. `we:scripts/check-standards.mjs:815` invokes this validator for each loaded backlog item. Thus requiring the retired field or introducing a parallel schema would duplicate/conflict with the current contract. The remaining prevention defect is strictness: `false` and `0` evade both the missing-field check and the truthiness-guarded enum check.
- **Observed evidence (2026-10-01):** an in-memory Node probe of `validateBacklogItem` using an otherwise valid open item returned no errors for `kind: false` and `kind: 0`; absent, null and empty-string values produced missing-field errors; `bogus` produced an invalid-kind error; `task` passed. The loader preserves raw classification values through its frontmatter spread at `we:src/_data/backlog.js:390`, so these are representable YAML inputs, not merely unreachable JavaScript fixtures.
- **Re-prepare (2026-10-09, stale stamp):** defect re-confirmed on current `main` (HEAD 830e38beb). Citations moved: the kind enum `BACKLOG_KINDS` is now `we:scripts/check-standards-rules.mjs:236`; the required-field loop is at line 375; the truthiness-guarded enum check `if (item.kind && !BACKLOG_KINDS.has(item.kind))` is at line 386; the gate calls `validateBacklogItem` at `we:scripts/check-standards.mjs:851`; the loader's `...data` spread is at `we:src/_data/backlog.js:402`. Design, MVP, tests and proof plan are unchanged.
- **Corrected scope:** change `we:scripts/check-standards-rules.mjs` and extend its existing matching test `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`. The cited #4470 card, loader, and gate wiring need no edits. Preparation only; no implementation or stamp is included.

## Design

Use the existing `validateBacklogItem` required-field and enum checks as the single classification contract. Keep the missing-value diagnostics for absent, null, and empty-string `kind`. For every other value, check membership in `BACKLOG_KINDS` without a truthiness precondition; reject non-string values, including boolean false and numeric zero. Set membership already requires exact string identity, so no coercion, trimming, fallback to `workItem`, or new vocabulary is needed.

Keep diagnostics item-specific and consistent with the existing invalid-kind message. Do not emit a second invalid-kind error for values already diagnosed as missing. The existing `we:scripts/check-standards.mjs` loop propagates these findings as errors; no second schema engine or alternate validation route is needed.

## MVP

Deliver strict required-classification validation in the existing guard plus regression coverage. All six current `BACKLOG_KINDS` strings remain accepted with otherwise valid kind-specific metadata. Absent/empty classification and every non-member value fail, even when a legacy `workItem` value is supplied.

This is the corrected scope of the two duplicate review findings. A closed JSON schema for every frontmatter property, unknown-key rejection, other field-type hardening, malformed-YAML handling, and classification migrations are outside this demonstrated defect.

## Test plan

Extend `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs` against the real exported validator:

- **RED before the fix (the only cases that fail today):** `false` and `0` must produce an invalid-kind finding, both as direct fixtures and as unquoted YAML parsed through `gray-matter` (below).
- **Controls (already green today; regression coverage, not RED):** `true`, nonzero numbers, arrays, objects, unknown strings, whitespace-only strings and wrong-case names are rejected with an invalid-kind finding; absent, null and empty-string `kind` give the missing-field finding and no duplicate invalid-kind finding; `workItem: story` cannot substitute for missing `kind`.
- Message safety: the invalid-kind message renders the value with `JSON.stringify` (inline, no new import), so an object, array or multiline string kind stays on one line; assert that for an object and a multiline string.
- Accept every current enum string using complete valid fixtures (including story sizing and grouping requirements); keep the existing investigation regression intact.
- Parse small in-memory YAML frontmatter samples through the already-used `gray-matter` dependency, then validate the resulting data to prove unquoted `false` and `0` reach this check with their original types. No persistent backlog fixture is necessary.

Run the focused test, then the existing real-backlog regression in `we:scripts/__tests__/check-standards.test.mjs` and `npm run check:standards`. No browser or runtime demo changes are involved.

## Proof plan

Before changing the validator, add the false/zero regression cases and run the focused test: those cases must fail because the current function returns no classification error. After the change, rerun the identical cases and retain the passing output together with the valid-kind controls.

For command-level proof, use a disposable checkout containing an otherwise valid temporary backlog task. Run `npm run check:standards` with its `kind` set to `false`, then `0`, then `task`; require an item-specific invalid-kind diagnostic and nonzero exit for the first two, and no classification finding for the control. Keep all other fixture content identical, remove the fixture afterwards, and distinguish unrelated baseline gate failures from this item's result. Do not mutate the live queue or daemon.

## Edge cases this change must handle

1. Untrusted text — the invalid-kind message interpolates raw frontmatter; render the value with `JSON.stringify` inline (no new import, `foldUntrusted` not needed, scope unchanged) so newlines are escaped; tested for an object and a multiline string kind.
2. Truncated reads — n/a: pure in-memory validator, no `gh`/`git` reads.
3. Shared state files — n/a: no state file is written.
4. Fail closed — any non-string or non-member `kind` (false, 0, true, arrays, objects) is an error, never silently accepted; absent/null/empty keeps the missing-field error with no duplicate invalid-kind error.
5. Identity scoping — n/a: findings are keyed by the item's own id; `workItem` must not substitute for `kind`.
6. State over time — n/a: stateless per-run check.
7. Who wrote it — n/a: grants no trust.

## Follow-ups

No additional work is required to close this bounded classification defect. A general closed-schema migration would require a separate inventory of accepted frontmatter and an explicit compatibility contract; this card neither mandates that migration nor restores `workItem`. If implementation exposes another independent field-validation defect, record its concrete reproducer separately rather than silently widening this scope.

## Done when

1. The focused test in `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs` demonstrates RED before the fix and GREEN after it for YAML false/zero classification values (the other cases are green controls).
2. The real gate rejects both malformed classifications with item-specific diagnostics and continues to accept valid `kind` values without requiring `workItem`.
3. The existing real-backlog regression and `npm run check:standards` pass, with no unrelated frontmatter migrations.
