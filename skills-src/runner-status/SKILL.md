---
name: runner-status
description: Read runner liveness, tick activity, in-flight dispatches, and recent outcomes through the declared runner-activity operation. Use when asking whether the conveyor driver is alive, idle, stalled, or dispatching work.
---

# Read runner activity

## One call

Replace the repeated `ps` + tail-the-log + `git log` triangulation with:

```bash
node scripts/operations/run.mjs runner-activity --json
```

Read `verdict` in the standard operation envelope. Use `--limit=N` for the last N terminal
dispatch records (default 10). See [the report contract](../../docs/agent/testing.d/036-runner-activity-report.md#runner-activity-report).

## Read the evidence

`verdict.runners` is an array with one entry per known standalone daemon — `dispatcher`,
`fix-dispatch`, `review` — each with its own `state`/`stalled`/`stalledReason`/`alive`/`pid`/
`heartbeatAt`. The top-level `state`/`stalled`/`stalledReason`/`dispatching` mirror the `dispatcher`
entry specifically (the conveyor's mechanized tick driver); read `runners` by `name` for the other
two daemons' health.

A quiet daemon is not necessarily stalled. Use `stalled` and `stalledReason` rather than guessing
from an empty dispatch list. `state` describes driver health; `dispatching` separately reports
whether an in-flight dispatch session is actually listed alive. Planned dispatches are not launches.

The singleton lease supplies PID and heartbeat; the existing driver-status file supplies the real
tick timestamp and number. There is no invented heartbeat or tick proxy. A missing tick is reported
as null. Older terminal dispatch records may use a clearly labeled last-attempt ordering proxy.

## Read only

This is a READ: it never restarts anything and never clears or reaps any record. It does not run a
new tick or persist liveness stamps. The standard CLI may append its ordinary call-log entry.
A read timeout or unreadable required source is an error, not evidence that the runner is down.
