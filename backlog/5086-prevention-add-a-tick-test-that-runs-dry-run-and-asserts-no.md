---
bornAs: xhczqp4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/heavy-run-ungated.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/__tests__/heavy-run-ungated.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a tick test that runs --dry-run and asserts no files are written under the health dir. A more… (from web-everything/web-everything#3933 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch.mjs:924` — Add a tick test that runs `--dry-run` and asserts no files are written under the health dir. A more general guard is a test that snapshots the health dir around a dry-run tick.
2. `we:scripts/conveyor/heavy-run-ungated.mjs:112` — Serialize the complete append/read/prune operation across processes and add a deterministic concurrency regression test that forces an append between another writer's read and prune; this guard needs a backlog filing.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3933@5bb2508ce28f0deb4819a6731dc2d9cd6202c172

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
