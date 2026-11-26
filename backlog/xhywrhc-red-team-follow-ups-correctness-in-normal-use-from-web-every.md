---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/review-stack-base.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7450 (head 872c56e2a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7450 (reviewed head `872c56e2aff5bf9c4d897cced29b8de6ba414f54`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/review-stack-base.mjs:474` — (failing-input, degraded) The fast pass rejects every PR from a non-lane branch
   - Scenario: Take an otherwise admissible review:pending PR in web-everything/web-everything with headRefName='feature/fix', baseRefName='main', and isCrossRepository=false. readOriginLaneTips only inventories lane/* branches, so flagUntrustedStackRows marks this target untrusted. The new strict target check throws 'stack evidence unknown: target-head-untrusted', preventing fast dispatch on every attempt. A complete, ordinary main-targeting PR should be recognized as unstacked and remain eligible for fast dispatch instead of always waiting for the normal tick.
   - Class: correctness-in-normal-use (basis: An isolated probe evaluated the checked-in reader and trust helpers with injected PR and origin-tip evidence. The feature/fix input returned base=null without strict mode and threw with strict mode; an equivalent lane/fix input passed strict mode. Full module execution was unavailable because markdown-it is not installed. No concurrency or attacker assumptions are required.)
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
