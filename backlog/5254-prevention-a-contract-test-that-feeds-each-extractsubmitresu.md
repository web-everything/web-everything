---
bornAs: xx8r0yp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — A contract test that feeds each extractSubmitResult consumer a {outcome:'opened', labelStep:'defe… (from web-everything/web-everything#4213 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/open-pr.mjs:319` — A contract test that feeds each `extractSubmitResult` consumer a `{outcome:'opened', labelStep:'deferred'}` result. Alternatively, a lint requiring consumers that gate on `outcome === 'opened'` in label-on-green mode to also check `labelStep`.
2. `we:scripts/operations/open-pr-io.mjs:32` — Validate the derived ref with `git check-ref-format --branch`, and add a test that runs real `git rev-parse --git-path` in a temp repo with a lease file.
3. `we:scripts/operations/open-pr-io.mjs:50` — Test 'any dir under ~/.claude/github-app-token already on PATH means leave env alone'. Better, reuse the shimRootFor prefix check that resolveRealGhBinary already uses, so there is a single predicate for 'is a shim dir'.
4. `we:scripts/operations/open-pr-io.mjs:51` — Add a deterministic resolver test requiring the shared shim to become the first PATH entry when it initially appears later, with build() returning null.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4213@c71a94b818ed9664eb354648ac1684cb0ab697ef

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
