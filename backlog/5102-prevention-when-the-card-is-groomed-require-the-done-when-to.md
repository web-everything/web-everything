---
bornAs: xw4yqe9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — When the card is groomed, require the Done-when to be a real-device or emulated check, such as a Playwr… (from chalbert/web-everything#3823 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md:13` — When the card is groomed, require the Done-when to be a real-device or emulated check, such as a Playwright WebKit pinch/touch test, and not a prescribed mechanism. Fix the card text to name `touch-action: pan-x pan-y` or the gesturestart handler.
2. `we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md:12` — Add an automated mobile Safari gesture test asserting unchanged visual viewport scale after a pinch, and require it before completing this story; checking meta-tag or CSS values alone is insufficient.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3823@104e5e27f796f19f3b92ae44e66f798e17802b6f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
