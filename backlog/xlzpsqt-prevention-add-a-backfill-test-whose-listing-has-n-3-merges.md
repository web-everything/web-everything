---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/change-evidence-writer.test.mjs", "we:scripts/lib/change-evidence/record.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/change-evidence/__tests__/record.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a backfill test whose listing has N≥3 merges, a per-number gh mock, and a total read count ab… (from web-everything/web-everything#7319 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/change-evidence-writer.test.mjs:167` — Add a backfill test whose listing has N≥3 merges, a per-number gh mock, and a total read count above 256, asserting all N records are written. Optionally add a review lens that flags a test title promising scaling or multiplicity while its setup has a single element.
2. `we:scripts/lib/change-evidence/record.mjs:112` — Use `x.actor?.login ?? ''` in the approval filter and add a test with a null-actor labeled event expecting unknown(missing) instead of a throw. A fuzz or fixture test that nulls every optional forge identity field would catch the whole class. This fits the A8c reinforce card.
3. `we:scripts/lib/__tests__/change-evidence-writer.test.mjs:29` — Add a mock-level assertion helper that rejects any gh argv containing a method or field flag. Add a lint rule that forbids `--method`, `-X`, `-f` and `-F` under scripts/lib/change-evidence/.
4. `we:scripts/lib/__tests__/change-evidence-writer.test.mjs:184` — Extract the hook into an exported `runChangeEvidenceHook({DRY_RUN, ...})` and test its throw and no-throw paths. Add a review-lens rule that a stated "never blocks the drain" claim needs a behavioural test.
5. `we:scripts/merge-ai-prs.mjs:8217` — Add a wall-clock deadline to the hook (race it against a timer) and a max-attempts or age cap on pending entries. Track both in the A8c reinforce card before `changeEvidence.mode=on`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7319@ca6f5f23e07dbc1ba8d6a1516d69086acfa55d4d

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
