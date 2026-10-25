---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# gh-throttle waits the full 120 s for a slot, then runs the call ungated anyway

[held entry 308] (daemon-async-audit 2026-10-14, held) gh-throttle waits the full 120 s for a slot, then runs the call ungated anyway. 2,399 slot_timeout rows in 15.7 h (~80 process-hours/day). They were near zero before 01Z and 120–270/h after, once the paged snapshot listing began holding a slot. Fix tick averages 196 s of waits; build-dispatch loses 108 min/day. Fix idea: deferrable background reads (watchers, reconcile reads, open-PR fetch) set throttle.acquireTimeoutMs ~5–10 s and DEFER the PR or pass to the next tick on timeout, never run ungated. Interactive or write callers keep today's behavior. The limit is a cascade setting. Design: lazy (defer). Volume relief comes from 309/313/321 + the snapshot cache. Evidence: calls.jsonl outcome slot_timeout (waitedMs p50 120 s); scratchpad we:daemon-async-audit.md. Scope: we:scripts/lib/gh-throttle.mjs:212,1482-1488, callers' throttle opts. Size 2. | [held entry 338] (worker finding 2026-10-14 ~17:35 ET, held, HIGH) Host-wide gh stall: all 6 gh-throttle slots held for ~2 min every 10-20 min. Every waiting call times out at 120 s; this hit 13 of 158 min sampled and explains 300-450 s fast drains and smoke timeouts. The holder is unknown, and nested gh calls were ruled out. Fix idea: gh-throttle records the slot holder (pid, command, caller) and slot hold time, and reaps or alerts on a slot held longer than N s; a per-caller cap so one daemon cannot take all 6. Coordinate with #5288/#5290/#5276 (they touch gh-throttle). Prove: a stall shows its holder, and stalls stop.

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
