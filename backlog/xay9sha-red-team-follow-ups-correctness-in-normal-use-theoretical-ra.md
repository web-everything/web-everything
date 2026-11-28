---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7624 (head dc34d5ad1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7624 (reviewed head `dc34d5ad16e5b98ef5af65a45530a55d837914d5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/rebuild.mjs:510` — (edge-case, degraded) A reader active at slot acquisition disables heartbeats for the entire smoke
   - Scenario: After prepare releases the write lock, a sibling daemon acquires a read slot while the job waits for smoke capacity. When capacity arrives, heartbeat startup requests the write lock with waitMs: 0 and receives tick-in-progress. The smoke proceeds without a heartbeat, and startup is never retried even after the reader releases. With adoption older than 60 minutes, dispatch starts refusing once the lease exceeds 20 minutes despite a healthy, qualifying job still smoking. Heartbeat startup should recover after this temporary reader contention.
   - Class: correctness-in-normal-use (basis: Heartbeat startup in we:scripts/lib/daemon-rebuild/rebuild.mjs takes the write lock with waitMs: 0 and runs once, with no retry. In we:daemon-clone-lock.mjs, acquireWrite with a live non-ignored reader returns tick-in-progress at once. The job holds no lock while it waits for a smoke slot, so a sibling daemon can take a read slot in that gap. The smoke then runs with no heartbeat and the code logs an unconfirmed-owner line. The result falls back to the old 20-minute lease bound, so it fails safe. But a healthy qualifying job can still make dispatch refuse once its lease passes 20 minutes and adoption is older than 60 minutes.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break

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
