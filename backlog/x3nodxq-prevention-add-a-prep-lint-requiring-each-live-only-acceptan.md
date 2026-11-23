---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/testing/fast-drain-pass-freshness-and-parity.md", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a PREP lint requiring each live-only acceptance to link a validated timing artifact or an ope… (from web-everything/web-everything#7367 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/testing/fast-drain-pass-freshness-and-parity.md:33` — Add a PREP lint requiring each live-only acceptance to link a validated timing artifact or an open follow-up card. The doc proposes this but it is not yet filed or captured.
2. `we:scripts/merge-ai-prs.mjs:1146` — Extend the skip-class table to cross incomplete evidence with each operative hold, asserting reason and `reviewHeld`. Alternatively, evaluate incompleteness after the holds so existing reasons keep precedence.
3. `we:docs/agent/testing/fast-drain-pass-freshness-and-parity.md:33` — Add a PREP lint: each acceptance tagged live-only must link a validated timing artifact or an open follow-up card id. Add a named live benchmark that fails when elapsedMs > 60000.
4. `we:docs/agent/testing/fast-drain-pass-freshness-and-parity.md:37` — Add a named live benchmark, 'single-PR catch-up completes within 60 seconds', and a deterministic evidence validator requiring the reviewed revision, successful exit, and elapsedMs <= 60000; require each live acceptance to reference validated evidence or an open follow-up card.
5. `we:scripts/merge-ai-prs.mjs:1148` — Extend the deterministic skip-class table to combine incomplete checks with each existing hold and assert reason precedence, dependency deferrals, and idle-consumer results.
6. `we:docs/agent/testing/fast-drain-pass-freshness-and-parity.md:37` — Implement the documented acceptance-to-evidence gate and artifact validator, requiring revision-matched live timing evidence or a linked open follow-up; this guard is proposed but not implemented or externally filed in the supplied material.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7367@a99d381addb7a55b8d535bb2312a2afffb385410

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
