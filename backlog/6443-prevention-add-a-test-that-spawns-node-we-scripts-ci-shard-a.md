---
bornAs: xfzgl95
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/shard-assign.mjs", "we:scripts/ci/__tests__/shard-assign.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a test that spawns node we:scripts/ci/shard-assign.mjs --suite=soak --shard=1/N and asserts i… (from web-everything/web-everything#5260 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/shard-assign.mjs:146` — Add a test that spawns `node we:scripts/ci/shard-assign.mjs --suite=soak --shard=1/N` and asserts its output equals `shardFiles({shard, total})` for every shard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5260@ad39c5bc1adfc398e5ff73651a853087f09316c8

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
