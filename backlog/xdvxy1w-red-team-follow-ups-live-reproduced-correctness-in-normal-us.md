---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/resolve-generated.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7322 (head 025e4f285)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7322 (reviewed head `025e4f285f4d162f3425f55fec33a088b914419b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/resolve-generated.mjs:35` — (failing-input, degraded) The new operation discards --json output and prints prose.
   - Scenario: Invoke resolve-generated --json --checkout=&lt;checkout&gt;. When resolution succeeds or is refused, finishResolveGenerated replaces the adapter's JSON with a plain-text message. Consumers using JSON.parse fail. The finisher should preserve valid JSON when the json flag is set, including refusal outcomes.
   - Class: live-reproduced (basis: A read-only Node probe called the actual finishResolveGenerated function with json:true and JSON adapter output for both successful and refused effects. Both returned outputs failed JSON.parse. we:run.mjs passes the json flag to this finisher.)
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
