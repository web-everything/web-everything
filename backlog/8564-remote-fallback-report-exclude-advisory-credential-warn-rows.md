---
bornAs: xfb14r7
kind: story
size: 2
status: open
scope: ["we:scripts/lib/remote-fallback-log.mjs", "we:scripts/readiness/remote-fallback-report.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Remote fallback report: exclude advisory credential-warn rows from real-fallback counts

Of 252 rows in the fallback log, 158 are credential-warn advisory warnings, not Mac fallbacks. Add ADVISORY_REASONS and summarize(rows) to we:scripts/lib/remote-fallback-log.mjs, plus a we:scripts/readiness/remote-fallback-report.mjs (per-reason counts, top real cause, --json). The we:scripts/readiness/remote-exec.mjs writer half is a separate later item.

## Acceptance

- [A1] **Executable** — the report CLI with --json on the live file reports real fallbacks excluding credential-warn rows (94 at filing), top cause forge-unreachable.

## Non-goals

- [N1] No change to we:scripts/readiness/remote-exec.mjs or to what is written to the log.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — rows are bounded already; report prints reasons as plain text, skips unparseable lines.
2. **Truncated reads** — the log trims to its tail; a partial first line is skipped.
3. **Shared state files** — read-only.
4. **Fail closed** — a missing file reports zero rows, exit 0.
5. **Identity scoping** — n/a: one shared file.
6. **State over time** — counts cover whatever the file holds.
7. **Who wrote it** — n/a: report only.
