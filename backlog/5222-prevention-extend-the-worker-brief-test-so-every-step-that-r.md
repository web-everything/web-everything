---
bornAs: xn6r5i9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/held-cards-io.mjs", "we:scripts/__tests__/worker-brief.test.mjs", "we:scripts/__tests__/held-cards-io.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Extend the worker-brief test so every step that runs a free-scope-cli command asserts a stop-on-n… (from web-everything/web-everything#4017 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/worker-brief.mjs:92` — Extend the worker-brief test so every step that runs a free-scope-cli command asserts a stop-on-nonzero-exit instruction. Better, add a brief-vs-SKILL consistency check.
2. `we:scripts/held-cards-io.mjs:102` — Add a shared `atomicWriteFile` helper (temp file plus rename) and a lint or check:standards rule that flags `writeFileSync` onto operator state files under ~/workspace/.operations.
3. `we:scripts/worker-brief.mjs:43` — Validate each file entry and `edgeClone` against a conservative path regex (e.g. `^[A-Za-z0-9_./:@+-]+$`, or shell-quote them) in `renderWorkerBrief`. Add a parametrised hostile-input test beside the existing `rejects invalid arguments` table. A lint rule that flags unvalidated template interpolation inside generated command strings would cover the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4017@a6c2b3336eeed2f6d04a26644c16966acf693979

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
