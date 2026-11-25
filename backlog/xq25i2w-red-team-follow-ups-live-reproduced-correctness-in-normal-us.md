---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/actions-policy-watch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7473 (head 6e315e79f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7473 (reviewed head `6e315e79fe3b898b81e7a1c733326be628d566e0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/actions-policy-watch.mjs:67` — (failing-input, degraded) HTML-encoded keywords silently bypass changelog alerts
   - Scenario: With a healthy policy and empty seen set, supply a valid RSS item with guid sunset-1, title 'Actions policy update', and content:encoded containing CDATA '&lt;p&gt;The allow&#45;policy is being retired.&lt;/p&gt;'. Using the shipped settings, runWatch returns feed.status='ok', changelog=[], and alerts=[]. Replacing the entity with a literal hyphen produces the expected alert. HTML markup splitting 'allow-&lt;strong&gt;policy&lt;/strong&gt;' also bypasses detection. Normalize HTML bodies to decoded visible text before keyword matching so these sunset announcements raise an alert.
   - Class: live-reproduced (basis: Reproduced through runWatch and fetchFeedText using the shipped configuration and an offline, namespaced RSS fixture. A literal-keyword control raised an alert; equivalent encoded HTML did not.)
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
