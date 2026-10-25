---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5848 (head f11e21410)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5848 (reviewed head `f11e21410e95728f47526461764007f38fae1c4f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:219` — (failing-input, degraded) Scratch clones cannot resolve the repository's Frontier UI test aliases.
   - Scenario: Repair an established overlay conflicting in we:blocks/trusted-html/TrustedHtmlBehavior.ts. Its related we:TrustedHtmlBehavior.test.ts imports (at)frontierui/plugs/webbehaviors/CustomAttribute. The worker creates its checkout directly under tmpdir and provisions only a node_modules symlink. we:vitest.shared.ts resolves (at)frontierui/plugs to ../frontierui/plugs relative to that checkout, so it targets tmpdir/frontierui/plugs rather than the functioning daemon checkout's Frontier UI sibling. On a normal host without that temporary sibling, the selected test fails module resolution, preventing repair and leav
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
