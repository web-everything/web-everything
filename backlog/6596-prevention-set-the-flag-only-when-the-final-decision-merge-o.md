---
bornAs: x68axhg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/__tests__/merge-ai-prs-prestage.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Set the flag only when the final decision === 'merge', or have the stage loop filter on c.decisio… (from web-everything/web-everything#5480 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6510` — Set the flag only when the final `decision === 'merge'`, or have the stage loop filter on `c.decision === 'merge'`. Add a table test that every non-CI skip reason keeps its reason and its writes while CI is pending.
2. `we:scripts/lib/enqueue-on-event.mjs:492` — Add a settings-contract test that enumerates every consumer of `resolvePrestageSettings` and runs each with the feature off. This is a review-lens or test-plan item, not a script-decidable gate.
3. `we:scripts/__tests__/merge-ai-prs-prestage.test.mjs:44` — Add a CLI case that runs the green-event shortcut with the red-main freeze active and asserts no enqueue call. Longer term, add a check:standards rule requiring any new `--from-*` shortcut in we:scripts/merge-ai-prs.mjs to have a test that does not pass `--no-red-main-freeze`.
4. `we:scripts/merge-ai-prs.mjs:6531` — File a card to bind the whole cached human-trigger basis to `base` and `baseSha`, or to fall back when the live base tip differs from the cached tip. Add a test next to the existing 'base moved under the same name' case that asserts the fallback.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5480@73c60b00fd4a95fcceb0ac05606e7f8c6e790a18

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
