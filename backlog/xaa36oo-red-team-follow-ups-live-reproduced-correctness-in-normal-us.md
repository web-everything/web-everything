---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-live-owner-watch-io.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7270 (head 257afb05a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7270 (reviewed head `257afb05a55966df8754fb1f93cbe9ffb9d38ea6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-live-owner-watch-io.mjs:66` — (failing-input, degraded) The retry classifier misses gh’s DNS and broken-pipe error messages.
   - Scenario: The first PR-list subprocess exits 1 with stderr 'Post https://api.github.com/graphql: dial tcp: lookup api.github.com: no such host' or 'write tcp: write: broken pipe'; the next call would succeed. execFileSync exposes status 1 without an ENOTFOUND/EPIPE code, and neither message matches TRANSIENT_MESSAGE. listPRs therefore throws after one attempt, triggering evidence-unavailable instead of backing off and recovering.
   - Class: live-reproduced (basis: A read-only probe evaluated the classifier and listPRs method extracted verbatim from the checked-out file, supplying real execFileSync exit-1 errors followed by success. Both inputs produced one call and no backoff; a connection-refused control retried and recovered.)
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
