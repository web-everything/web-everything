---
bornAs: xvj846g
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/lib/build-policy.mjs", "we:scripts/verify-lane.mjs", "we:backlog/6925-decide-codex-self-review-and-gate-per-caller-class.md", "we:scripts/codex-direct-task.mjs", "we:scripts/lib/build-self-review.mjs", "we:skills-src/coroner/SKILL.md", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/lib/__tests__/build-policy.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/__tests__/codex-direct-task.test.mjs", "we:scripts/lib/__tests__/build-self-review.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A PR-description-vs-diff claim check on behaviour replacement: require the description to name an… (from web-everything/web-everything#5485 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/deliver-item-wrapper.mjs:629` — A PR-description-vs-diff claim check on behaviour replacement: require the description to name any removed or bypassed pipeline stage.
2. `we:scripts/lib/build-policy.mjs:19` — Shared env-number parser in policy-cascade that rejects empty strings, plus a table test over '', ' ', 'abc'.
3. `we:scripts/verify-lane.mjs:347` — A review lens: when a default is injected into a flag that a downstream branch treats as 'explicit', require a test per mode that reads that flag.
4. `we:backlog/6925-decide-codex-self-review-and-gate-per-caller-class.md:13` — A check:standards rule: a card whose Acceptance names an executable test file must have that file present before the card is marked active, and TODO placeholders fail the standards check.
5. `we:scripts/codex-direct-task.mjs:890` — Add a named test that runs a review-mode `codexDirectTask` with self-review enabled and asserts that the reviewer is not re-entered. Longer term, a standards rule could require a test that names each guard in a recursion-capable path.
6. `we:scripts/lib/build-self-review.mjs:103` — Add an assertion in the 'renders inert code' test that the rendered output matches no control or format characters. A property-style test over the full Cc/Cf range would cover the whole class.
7. `we:scripts/lib/build-policy.mjs:18` — Treat an empty or whitespace-only env value as unset, or parse with a strict `/^\d+$/` check. Add an env-layer case to the invalid-overrides test.
8. `we:skills-src/coroner/SKILL.md:162` — Require coroner appends to go through a reviewed PR. Add a deterministic check, as a `check:standards` rule or unit test, that caps the file's size and allows only the rule-bullet shape, so a free-text injection fails CI.
9. `we:scripts/lib/build-self-review.mjs:49` — Add mixed-format contradictory-verdict cases to the deterministic adapter tests and reject additional verdict objects outside the selected fence.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 9 → #5360, finding 11 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5485@e57c222ec2d3b998f3b007202b6155f4c9aa1534

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

## Also raised by

- Also raised by web-everything/web-everything#5510 (finding 2: `we:backlog/x9jlvy0-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:24` — A check:standards rule that fails a card whose Acceptance Must line has no backtick-quoted test name or file reference. File this as a backlog item.)
- Also raised by web-everything/web-everything#5510 (finding 1: `we:backlog/6273-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:28` — Add a card-lint rule that every [A#] **Must** line names a test case in backtick-quoted form, as A2, A4, A5 and A8 already do.) · key `approval-prevention-key:web-everything/web-everything#5510@b07c834c3ac418d1085fc11df0d1631a919d7486`
- Also raised by web-everything/web-everything#5510 (finding 2: `we:backlog/6273-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:26` — Add a card-lint rule in check:standards that every Acceptance line marked **Must** names a backticked test case or a vitest path. The rule would fail A3 as written.)
