---
kind: story
size: 2
status: open
scope: ["we:scripts/sync-skills-deploy.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7281 (head d51012dbc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7281 (reviewed head `d51012dbceee028d25184c04928da32b2f7e79d5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/sync-skills-deploy.mjs:350` — (edge-case, degraded) A trailing slash makes the default source root collide with itself
   - Scenario: With the default ops root present, run node we:scripts/sync-skills-deploy.mjs --check --only=review-design --root=/Users/nicolasgilbert/workspace/plateau-ops/skills/. It exits 1 claiming providers has two homes and prints the identical skill path twice. The same command without the trailing slash exits 0. Equivalent root paths should be deduplicated before checking for distinct skill homes.
   - Class: live-reproduced (basis: Both CLI inputs were executed read-only against the existing default ops checkout. The trailing-slash variant failed; the otherwise identical canonical-path control passed.)
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
