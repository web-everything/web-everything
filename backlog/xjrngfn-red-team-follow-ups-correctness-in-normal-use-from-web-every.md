---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7608 (head 8a9e0c9c0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7608 (reviewed head `8a9e0c9c00cc66c24cd0515faa1f6f1288fb2833`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:376` — (failing-input, degraded) Valid SCP-style origins without an owner directory are rejected
   - Scenario: In /ws/alpha with origin git(at)gitserver:alpha.git, run provision --pool=alpha --count=1 --dry-run. poolRepoName returns git(at)gitserver:alpha instead of alpha. Resolution incorrectly attempts primary discovery, then rejects /ws/alpha for the same mismatch. Acquire and list --acquirable also fail. These commands should recognize the matching caller origin and proceed.
   - Class: correctness-in-normal-use (basis: Evaluating the new comparison reproduced the incorrect pool name. A network-disabled Git trace confirmed that Git parses this origin as SSH host git(at)gitserver with repository path alpha.git. Full CLI verification was blocked by the checkout’s missing markdown-it dependency.)
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
