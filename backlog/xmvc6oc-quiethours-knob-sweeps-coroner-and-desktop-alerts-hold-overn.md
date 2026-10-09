---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/quiet-hours.mjs", "we:scripts/lib/quiet-hours-io.mjs", "we:scripts/quiet-hours-settings.json", "we:scripts/conveyor/branch-sync.mjs", "we:scripts/operations/scheduled-sweep.mjs", "we:skills-src/conveyor/supervisor.mjs", "we:scripts/conveyor/driver-watchdog.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells-notify-list.mjs", "we:scripts/conveyor/health-smells/pre-existing-red-on-main.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# quietHours knob: sweeps, coroner and desktop alerts hold overnight, emergencies break through, one morning digest

Operator-approved 2026-10-08 (held item 134). Overnight desktop alerts and scheduled sweeps (we:scripts/operations/scheduled-sweep.mjs, the coroner and opus jobs) fire at any hour. Add one pure isQuiet(now, settings, toggle) + breakthrough rule in we:scripts/lib/quiet-hours.mjs, settings knobs in we:scripts/quiet-hours-settings.json (default 22:00-07:00 America/New_York), honour the operator quiet-mode toggle file in the handoff dir (shape {on, until}), let only emergencies (main red, a daemon down >30 min) through, queue the rest and send one digest when quiet hours end. Wire the shared notify choke point we:scripts/conveyor/branch-sync.mjs, we:skills-src/conveyor/supervisor.mjs, we:scripts/conveyor/driver-watchdog.mjs and we:scripts/conveyor/health-watch.mjs.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/quiet-hours.test.mjs` passes: isQuiet covers the overnight window across midnight and DST, the toggle file (on / until past / until future), emergencies break through (main red; daemon down >=30 min but not 10 min), and the digest is flushed once after quiet hours end.
2. **Live** — on the alert-emitting daemon clone, `node we:scripts/quiet-hours.mjs simulate --at=<23:30 ET>` shows a routine alert suppressed and a main-red alert delivered.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — alert titles/bodies are only stored in the digest file and re-shown capped (first 5 titles); never evaluated.
2. **Truncated reads** — a torn/garbage settings or toggle file falls back to the defaults / toggle off; a torn digest line is skipped.
3. **Shared state files** — the digest is append-only JSONL; the flush renames it away first so two flushers cannot both send.
4. **Fail closed** — any error in the quiet gate DELIVERS the alert (never silently drops one) — failing loud is the safe side for alerts.
5. **Identity scoping** — n/a: one operator, one machine; settings and toggle are host-wide.
6. **State over time** — toggle `until` in the past means off; the window is computed in the configured time zone so DST shifts are handled by Intl.
7. **Who wrote it** — the toggle file is operator-written; settings are repo-committed; the digest is written only by the gate.
