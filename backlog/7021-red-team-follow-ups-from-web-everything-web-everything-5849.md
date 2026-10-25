---
bornAs: xyrv0q6
kind: story
size: 2
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5849 (head 8f5f5a981)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5849 (reviewed head `8f5f5a981c2b5f1280101148db93a01a016193d0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/jury-core.mjs:3137` — (edge-case, degraded) A withdrawn carry becomes valid again after losing the transient judge map
   - Scenario: On one head, use we:src/a.mjs:20, category correctness, verdict CONFIRMED and impact broken for three findings: A='Missing payload validation' (judge, run r1), T='Request payload validation is missing' (judgeSecurity, run dest), and B='Payload is consumed without validation' (judgeCorrectness, run r2). Operator rules A not-real; persist T's carry from A with a valid 0.99 judge decision for A/T. Subsequently operator rules B block, and a batched judge positively matches B/T at 0.99. With that decision map, mandatoryReferralState reports T pending because B withdraws its carry. Reading the identica
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/review-pr-io.mjs:1235` — (failing-input, degraded) Quiet reruns judge irrelevant target pairs and emit quadratic output despite the pair cap
   - Scenario: Supply ten valid, already-attempted same-head records containing 100 findings total, no reviewer rulings and no operator rulings. Each finding uses we:src/a.mjs:20, category correctness, verdict CONFIRMED, impact broken, and summary 'Validation missing for request field '+i. Invoke MANDATORY_REFERRALS with referrals=[]. The real sink still calls the injected same-gap judge once and emits 4,950 pair-decision records: the probe measured 4,952 output lines and 2,482,629 bytes. Every source comment was under 9 KB. No pair can authorize inheritance because no operator ruling exists. Separately, 400 el
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
