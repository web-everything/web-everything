---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7461 (head 4f1c2c30a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7461 (reviewed head `4f1c2c30a0fd6c0c15959592eeebddba0ee935d3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/verify-lane-gate.mjs:453` — (edge-case, degraded) Origin matching misidentifies unrelated repositories as known siblings
   - Scenario: Use origin https://gitlab.com/plateauapp/plateau-app.git, an idle host, a we:package.json change, no we:scripts/check-standards.mjs, and scripts containing only test. The predicate identifies this unrelated repository as a known sibling, so the fallback skips standards and returns npx vitest run. Unknown repository identities should retain the mandatory standards command under the stated fail-closed policy.
   - Class: correctness-in-normal-use (basis: An isolated probe of the exact new predicate using the real repoKeyForSlug returned true for both that GitLab URL and /tmp/plateauapp/plateau-app.git. The regex discards the host and transport. The resulting skip follows directly from lines 520–529; full resolver execution was blocked by the missing markdown-it dependency.)
   - Also class: attacker-same-user
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
