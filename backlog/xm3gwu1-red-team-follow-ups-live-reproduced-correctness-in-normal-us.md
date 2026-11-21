---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/check-scope.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7256 (head 7f151dbbf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7256 (reviewed head `7f151dbbfdf5baa31d948027d3f62a21eebc6506`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/check-scope.mjs:21` — (failing-input, degraded) An empty files flag reports a successful scope check
   - Scenario: Invoke check-scope with --files= or bare --files. Both parse successfully; the empty scope returns ok:true without collecting evidence, and the CLI exits 0. An unset files variable therefore produces a false clearance. Reject an empty declaration with exit 2 while preserving the intentional exemption for nonempty prose-only declarations.
   - Class: live-reproduced (basis: Executed the production CLI adapter, operation sink and finish function using an in-memory run store. --files= returned code 0 and ok:true; the parser also accepted bare --files.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/check-scope.mjs:23` — (edge-case, degraded) Frontier UI scopes report clear without reading Frontier UI PRs
   - Scenario: Check frontierui:scripts/a.mjs while a Frontier UI PR changes we:scripts/a.mjs and no agent claim exists. collectFreeScope defaults to querying only web-everything/web-everything and plateauapp/plateau-app. checkScope nevertheless returns ok:true. Query the declared repository or return unknown for scopes whose repository was not inspected.
   - Class: live-reproduced (basis: Ran checkScope through the production collectFreeScope with an injected PR reader offering the overlapping PR for frontier-ui/frontierui. Captured requests included only WE and plateau-app, and the result was ok:true. No external PR state was assumed or queried.)
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
