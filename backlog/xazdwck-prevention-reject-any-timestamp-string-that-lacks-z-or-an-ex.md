---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs", "we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/conveyor/__tests__/delivery-strategy.test.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Reject any timestamp string that lacks Z or an explicit offset inside secs(), and add a TZ-parame… (from web-everything/web-everything#7492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/delivery-strategy.mjs:18` — Reject any timestamp string that lacks Z or an explicit offset inside secs(), and add a TZ-parametrized test (run vitest under TZ=UTC and TZ=Asia/Tokyo) for the determinism claim.
2. `we:scripts/conveyor/delivery-strategy.mjs:167` — Have decisionFindings and replayFindings run tableFindings first and return its findings. Add a malformed-input test for each exported entry point. S1.1c should include this.
3. `we:scripts/conveyor/delivery-strategy.mjs:112` — Add a refusal rule for closed:true with any non-reference name, plus a table-load test for it. A lint that flags declared-but-unread table fields would catch the whole class.
4. `we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json:3000` — Add a test that runs decisionFindings over every `replay.records` entry. A fixture-key-coverage check (every top-level fixture key must be read by a test) would catch dead fixture data.
5. `we:scripts/lib/protected-path-floor.mjs:135` — Add a deterministic check, as a test or check:standards rule, that every file in STANDALONE_POLICY_FILES is also in FLOOR_SETTINGS. The two lists then cannot drift apart.
6. `we:scripts/conveyor/delivery-strategy.mjs:46` — File S1.1c, owed before S2.1, with a test that select() returns unhandled/EVIDENCE_UNKNOWN for an observation lacking source.uri or source.digest. Gate S2.1 wiring on that card being closed.
7. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs:244` — Add a deterministic purity gate restricting the selector’s imports and global capabilities, including transitive dependencies, and exercise it with prohibited-I/O fixtures; this guard remains to be filed.
8. `we:scripts/conveyor/delivery-strategy.mjs:147` — Add a deterministic regression matrix placing each potentially matching outcome before the security floor and asserting that open-security candidates cannot receive a different outcome.
9. `we:scripts/conveyor/delivery-strategy.mjs:67` — Add the same-object, two-call regression to the scoped test suite and require it to fail when validation is cached solely by identity.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7492@00fee3ea8c0ded0d24b00d5872c9116aeded99ba

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
