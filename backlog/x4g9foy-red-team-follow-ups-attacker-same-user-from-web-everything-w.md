---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/runner-freshness.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7208 (head 49abd5649)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7208 (reviewed head `49abd5649c3441efa8c8d0115a3cc1d067781a38`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/runner-freshness.mjs:79` — (security, broken) The new pinned-runner fetch can execute a lane-controlled upload-pack command.
   - Scenario: After acquiring a valid pinned lane, set its local remote.origin.url to an existing local repository and remote.origin.uploadpack to a shell command. Invoke open-pr from that lane. Its new freshness fetch executes the configured command before checking the fetched tip, even if fetching subsequently fails. The fetch should neutralize lane-controlled transport commands, as we:lane-pool.mjs already does with an explicit --upload-pack=git-upload-pack.
   - Class: attacker-same-user (basis: Requires control of the lane's .git/config. A read-only git ls-remote probe using the runner's exact hardening environment and maintenance pins executed a configured upload-pack command and printed PINNED_RUNNER_HELPER_EXECUTED. The new fetch uses the same transport configuration without the upload-pack override; the full fetch was not run because the review forbids it.)
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
