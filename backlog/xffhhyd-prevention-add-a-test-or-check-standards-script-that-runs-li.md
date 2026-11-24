---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-claim-store.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs", "we:scripts/lib/__tests__/authorized-push-s1c.test.mjs", "we:scripts/conveyor/__tests__/fix-claim-store.test.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/push-gate-hold-refusal.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test or check:standards script that runs listFixDispatchClaimsStrict over a corpus of produ… (from web-everything/web-everything#7442 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-claim-store.mjs:127` — Add a test or check:standards script that runs listFixDispatchClaimsStrict over a corpus of production-shaped legacy entries, expired and kind-less. Alternatively, validate shape only for entries that are live and treat expired legacy entries as ignorable. Run the gate's dry probe against the real store in the verify lane.
2. `we:scripts/conveyor/fix-procedure.mjs:712` — Add a test for double fix-begin --draft on the same claim (same identity, PR already draft by this claim) that states the intended push-gate outcome. Preserve a sidecar whose identity hash still matches the current claim when the PR is already draft.
3. `we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs:21` — Make the static guard also flag the substring 'authorized-push-factory' in any non-__tests__ file, with an explicit allowlist for the soak breaks.
4. `we:scripts/conveyor/fix-claim-store.mjs:139` — Add a strict-scan test with a regular file, a dotfile and an entryless dir in the root, and decide explicitly whether each is ignored or named in the refusal.
5. `we:scripts/lib/__tests__/authorized-push-s1c.test.mjs` — Add a public-entry test that passes an extra key (labels, state, head) to both exported functions and expects bad-input. Make the live probe a recorded soak assertion instead of a manual step.
6. `(no file cited)` — Add a deterministic acceptance-to-test manifest check requiring every acceptance guarantee to reference a named implemented test or, for preparation reviews, a concrete planned test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7442@ae2c1199d53cc2b5507f18d3847d13478819630a

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
