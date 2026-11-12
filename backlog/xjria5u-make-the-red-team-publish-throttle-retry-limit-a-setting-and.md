---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-withheld-publish.mjs", "we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Make the red-team publish throttle-retry limit a setting and fix background gh-slot starvation

we:scripts/lib/red-team-withheld-publish.mjs hardcodes THROTTLE_RETRY_LIMIT=24 (R905: move to the settings cascade). Also investigate why class=background gh reads starve for hours (#6706 publish failed on 'gh-throttle: no gh slot within 8s'), and whether escalation after 24 throttled ticks is the right threshold. From the R895+R903 residual on lane/red-team-publish-throttle@0d1ea00c10.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/red-team-withheld-publish.test.mjs` with a case that the throttle limit is read from the settings cascade (red before the setting exists).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] does not change the two-attempt budget for non-throttle errors.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
2. **Truncated reads** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
3. **Shared state files** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
4. **Fail closed** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
5. **Identity scoping** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
6. **State over time** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
7. **Who wrote it** — n/a: settings-only change; the throttle check reads a fixed message substring, never copies error text.
