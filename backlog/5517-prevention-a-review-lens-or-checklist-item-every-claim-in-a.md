---
bornAs: x050tp9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/lib/review-round-rules.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/__tests__/review-round-rules.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — A review lens or checklist item: every claim in a comment about a branch input needs a test case… (from web-everything/web-everything#4524 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:340` — A review lens or checklist item: every claim in a comment about a branch input needs a test case that exercises that input alone.
2. `we:scripts/operations/review-pr.mjs:2706` — A snapshot test of `shapeReadFinding` and the reduce output under both modes would catch any off-path drift.
3. `we:scripts/operations/review-pr-io.mjs:368` — Export one `safeGitPath()` and `isHexSha()` helper, use it in both the sink and the CLI, and add a table test of hostile paths and heads. A lint rule could also require that any `git show` or `git diff` with an interpolated argument comes from a shared validated helper.
4. `we:scripts/lib/review-round-rules.mjs:236` — Before the P3 flip, add a replay or fixture assertion that a security- or correctness-lens finding is never demoted by a nearby edit alone. Require positive evidence, such as the cited line itself changed, or the finding absent after a change at that line. File this as a gate on card 5470.
5. `we:scripts/lib/review-round-rules.mjs:249` — Add a deterministic regression test covering insertions and deletions before historical citations; retain old-side ranges or translate historical positions before deciding that a finding was addressed.
6. `we:scripts/operations/review-pr-io.mjs:377` — Add a deterministic fault-injection test for failed symbol reads with existing raised identities, and propagate read failure separately so it forces a full or blocking shadow decision.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4524@6ee4e3de71b6db7016069d18b520b87b6cd1e74c

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
