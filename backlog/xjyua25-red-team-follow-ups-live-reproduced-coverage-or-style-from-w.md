---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/delivery-tier.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7416 (head e4d22f106)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7416 (reviewed head `e4d22f1063e077cb6a44a9840986fa20db78150a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/delivery-tier.mjs:33` — (edge-case, degraded) Nested safety specs fall through to LOW.
   - Scenario: Call classifyTier(['we:src/__tests__/unit/storage-safety.spec.ts'], {settings:{extraHigh:[]}, redMainFix:false, quarantinedTests:[]}). It returns LOW via '**/__tests__/**'. The same filename directly under __tests__ returns HIGH. The new safety rule excludes nested directories, and the fallback safety rule covers only .test.* filenames. Nested safety specs should receive HIGH protection too.
   - Class: live-reproduced (basis: A read-only Node probe reproduced HIGH for we:src/__tests__/storage-safety.spec.ts and LOW for we:src/__tests__/unit/storage-safety.spec.ts with identical options. This is an observed classifier gap; no production caller is enrolled.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
