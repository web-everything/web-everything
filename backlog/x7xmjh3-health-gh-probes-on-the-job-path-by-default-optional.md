---
kind: story
size: 2
parent: "xz2yynk"
status: open
scope: ["we:skills-src/conveyor/daemon-manifest.mjs", "we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Health gh probes on the job path by default (optional)

Optional slice S8 of the async-daemons epic. Health gh probes already have a job-path switch (we:skills-src/conveyor/daemon-manifest.mjs around :222); make the job path the default. Filed unqueued: the operator decides.

## Acceptance

- [A1] **Live** — the health tick goes from about 150 s to under 30 s.

## Non-goals

- [N1] Adding new probes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: probe output is not shown as raw text.
2. **Truncated reads** — A probe job that has not finished reports `unknown`, not healthy.
3. **Shared state files** — Probe records in the job store.
4. **Fail closed** — Probe failure -> `unknown` plus alert, never silent green.
5. **Identity scoping** — Keyed by probe and repo.
6. **State over time** — Stale probe results expire by age.
7. **Who wrote it** — n/a: the health daemon owns its probes.
