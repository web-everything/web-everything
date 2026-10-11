---
kind: story
size: 3
status: active
scaffoldedBy: "fix-4791"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/pr-land.mjs", "we:scripts/lib/pr-limit.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-limit allow: check the grant's session at land time, not only the caller's cwd

Self-review of PR 4791 found the own-branch refusal in authoriseAllow keys on the caller's cwd and git config, which an agent controls: allow run from a dir outside any checkout, from a detached HEAD, or with pr-land pushing --ref=lane/x from a differently named local branch sees no own name, so the grant passes. allowBranch already records the granting session; pr-land's isBranchAllowedLive(REF) should refuse an entry whose session equals the pr-land caller's currentActorId. cwd-independent; closes the REF-differs-from-local-branch variant.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-limit.test.mjs`: a new case where the allow-list entry for `lane/x` records `session: S` and the over-limit open check runs as session `S` stays refused; the same entry checked as a different session is honoured. Red before, green after.
- [A2] An entry with no recorded `session` (written before xfaz7ho) is honoured as today.

## Non-goals

- [N1] Making the grant unforgeable — an agent with a shell can still change its own session env; this only removes the cwd/ref evasions.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the session id is compared as an exact string after trim; an empty id never matches.
2. **Truncated reads** — n/a: the store is one small JSON file read whole.
3. **Shared state files** — n/a: read-only at land time; writes stay with the existing atomic writer.
4. **Fail closed** — an unreadable caller session id refuses the self-grant match only when the entry's session is set; a missing store keeps today's fail-open-to-enforcement behaviour.
5. **Identity scoping** — the match is per session id, so the operator's own grant for a worker's branch is honoured.
6. **State over time** — expiry (`until`) is unchanged and checked first.
7. **Who wrote it** — this is the point: the entry's recorded session is the writer, and a writer may not use its own grant.
