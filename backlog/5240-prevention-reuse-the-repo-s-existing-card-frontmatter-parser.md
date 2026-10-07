---
bornAs: xbqcmgp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-rounds.mjs", "we:scripts/operations/__tests__/coroner-rounds.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Reuse the repo's existing card frontmatter parser, or add a fixture test that parses every backlo… (from web-everything/web-everything#4185 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-rounds.mjs:128` — Reuse the repo's existing card frontmatter parser, or add a fixture test that parses every backlog/*.md and asserts a non-empty `scope` whenever the file contains a `scope:` key.
2. `we:scripts/operations/coroner-rounds.mjs:330` — Add an invariant test that sums `byHint` minutes and compares them with `part.minutes`. Alternatively, bucket zero-finding rounds under an explicit 'no-findings' hint.
3. `we:scripts/operations/coroner-rounds.mjs:304` — Add a fixture with one changes round followed by accept and assert it scores more than a PR with no rounds. Or document the metric definition in a test name.
4. `we:scripts/operations/__tests__/coroner-rounds.test.mjs:112` — Add a test helper that records the full args array. Assert `--paginate` is present on the comments call, that `comparesSkipped > 0` when `maxCompares` is low, and that the NO_ROUNDS env omits `changeRequests`.
5. `we:scripts/operations/coroner-rounds.mjs:136` — Add a test feeding hostile glob characters (`?`, `[`, `(`) to prAttributes, and wrap the per-PR attribute computation in try/catch. Alternatively use an existing glob matcher. Nothing deterministic gates this today, so file it.
6. `we:scripts/operations/coroner-rounds.mjs:69` — Validate with `/^[0-9a-f]{7,40}$/` at the single point where heads enter classifyEvent, and add a fixture with a malformed referral head. Not gated today, so file it.
7. `we:scripts/operations/coroner-rounds.mjs:59` — Use lastMatch for the head footers and extend the existing forged-advisory test with a forged `Net basis` line. Not gated today, so file it.
8. `we:scripts/operations/__tests__/coroner-rounds.test.mjs:103` — Assert the comment call args include `--paginate --slurp`, and add a maxCompares=1 test checking notes.comparesSkipped. File as a backlog item.
9. `we:scripts/operations/coroner-rounds.mjs` — Add a deterministic fixture test with 101 changed files that verifies complete attributes, or explicit exclusion of truncated records from correlation.
10. `we:scripts/operations/coroner-rounds.mjs` — Add deterministic aggregation tests covering non-block-only rulings, mixed rulings, and a later ruling superseding a block on the same finding.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4185@8d079007dd2adf9c9cae34559d377137bd011732

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
