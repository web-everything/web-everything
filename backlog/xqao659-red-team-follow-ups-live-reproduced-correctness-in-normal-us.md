---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7532 (head 34bb53b78)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7532 (reviewed head `34bb53b78426e8657d72eac1906df27a2eaa9052`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/fix-run.mjs:860` — (failing-input, degraded) PR-body truncation still counts incomplete-input runs as model misses
   - Scenario: Use a PR body containing 8,000 filler characters followed by required repair instructions, with a short finding saying to follow the PR body. renderPrContext removes those instructions at its 8,000-character cap, but inputGaps checks only finding truncation. Two no-change runs therefore record cause=model and reach model-miss count 2. The launcher should classify its known PR-body truncation as input loss.
   - Class: live-reproduced (basis: Evaluated the unchanged launcher and renderer with in-memory IO and a provider stub. Both prompts omitted the required detail and contained the truncation notice; both outcomes recorded cause=model. The actual consecutiveUnproductiveOnHead function returned 2.)
   - Also class: correctness-in-normal-use
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
