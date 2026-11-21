---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild-job.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7196 (head eb5c34a0b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7196 (reviewed head `eb5c34a0b03277cb394327c2d5069201f1fde335`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/rebuild-job.mjs:289` — (edge-case, degraded) Early admission can suspend daemon ticks for 15 minutes before queuing a rebuild
   - Scenario: Enable early launch for daemon A while sibling daemon B shares its clone. With no rebuild job running, B holds a read lock during a long tick and main advances. Early admission calls adopt with readyOnly=true, selecting the detached child's 900,000 ms reader wait instead of ordinary admission's 60,000 ms. A's next scheduled tick awaits the watcher's pending launch, so it cannot run until B drains or that extended wait expires. The job has not yet been queued. Early enqueue admission should preserve the ordinary admission bound, leaving the long reader wait to the detached child.
   - Class: correctness-in-normal-use (basis: A read-only probe exercised the actual watcher and rebuild wait selection with an injected blocked lock. It observed a 900,000 ms early-admission budget versus 60,000 ms ordinarily, and confirmed that the scheduled tick remained blocked until admission resolved. The full wall-clock stall was not run; it follows under the supported shared-clone configuration with a long sibling tick.)
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
