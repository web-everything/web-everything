---
kind: story
size: 2
status: open
scope: ["plateau:src/wip/glance/glance-mount.ts", "plateau:src/wip/glance/glance-view.ts", "plateau:src/wip/glance/glance-deeplink.test.ts"]
dateOpened: "2026-10-09"
tags: []
---

# /wip deep links: apply ?card= and ?agent= only to the real snapshot, never the fallback sample

Follow-up from plateau-app #217 (card 5358, P3 of 128; operator approved with follow-up 2026-10-09). The deep-link once-flags (scroll-once, open-agent-once) are spent on the fallback sample rendered before the real snapshot arrives, so the link never applies to real data. Apply deep links only to the real snapshot; add tests for scroll-once and the 128-char cap on the link value. Scope is the #217 glance files; confirm against the card at pickup.

## Acceptance

- [A1] **Executable** — a glance deep-link test fails on the #217 head and passes after: with the fallback sample rendered first and the real snapshot arriving later, `?card=` scrolls and highlights on the real snapshot, and `?agent=` opens the panel there.
- [A2] The once-flags are spent only on the real snapshot, never on the fallback sample.
- [A3] Tests cover scroll-once (a later snapshot refresh does not scroll again) and the 128-char cap on the link value (a longer value is ignored, not truncated into a match).

## Non-goals

- [N1] New deep-link parameters.
- [N2] Changing the fallback sample itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the query value is capped at 128 chars and matched as text, never injected as HTML or a selector.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — n/a: this follow-up opens no new case of this class.
4. **Fail closed** — n/a: this follow-up opens no new case of this class.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — scroll and open happen once per page load, not per snapshot refresh.
7. **Who wrote it** — n/a: this follow-up opens no new case of this class.
