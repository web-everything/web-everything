---
bornAs: xx8epqz
kind: story
size: 3
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-10-18"
tags: []
blockedBy: ["6265"]
---

# we: 6265 slice 4 - a crash after an active override publish must still clear its alarm

Follow-up to open prerequisite #6265: recover active override publications that reached the feed before a crash prevented saving openKeys. Reconcile durable active/clear events in order so expiry or safe replacement can clear an alarm even when the state file never recorded it.

## Acceptance

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — add `a crash after publishing an active override clears it once it expires`: use real temporary files, persist an active feed line with empty saved openKeys, expire the entry, then restart runOnce. Assert one clear, no ended event, and no active entry in unacknowledged(); a second run emits nothing. Fails with state-only reconciliation.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — repeat for safe supersession, a still-active entry (no duplicate or premature clear), and active-then-cleared durable history with stale state (no resurrection or duplicate clear). Keep ended one-shot items out of recovered openKeys.
- [A3] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — unreadable override history/current view retains recovered active keys and raises the #6265 alarm; the next readable run clears once. A complete PR source still clears its own keys independently.

## Non-goals

- [N1] No general transaction journal or recovery rewrite for PR events; no change to operator acknowledgement or override policy.

## Edge cases this change must handle

1. **Untrusted text** — Recover only parsed event identities; instructions mentioning another key cannot create or clear that key.
2. **Truncated reads** — A partial trailing line is not a completed event; use complete preceding records and do not infer a clear from missing history.
3. **Shared state files** — Replay, reconciliation, append and atomic state update share the feed-state lock; scope recovery to the selected feed.
4. **Fail closed** — Unreadable feed aborts without advancing state; incomplete override reads retain active alarms rather than clearing them.
5. **Identity scoping** — Only operator-override PR 0 active keys participate; distinguish entryId, ended events, and clear events via their was field.
6. **State over time** — Replay clears as well as opens in publication order, ignoring acknowledgement as evidence of lifecycle completion; repeated recovery must be idempotent.
7. **Who wrote it** — Preserve original override attribution; a recovery clear refers to the original entryId. No HTTP endpoint or remote reset trigger is introduced, so HTTP abuse controls are inapplicable.

## Grounding

- we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:6 is open; its planned implementation introduces override publication.
- we:scripts/operations/needs-you-feed.mjs:96 diffs only supplied previous keys; lines 196–199 append before saving openKeys.
- we:scripts/operations/needs-you-feed.mjs:155 replays clears using was; line 130 namespaces sidecars by feed path.
