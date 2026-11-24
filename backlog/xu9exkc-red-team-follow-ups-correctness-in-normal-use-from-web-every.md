---
kind: story
size: 2
status: open
scope: ["we:scripts/daemon-overlay.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7369 (head 38c877a8f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7369 (reviewed head `38c877a8fd55767dd9be3cde73b1c74bf9b16356`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/daemon-overlay.mjs:661` — (failing-input, degraded) Valid audits are refused when the target clone’s origin/main lags
   - Scenario: Leave the daemon clone’s origin/main at A, advance remote main to B, and audit candidate C against B with a canonical NOT WEAKENED result. Run add for C. The conflict preview fetches B into its disposable repository and succeeds, but registrationAuditGate checks whether B is contained in the target clone’s stale origin/main A. Admission incorrectly exits 3 with no-canonical-audit. Coverage should be proved using the freshly fetched Git context so valid evidence admits C.
   - Class: correctness-in-normal-use (basis: Read-only probe used real daemon histories with verified ancestry A &lt; B &lt; C and an in-memory canonical audit record. Writer coverage returned true; target-clone coverage and registrationAuditGate returned false. Replaying add --check with an injected successful preview naming B and C produced wouldRegister:false and exit 3. Source inspection confirms the real preview fetches only into scratch and leaves the target tracking ref unchanged. No attacker or concurrent mutation is required.)
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
