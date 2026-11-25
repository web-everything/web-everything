---
kind: task
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-fast-pass-acceptance.mjs"]
dateOpened: "2026-11-25"
tags: [testing, prevention]
---

# Measure ten live pending PR dispatches under host load after deploying fast pass

Deployment check owed by PR #7450. Fake-clock cadence, contention and slow-reader
tests are deterministic regression evidence; they cannot establish LIVE latency.
This check remains open until a deployed daemon produces the evidence.

## Acceptance

- Named probe: **dispatches ten pending PRs under host load within acceptance thresholds**.
- After the deployed daemon has loaded, collect ten distinct real PRs' GitHub
  `review:pending` label event timestamps, corresponding timestamped `dispatched`
  daemon log lines, and host load/core samples every ten seconds over the intervals.
- Keep load/core at least 0.4 throughout the sampled window and record the deployed
  SHA and daemon settings with the artifact. Exercise ordinary maintenance and real
  evidence reads; record main changes or refused admission rather than excluding them.
- Run `node we:scripts/operations/review-fast-pass-acceptance.mjs <evidence>`
  from the WE checkout, stripping the `we:` locus prefix before execution.
  Require all ten intervals at most 180000 ms and the median strictly below 180000 ms.
  Missing logs, missing/gapped load evidence, duplicates and timeout observations fail.
- Attach input and output evidence to the deployment record; do not close this card
  using synthetic fixtures. No live measurement was possible in the offline repair lane.
