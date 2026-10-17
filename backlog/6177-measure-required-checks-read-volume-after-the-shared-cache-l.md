---
bornAs: xh2ch32
kind: task
status: open
blockedBy: ["5962"]
dateOpened: "2026-10-15"
tags: []
---

# Measure required-checks read volume after the shared cache lands (per-caller before/after)

After #5962 lands, count branches/<b> and rules/branches/<b> reads in the gh call log (op `required-checks`, filter out outcome not_modified) for one hour and compare with the ~322/h baseline from held finding 226, per caller (await-verify-loop children, ci-red-recovery-watch, reconcile-pass, reconcile-fix, review-daemon). The old plain `gh api` reads carry op `api` with no path, so the pre-change split must come from the finding, not the log. Expect about one counted revalidation per TTL per repo; if await-verify-loop children still read directly, trace which child issues them and route it through getRequiredStatusChecks.

## Acceptance

- [A1] **Executable** — a read-only report over the gh call log (`ghThrottleLogPath`, we:scripts/lib/gh-throttle.mjs) prints, for the last hour, the counted (not `not_modified`) `required-checks` reads grouped by `caller`, and the total is at most one revalidation per TTL per repo per read (about 4/h per repo per GET), against the ~322/h baseline. Before #5962 lands the same report prints zero `required-checks` rows (the old reads carry op `api`), so it fails the "total is at most" check by showing the unattributed `api` volume instead.
- [A2] **Executable** — the report names every caller that still shows `required-checks` reads above the bound, so a reader that bypasses the shared cache is traceable.

## Non-goals

- [N1] n/a: it measures only; it changes no reader. Routing a remaining direct reader through the cache is a separate card filed from this one's finding.

## Edge cases this change must handle

1. **Untrusted text** — the log is local daemon state; caller and op strings are printed as-is in a report and never reach a shell, argv or path (fold newlines with `foldUntrusted`, we:scripts/lib/jury-core.mjs, before printing).
2. **Truncated reads** — the log can be hundreds of thousands of lines; read it whole or fail with a named reason, never report a count from a truncated tail as the hourly total.
3. **Shared state files** — read-only; the log is appended by many processes, so ignore a final partial line rather than failing.
4. **Fail closed** — an unreadable or missing log is "unknown", never a count of zero.
5. **Identity scoping** — group by `caller` plus op; the log carries no repo, so state that the total spans every repo.
6. **State over time** — use the entry `ts` for the one-hour window, tolerate clock skew by ignoring future timestamps, and say which window was measured.
7. **Who wrote it** — n/a: the log is the operator's own local file; no label or comment grants trust from it.
