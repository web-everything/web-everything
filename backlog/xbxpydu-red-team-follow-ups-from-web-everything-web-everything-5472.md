---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/build-unconfirmed-settings.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5472 (head e3fbe6142)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5472 (reviewed head `e3fbe6142e86717efd75c1bbaf76c96a173e020d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/build-unconfirmed-settings.mjs:14` — (failing-input, degraded) Object-valued launch thresholds bypass numeric validation and disable cooldown
   - Scenario: Configure '{"build":{"unconfirmedLaunchMax":{"value":1}}}' with no environment override. resolveCascade validates the nested numeric leaf rather than the configured threshold, so readBuildUnconfirmedSettings returns an object as unconfirmedLaunchMax. Comparing the launch count against that object always returns false. Read-only probes of the reader and ledger functions with in-memory filesystem operations confirmed that successive same-base unconfirmed failures never activate cooldown; only ordinary attempt exhaustion eventually stops retries. The invalid object should be rejected and the vali
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
