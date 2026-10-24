---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-clones.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5866 (head df68b1d5a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5866 (reviewed head `df68b1d5a9bfda2b14d10d1b884c66faf3bf52e1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-clones.mjs:44` — (failing-input, degraded) Directory discovery swallows exceptions from an explicitly fail-closed onIncomplete callback.
   - Scenario: Call resolveDaemonClones with readdir throwing an EACCES error, clones: ['/extra'], and onIncomplete throwing an error to abort incomplete discovery. Probed result: the callback runs, but its exception is swallowed by listDaemonPlistFiles's catch around readdir; discovery returns [{path:'/extra',name:'extra',labels:[]}] successfully. The callback exception should propagate so the caller cannot mistake partial discovery for success.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-clones.mjs:23` — (edge-case, degraded) Filesystem aliases defeat clone exclusions and produce duplicate clone rows.
   - Scenario: On this host, /var points to /private/var. Using this checkout's /var/folders/.../we-review-seat-hmV2mL path in clones and its /private/var/folders/.../we-review-seat-hmV2mL realpath in excludeClones returns the excluded checkout with no incomplete notification. Supplying both paths in clones also returns two rows. Both outcomes were reproduced, with realpathSync confirming the paths identify the same checkout. Compare canonical filesystem identities for exclusion and deduplication so the checkout is excluded through either alias and otherwise appears once.
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
