---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs", "we:scripts/lib/__tests__/settings-files.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Rebuild retry pass: an already-included overlay is adopted, not dropped; settings compat and fail-closed tests

Follow-up from #4563 review (operator approved with follow-up 2026-10-09; near top). The rebuild retry pass in we:scripts/lib/daemon-rebuild/plan.mjs must mark an overlay whose commits are already in the tip as adopted, so it never raises a false overlay-dropped. Add a settings compat test that every resolved value is unchanged by the per-feature split, and a test that a git failure in the retry pass fails closed (overlay stays dropped).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs we:scripts/lib/__tests__/settings-files.test.mjs` has red-first cases for each point below.
- [A2] An overlay whose commits are already in the final tip is marked adopted by the retry pass and raises no overlay-dropped.
- [A3] A settings compat test asserts every resolved setting value is unchanged by the per-feature split (legacy file plus feature files).
- [A4] A git failure during the retry pass fails closed: the overlay stays dropped and the plan says why.

## Non-goals

- [N1] Moving existing legacy keys out of we:scripts/dispatch-settings.json (#5587 N1).
- [N2] A JSON-aware merge driver.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this follow-up opens no new case of this class.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — reads the shared settings files only; writes nothing to them.
4. **Fail closed** — any git error in the retry pass leaves the overlay dropped.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — n/a: this follow-up opens no new case of this class.
7. **Who wrote it** — n/a: this follow-up opens no new case of this class.
