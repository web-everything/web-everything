---
bornAs: x8np3td
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xqz26k1-held-daemon-clone-builds-its-own-stack-top-main-merge-candid.md", "we:backlog/xn5h9sy-daemon-rebuild-planner-replays-a-pinned-base-overlay-an-appl.md"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention — Card-lint rule: every non-goal phrased as a prohibition ('no model call', 'never X') must map to… (from web-everything/web-everything#5773 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xqz26k1-held-daemon-clone-builds-its-own-stack-top-main-merge-candid.md:43` — Card-lint rule: every non-goal phrased as a prohibition ('no model call', 'never X') must map to a named Acceptance case or carry an explicit 'untested by design' note.
2. `we:backlog/xn5h9sy-daemon-rebuild-planner-replays-a-pinned-base-overlay-an-appl.md:18` — Card-lint: any 'live rebuild' or 'live proof' claim in the Fix or Why prose must have an Acceptance item tagged **Live proof**.
3. `we:backlog/xqz26k1-held-daemon-clone-builds-its-own-stack-top-main-merge-candid.md:24` — Require a machine-checked Acceptance-to-test manifest at card admission, including positive and live-proof guarantees alongside refusal cases.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5473, finding 5 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5773@2328aa7cab271693b669018db26d2438906415a2

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
