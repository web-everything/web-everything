---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/preview.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5809 (head fb017f506)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5809 (reviewed head `fb017f506957427e713896165831dda443f7d737`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/preview.mjs:284` — (edge-case, degraded) Repair admission rejects an existing overlay preserved through its stack top.
   - Scenario: With edge resolution disabled and default stack-tops planning: M0 contains a.txt=base and shared.txt=base. Register and adopt B0 (adds b.txt=B) and A0 (changes a.txt=OLD-A), in B,A order. Advance main to M1, changing shared.txt=main. Advance A to A1 with parents A0 and B0, setting a.txt=NEW-A and shared.txt=NEW-A. Now register repair R, branched from M1, which restores shared.txt=base, sets a.txt=NEW-A, and adds repair.txt. Existing-only planning pins A0 and restores B0 through stack fallback. Planning with R succeeds: R applies, A1 retries successfully, and A1 carries B0 by ancestry, so B nee
   - Claude's re-check: demonstrated break

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
