---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/operations/codex-audit.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/__tests__/daemon-rebuild-audited-tip.test.mjs", "we:scripts/lib/__tests__/hotpatch-guards.test.mjs", "we:scripts/lib/hotpatch-readers.mjs", "we:scripts/lib/daemon-rebuild/__tests__/adopt.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs", "we:scripts/operations/__tests__/codex-audit.test.mjs", "we:scripts/lib/__tests__/daemon-overlays.test.mjs", "we:scripts/lib/__tests__/hotpatch-readers.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a negative test for the no-watch case, and make the binding fail closed by dropping the fallb… (from web-everything/web-everything#7362 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/adopt.mjs:489` — Add a negative test for the no-watch case, and make the binding fail closed by dropping the fallback. Add a rule that every `??` fallback in a guard condition needs a named test.
2. `we:scripts/lib/daemon-load-overlay.mjs:81` — Add a `runDaemonLoadOverlay` test with `ref: hotpatch/<sha>` and the real `addOverlay` asserting `registered:false` and no overlay written. A lint rule that flags direct `addOverlay` callers outside admitted paths would catch the class.
3. `we:scripts/operations/codex-audit.mjs:88` — In findAudit, map a malformed WEAKENED record to unusable-negative, which blocks, instead of skipping it. Add a table-driven test over verdict x malformed-findings x ordering.
4. `we:scripts/lib/daemon-rebuild/adopt.mjs:490` — Add a no-watch row, positive and negative, to the finalize rollback matrix. Document what 'last-good' means when the watch is gone.
5. `we:scripts/lib/daemon-overlays.mjs:267` — Add a check:standards rule or source-scan test that addOverlay call sites with hotpatch-capable refs go through admitHotpatch. Or require an admission token parameter in addOverlay for hotpatch refs.
6. `we:scripts/lib/__tests__/daemon-rebuild-audited-tip.test.mjs` — Add a parameterized regression test independently varying token validity and last-good equality, asserting evidence revalidation and refusal for every unauthorized combination.
7. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs` — Add a deterministic reader test that records requested byte ranges and rejects requests exceeding the ledger budget, including an oversized-file case.
8. `we:scripts/lib/__tests__/daemon-rebuild-audited-tip.test.mjs:1107` — Add a parameterized token-by-target authorization matrix to the required test suite, including a normal token with an exact last-good target.
9. `we:scripts/lib/hotpatch-readers.mjs:96` — Use a bounded read primitive and require a deterministic test asserting that total bytes requested never exceed the limit plus one sentinel byte.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7362@08e4290d5ff53928c77c3110bed1a0ec750c02d5

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
