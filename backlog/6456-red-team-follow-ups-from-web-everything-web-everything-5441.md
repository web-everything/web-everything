---
bornAs: x92sqvq
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5441 (head 454e87c07)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5441 (reviewed head `454e87c072ee508452e5b63dec0957797d9bee1c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-pr.mjs:2377` — (edge-case, degraded) The forced Codex seat can launch Gemini on every PR despite disabled shadows and advisory opt-outs
   - Scenario: Disable shadows, set both Codex advisory flags and REVIEW_PR_ANTIGRAVITY_REVIEW to 0, and leave minNonClaudeSeats at 1. When Codex is quota-held and Antigravity has no recorded hold, the newly forced judgeAdvisory request takes cli-adapter's codex-to-antigravity quota fallback. An injected-provider probe recorded an antigravity call despite shadowEnabled=false and a null mandatory shadow directive. This bypasses PR sampling and can invoke Gemini for every review, contradicting the claimed Gemini-off behavior. The forced seat should respect that disablement and report a diversity shortfall when
   - Claude's re-check: The forced judgeAdvisory request sets gracefulOnUnavailable. In cli-adapter, when codex is quota-held the PROVIDER_QUOTA_FALLBACK maps codex to antigravity and spawns it if it isn't held. That path checks neither shadowEnabled nor REVIEW_PR_ANTIGRAVITY_REVIEW, so Gemini can run despite shadows being off.

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
