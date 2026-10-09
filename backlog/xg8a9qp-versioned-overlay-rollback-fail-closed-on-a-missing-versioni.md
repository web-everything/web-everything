---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Versioned overlay rollback: fail closed on a missing versionId and on a throwing removeOverlay

Follow-up from #4481 review (operator approved with follow-up 2026-10-09); fix before #4433 versioned clones go live. In we:scripts/lib/daemon-load-overlay.mjs the versioned path (a) has a rollback test that asserts fixture fields that are undefined, so it passes vacuously; (b) returns early from rollBack when removeOverlayFn throws, skipping the version switch back; (c) fails open when the load result carries no valid versionId.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-load-overlay.test.mjs` fails on main and passes after, with one red-first case per defect (a), (b), (c).
- [A2] (a) The versioned rollback test asserts only fixture fields that are actually set; a field that is undefined in the fixture fails the test instead of passing vacuously.
- [A3] (b) When removeOverlayFn throws during a versioned rollBack, the version switch back to the previous version still runs, and the result reports the remove failure.
- [A4] (c) A load result with a missing or malformed versionId fails closed: no switch, a named refusal, never a silent success.

## Non-goals

- [N1] Turning on #4433 versioned clones; this only hardens the path before that.
- [N2] Changing the non-versioned overlay load path.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this follow-up opens no new case of this class.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — n/a: this follow-up opens no new case of this class.
4. **Fail closed** — (b) and (c) are fail-closed fixes: an error or a missing id refuses, never proceeds.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — n/a: this follow-up opens no new case of this class.
7. **Who wrote it** — n/a: this follow-up opens no new case of this class.
