---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-audit.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race, coverage-or-style] from web-everything/web-everything#7334 (head 5768606da)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7334 (reviewed head `5768606da2a4e9c11b729e40f18a435858b2b6bd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/codex-audit.mjs:179` — (edge-case, degraded) A superseded head bypasses debounce when branch discovery runs after the newer push
   - Scenario: Push A, then B to lane/test before A's audit invocation starts. Invoke the standard command for A without --branch. findBranch(A) returns null because the remote now advertises B, so A audits immediately and writes a record. A subsequent invocation for B also audits. The superseded invocation should exit 4 without auditing or recording A.
   - Class: live-reproduced (basis: Executed main with the real findBranch adapter, injected remote output advertising only B, a simulated clock, and mocked auditor/persistence. Observed A audited at time 0 and B at 300000, both exiting 0 and recording evidence. The unused fingerprint dependency was stubbed.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/codex-audit.mjs:114` — (failing-input, degraded) Malformed debounce minutes can inherit a shorter platform delay instead of falling back to five minutes
   - Scenario: Resolve tool settings with audit.debounce.minutes set to an empty object and platform settings with audit.debounce.minutes set to 1. The resolver returns minutes=1. Cascade flattening drops the empty object, and the raw validation checks maxFiles but does not validate minutes. The documented invalid-setting fallback should return minutes=5.
   - Class: live-reproduced (basis: Called resolveEfficiencySettings directly with an injected settings reader, explicit platform settings, and an empty environment; observed minutes=1 and maxFiles=0.)
   - Also class: coverage-or-style
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
