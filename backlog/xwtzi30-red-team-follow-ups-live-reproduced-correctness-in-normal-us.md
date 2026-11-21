---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-key-structure.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7228 (head ba2aaa251)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7228 (reviewed head `ba2aaa2510a14021ad079f49b7dedcfbf940181a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/forge-key-structure.mjs:83` — (failing-input, degraded) Line-comment lookahead remains quadratic and escapes the scan work budget
   - Scenario: Scan Buffer.from("kty " + "{//".repeat(160000)). Each brace triggers startsObjectMember, whose afterTrivia searches the remaining suffix for a line terminator. The 480,004-byte input took 22.6 seconds and returned null; 240,004 bytes took 6.6 seconds. Through credentialBufferFinding, Buffer.from("// kty " + "{//".repeat(80000)) took 7.4 seconds and returned null. These inputs fit below both the documented 1 MiB ceiling and bundle blob limit, yet synchronously stall admission. The suffix searches must run in linear time or consume the work budget and return the exhaustion finding.
   - Class: live-reproduced (basis: Measured the exported scanner and credential-admission hook directly using generated in-memory inputs. Doubling input produced approximately quadratic runtime; neither scan returned a budget-exhaustion finding.)
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
