---
kind: task
status: open
scope: ["we:scripts/lib/settings-cascade.mjs", "we:scripts/lib/__tests__/settings-cascade.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# ST1 no-sensitive-settings Tier-1 test lands with the last ST1 slice

Add a Tier-1 test that no sensitive setting is exposed, landing with the last ST1 slice (21:58 PM ET 2026-11-20). ST1 slice 2 dispatches after #7267 merges.

## Acceptance

- [A1] **Executable** — Planned `rejects sensitive settings in Tier 1` in `we:scripts/lib/__tests__/settings-cascade.test.mjs`: Load the Tier-1 fixture with sensitive settings; assert rejection, while a clean Tier-1 fixture passes.
- [A2] **Executable** — Planned `lands Tier-1 fixture with final ST1 slice` in `we:scripts/lib/__tests__/settings-cascade.test.mjs`: Assert the final slice includes the no-sensitive-settings fixture and retains the slice-2 dependency on #7267.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No expansion of Tier-1 exposed settings.

## Edge cases this change must handle

1. **Untrusted text** — Setting values remain inert fixture data.
2. **Truncated reads** — Incomplete tier output cannot prove absence of sensitive settings.
3. **Shared state files** — Use isolated settings fixtures.
4. **Fail closed** — Any sensitive Tier-1 exposure fails the test.
5. **Identity scoping** — Check the Tier-1 surface explicitly.
6. **State over time** — Keep the test with the final ST1 slice.
7. **Who wrote it** — Assert emitted settings rather than a declaration of safety.

## Duplicate admission

new card from build-queue CARD line
