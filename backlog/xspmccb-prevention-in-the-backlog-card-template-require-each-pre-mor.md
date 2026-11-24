---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs", "we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-rebuild/__tests__/rebuild.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — In the backlog-card template, require each pre-mortem bullet to name a test file and case, and ha… (from web-everything/web-everything#7428 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs:72` — In the backlog-card template, require each pre-mortem bullet to name a test file and case, and have a lens or lint flag bullets with no matching test name.
2. `we:scripts/lib/daemon-rebuild/rebuild.mjs:475` — Add a one-line assertion on log.error's mock calls in the rebuild-count test. More generally, a review lens could flag any log line cited as acceptance evidence that has no test.
3. `we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs` — Add a card lint that requires each Pre-mortem bullet to cite a test name, and have the reviewer check that the named test exists in the diff.
4. `we:scripts/lib/daemon-rebuild/rebuild.mjs:475` — A review lens check that any 'is logged' acceptance item has a log-spy assertion. A deterministic gate is hard to write for this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7428@5bcff5150bad786a6e5761ae25fea918252a3e35

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
