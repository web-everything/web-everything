---
kind: story
size: 2
status: open
scope: ["we:scripts/daemon-overlay.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7369 (head 6a56348da)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7369 (reviewed head `6a56348da33177aff06ef818cc0d862fd7d473ef`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/daemon-overlay.mjs:661` — (edge-case, degraded) Valid audits are rejected when the daemon clone's origin/main is stale
   - Scenario: Let the daemon clone retain origin/main=M0, advance remote main to M1, and record a canonical NOT WEAKENED audit of candidate H against M1. Run daemon-overlay add --clone=&lt;clone&gt; --ref=lane/fix --pr=123 --check. The conflict preview fetches M1 and H into its disposable repository and succeeds, but this gate checks coverage against the clone's unchanged origin/main=M0 and refuses with exit 3. It should prove audit coverage against the freshly fetched main used by the preview.
   - Class: correctness-in-normal-use (basis: The preview explicitly leaves the clone's tracking refs untouched. An isolated read-only probe confirmed that valid audit evidence passes with coverage supplied but fails with the local coverage resolver when origin/main is unavailable. No concurrent mutation is required.)
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
