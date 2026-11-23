---
kind: story
size: 2
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/overlay-audit-evidence.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7369 (head a337fcbf4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7369 (reviewed head `a337fcbf4c56fd507b80c455d755831b9639dcdb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/daemon-overlay.mjs:661` — (edge-case, degraded) Valid audits are refused when the target clone's main ref is stale
   - Scenario: Audit candidate H against current main B, then add it to a daemon clone whose local origin/main predates B. The conflict guard fetches B into its disposable scratch repository and reports a clean candidate, but audit admission checks B against the stale target clone instead. A read-only injected add --check probe returned exit 3 and no-canonical-audit despite matching evidence and check.mainSha=B. Coverage should use the freshly fetched main that the guard verified.
   - Class: correctness-in-normal-use (basis: A daemon clone lagging behind current main is ordinary use. Source inspection confirms the guard fetches only into scratch; the injected probe confirms admission consults the target clone instead.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/overlay-audit-evidence.mjs:35` — (failing-input, broken) Malformed findings can qualify as canonical passing evidence
   - Scenario: Supply an audits.jsonl row with matching full head/base SHAs, current QUESTION_HASH, a valid past timestamp, verdict='NOT WEAKENED', and findings='WEAKENED' as a scalar string. With base coverage satisfied and no waiver or override, registrationAuditGate returns true. The reused evaluator checks contradictory findings only when findings is an array. This malformed row should be rejected rather than authorize registration.
   - Class: attacker-same-user (basis: Reproduced through the actual registration gate with in-memory filesystem and Git responses. Exploitation requires modifying the home-scoped audit ledger; no remote or cross-user write path was established. Forging this row avoids the explicit override event.)
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
