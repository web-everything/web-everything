---
kind: story
size: 2
parent: "4075"
status: open
blockedBy: ["4772"]
scope: ["we:scripts/lib/daemon-background-build.mjs", "we:scripts/lib/daemon-rebuild-builder.mjs", "we:scripts/lib/daemon-rebuild/rebuild-job.mjs", "we:scripts/lib/__tests__/daemon-background-build.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Delete the retired background-builder helpers and stop the rebuild job reading its consumed file as a corrupt job record

Follow-up of 5691 (x0m7a8x). (1) The background builder process is retired (no caller spawns it), but its record/spawn helpers in we:scripts/lib/daemon-background-build.mjs and the CLI we:scripts/lib/daemon-rebuild-builder.mjs stay, because PR #4772 held that file: delete them and their tests once #4772 lands; keep the settings, the swap spacing and the tick-starved smell. (2) Live 2026-10-10 fix-daemon log: every rebuild-job tick logs 'daemon-jobs: job record consumed is corrupt' because we:scripts/lib/daemon-rebuild/rebuild-job.mjs keeps its consumed-ids file (consumed dot json) inside the job store dir, which the run store lists as a job id. Move it out of the listed names (a dot-file) and add a test.

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
