---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a same-tree and a superseded ready-adoption case to we:main-sync-set-aside.test.mjs that goes… (from web-everything/web-everything#7368 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/prepare.mjs:773` — Add a same-tree and a superseded ready-adoption case to `we:main-sync-set-aside.test.mjs` that goes through `prepareRebuild`. Alternatively, export the ready-to-finalize option mapping as a function and have both the probe and `we:scripts/lib/daemon-rebuild/prepare.mjs` call it.
2. `we:scripts/lib/daemon-rebuild/prepare.mjs:461` — Add a test that counts `overlay-main-sync-set-aside` alerts and overlay events across a readyOnly tick plus an adoptOnly tick, and across a failed-smoke tick plus a retry. If repeats are intended, dedupe on a separate non-adoption notified record, as `pinnedNotified` does, or reword the doc.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7368@5008972e9a58f98fbe09752d969fba9a2acef6cd

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
