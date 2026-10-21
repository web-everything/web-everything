---
bornAs: xhay8d3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/build-self-review.mjs", "we:scripts/lib/build-policy.mjs", "we:scripts/lib/__tests__/build-self-review.test.mjs", "we:scripts/lib/__tests__/build-policy.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add an adapter test that feeds fenced and prose-wrapped replies, and extract the JSON object defe… (from web-everything/web-everything#5485 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/build-self-review.mjs:21` — Add an adapter test that feeds fenced and prose-wrapped replies, and extract the JSON object defensively (strip a fence, then validate the schema). Add a rule to we:reviewer-expectations.md: 'model-output parsers tolerate fences and have a test for them'.
2. `we:scripts/lib/build-policy.mjs:21` — Treat an empty env string as unset before coercion, and add a policy test for the empty-string case.
3. `we:scripts/lib/build-policy.mjs:21` — Add a table-driven test for invalid env values ('', ' ', '1.5', '-1', '11', 'abc') on every build.* key, expecting a fall back to the standard value. Parse strictly with /^\d+$/.
4. `we:scripts/lib/build-policy.mjs:40` — Add a check:standards rule that bounds we:reviewer-expectations.md (bytes and line count) and requires each line to match `- **Title.** text`, with no HTML comments, code fences or URLs. Have the coroner append through the shared sanitizer.
5. `we:scripts/lib/build-self-review.mjs:56` — Also escape [ ] ( ) !, or render notes inside a fenced code block, and add a test for `![a](http://x)` staying inert.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5485@bc5478f8e4614b20e44ee643c18af08df40191ed

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
