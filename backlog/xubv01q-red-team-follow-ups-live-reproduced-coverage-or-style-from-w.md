---
kind: story
size: 2
status: open
scope: ["we:skills-src/providers/SKILL.md"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7265 (head dd625f50b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7265 (reviewed head `dd625f50b385a0ab6565815855488729a97885d7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/providers/SKILL.md:16` — (failing-input, degraded) The prescribed Gemini coding route violates the skill’s own permission rule.
   - Scenario: Input: “Claude quota is low; hand this coding task to agy.” Line 12 requires we:scripts/gemini-direct-task.mjs, but its normal coding mode unconditionally adds --dangerously-skip-permissions, contradicting line 16. A read-only probe of buildAgyDirectTaskArgv() confirmed that flag in the generated arguments. The only flag-free mode is --review, which denies writes and cannot perform the coding task. The skill should provide a permission-compatible route or explicitly identify this route as unavailable under its prohibition.
   - Class: live-reproduced (basis: Directly invoked the prescribed wrapper’s pure argument builder and observed --dangerously-skip-permissions in its default output. No provider was launched; the reproduced failure is the new skill’s contradictory routing instructions, not a newly introduced wrapper vulnerability.)
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
