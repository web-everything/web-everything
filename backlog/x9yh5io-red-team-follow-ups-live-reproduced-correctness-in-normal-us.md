---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/check-scope.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7256 (head f5f19c19b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7256 (reviewed head `f5f19c19ba3c1b73cc5e085c1fecfeaff7064c8d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/check-scope.mjs:21` — (failing-input, degraded) An explicitly empty file list reports clear without checking evidence
   - Scenario: Invoke check-scope with --files= or --files=', ,'. Both pass argument validation and return {"ok":true,"overlaps":[]} with exit code 0 without collecting evidence. An unset variable expanded into --files="$FILES" therefore appears successfully checked. Reject an empty normalized scope as invalid or unknown, while retaining the intentional exemption for nonempty prose-only scopes.
   - Class: live-reproduced (basis: Reproduced both inputs through the actual operation declaration, runOperationCli, sink, and finish hook using an in-memory run store; both returned code 0.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/run.mjs:641` — (edge-case, degraded) Incomplete evidence returns exit 1 when an overlap is also known
   - Scenario: Check we:scripts/a.mjs with a live agent holding we:scripts/a.mjs and an unreadable repository entry for plateauapp/plateau-app. The checker retains the unreadable evidence, but finish returns code 1 because overlaps is nonempty. The advertised contract assigns code 2 to unknown evidence. Give incomplete evidence precedence so callers can distinguish an incomplete check from a complete overlap result.
   - Class: live-reproduced (basis: Injected this snapshot into checkScope and passed its resulting verdict to the registered operation's actual finish hook; observed unreadable evidence in the JSON alongside code 1.)
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
