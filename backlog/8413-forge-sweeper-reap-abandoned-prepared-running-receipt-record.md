---
bornAs: x6mt3jt
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-sweep.mjs", "we:scripts/readiness/__tests__/forge-exec-sweep.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Forge sweeper: reap abandoned prepared/running/receipt records with owner-gone proof

we:scripts/readiness/forge-exec-sweep.mjs only expires .telemetry and .consumed receipts. Abandoned .prepared/.running/.receipt records keep their run dirs alive via hasLiveRecord and persist forever; the 7-day abandoned-reservation recovery is only partly mirrored. Add an age-bounded reaper with owner-gone proof (R951c, reinforce-later from the sweeper PR).

## Acceptance

- [A1] **Executable** — seed expired `.prepared`, `.running` and `.receipt` records; reclaim records and their run directories only under the matching exclusive worker lease, with a validated slot identity and proof that its owner and UID processes are gone. Preserve live, zombie, unreadable and unknown owners. Include a young completed-receipt grace case.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: reinforce-later card; handled when the story is built (see digest).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reinforce-later card; handled when the story is built (see digest).
2. **Truncated reads** — n/a: reinforce-later card; handled when the story is built (see digest).
3. **Shared state files** — n/a: reinforce-later card; handled when the story is built (see digest).
4. **Fail closed** — n/a: reinforce-later card; handled when the story is built (see digest).
5. **Identity scoping** — n/a: reinforce-later card; handled when the story is built (see digest).
6. **State over time** — n/a: reinforce-later card; handled when the story is built (see digest).
7. **Who wrote it** — n/a: reinforce-later card; handled when the story is built (see digest).

## Review prevention debt (PR #6916)

- Add a standards rule for privileged `we:scripts/readiness/forge-*.mjs` wrappers that rejects recursive `fs.rm`/`fs.rmSync` and requires descriptor-relative deletion. Audit the existing runner, warm-base and base-install removal paths before enabling the rule repository-wide; they predate the sweeper repair and are outside its source scope.
- Add a test-plan check requiring every documented safety default to name a test that omits that argument, and every exit-status guarantee to name a subprocess test of the production entrypoint. Fixtures must not duplicate production exit handling.
- Require tests for “held during” claims to observe the protected read or deletion between acquire and release, and probe the real lock from a competing process.
- The sweeper repair adds production-CLI coverage, lease ordering, replacement races and tombstone recovery. Abandoned execution records remain this card's separate owner-proof work; age alone must never authorize their deletion.
