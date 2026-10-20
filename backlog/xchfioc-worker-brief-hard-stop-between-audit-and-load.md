---
kind: task
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Worker brief: hard stop between audit and load

Three times on 2026-10-19/20 a worker registered or loaded a daemon overlay before tests were green or before the read-only Codex audit said NOT WEAKENED (overlap-yield-blocked v1 rolled back; filing-on overlay registered pre-audit, unregistered by the orchestrator). Proposal: we:scripts/lib/daemon-load-overlay.mjs and we:scripts/daemon-overlay.mjs add refuse unless a recorded audit verdict (NOT WEAKENED for that exact sha) and a green test marker for that sha exist; we:scripts/worker-brief.mjs states the order. Deterministic, so it belongs in the tool, not in prose.

## Acceptance

- [A1] **Executable** — a test runs `daemon-overlay add` for a sha with no recorded audit verdict and expects refusal; with a verdict of NOT WEAKENED for that sha but no green test marker, expects refusal; with both for that exact sha, expects admission. Fails before, passes after.
- [A2] **Must** — a verdict for a different sha does not count. The check compares the full sha of the overlay being loaded.
- [A3] **Must** — a verdict other than NOT WEAKENED (WEAKENED, unclear, error, empty) refuses.
- [A4] **Must** — the refusal message names which of the two proofs is missing and the sha checked.
- [A5] **Must** — the worker brief states the order: tests green, then read-only audit, then register or load.
- [A6] **Must** — no override flag; the only way past is to record the real verdict and the real green marker.

## Non-goals

- [N1] Does not run the audit or the tests; it only checks that the records exist.
- [N2] Does not change what the Codex audit judges or how it is dispatched.
- [N3] Does not unregister overlays already loaded; that stays an orchestrator step.
- [N4] Does not cover non-overlay daemon changes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the verdict is read as a fixed enum from a structured record, not by searching free audit text for "NOT WEAKENED"; audit prose that quotes the phrase does not count.
2. **Truncated reads** — a record file cut mid-write fails to parse and counts as no verdict.
3. **Shared state files** — verdict and test markers are written atomically (temp file then rename) so a reader never sees a partial record.
4. **Fail closed** — missing, unparsable, or unreadable record: refuse.
5. **Identity scoping** — records are keyed by overlay and full sha; one lane's marker cannot satisfy another lane's overlay.
6. **State over time** — any new commit changes the sha, so an old verdict and marker stop applying; a rebase needs a fresh audit and fresh tests.
7. **Who wrote it** — only the audit dispatcher and the test gate write the records; a record written by the worker itself (hand-made marker) is not accepted, checked by the writer identity stored in the record.
