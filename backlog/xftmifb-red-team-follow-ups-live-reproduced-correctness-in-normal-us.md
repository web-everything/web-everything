---
kind: story
size: 2
status: open
scope: ["we:protocols/tools/validate-protocols.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style] from plateauapp/plateau-app#241 (head e35d77f1e)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#241 (reviewed head `e35d77f1eb20aa0df37f28bafefa00f118a0b6f3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:protocols/tools/validate-protocols.mjs:117` — (failing-input, degraded) URI validation accepts stray brackets and multiple fragment delimiters
   - Scenario: Validate a ref with uri 'urn:example:policy[prod]' or 'https://example.com/policy#one#two' and digest.sha256 containing exactly 64 lowercase a characters. Both pass the shipped ref schema. Both violate RFC 3986 URI grammar and should produce a uri format mismatch; the character whitelist and WHATWG parser do not enforce component grammar.
   - Class: live-reproduced (basis: Reproduced through validateAll using additional in-memory vectors targeting the bundled ref definition. Both negative vectors failed because the malformed references were accepted.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:protocols/tools/validate-protocols.mjs:118` — (edge-case, degraded) URI validation rejects valid IPvFuture host literals
   - Scenario: Validate a ref with uri 'http://[v1.a]/policy' and digest.sha256 containing exactly 64 lowercase a characters. Validation reports a uri format mismatch. RFC 3986 permits this IPvFuture IP-literal, so URI syntax validation should accept it. WHATWG URL parsing rejects it, making that parser an incompatible URI validator.
   - Class: live-reproduced (basis: Reproduced through validateAll with an additional in-memory positive vector targeting the shipped ref definition; it failed with uri format mismatch. The existing 113 vectors passed.)
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
