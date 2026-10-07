---
bornAs: x0b5ugd
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Make the resume kind depend on the salvage result (push-transient only when salvaged.ok, otherwis… (from web-everything/web-everything#4295 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4295's review (reviewed head `40ff7a838340c793d7d9f3bd14b096ddcf979495`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/await-verify-pass.mjs:283` — Make the resume kind depend on the salvage result (`push-transient` only when `salvaged.ok`, otherwise a distinct fallback kind). Add a pass test where `saveSalvage` returns `{ok:false}` and assert the prompt.
2. `we:scripts/conveyor/await-verify-pass.mjs:465` — Treat an `unknown` reconcile state as transient for every kind (retry or tag `transient`). Add table-driven tests over (kind × reconcile-state × last-attempt).
3. `we:scripts/conveyor/await-verify-pass.mjs:395` — Add a salvage-push test that asserts it refuses when the marker is absent or red for record.sha, and give the record a verify marker digest or re-read the marker in salvagePush.
4. `we:scripts/conveyor/await-verify-pass.mjs:393` — Classify on the git status line's parenthesised reason (`! [remote rejected] a -> b (reason)`) or strip the ref/URL from the text before matching, and add a table-driven test with keyword-bearing ref names.
5. `we:scripts/conveyor/await-verify-pass.mjs:287` — Add a deterministic fault-injection test for failed commit copying and failed record writing, requiring a recoverable handoff before the fixer is told preservation succeeded.
6. `we:scripts/conveyor/await-verify-pass.mjs:343` — Add a deterministic test that returns repeated deferrals beyond maxAttempts and verifies the saved commit remains eligible for recovery until its TTL expires.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
