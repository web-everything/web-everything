---
bornAs: xayqavf
kind: story
size: 5
status: active
scaffoldedBy: "fix-5775"
dateScaffolded: "2026-10-22"
scope: ["we:scripts/lib/lane-git-hardening.mjs", "we:scripts/lane-pool.mjs", "we:scripts/lane-whois.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Daemon git in an untrusted lane: replace the known-bad-key list with a deny-by-default runner

Raised by PR #5775's fix rounds. Every round found another lane-config key that runs code from daemon-side git in an agent-writable lane (core.fsmonitor, diff.external, pager, then log.showSignature + gpg.program, core.alternateRefsCommand, promisor lazy fetch, filter drivers). The shared hardening (we:scripts/lib/lane-git-hardening.mjs) pins a list of known-bad keys, so the next unlisted key gets through.

Open gaps after PR #5775:
- Clean/smudge filter drivers still run on read-only paths that cannot scrub: the whois CLI and lane-pool status/scan, plus the reclaim proof that runs before the salvage scrub. No env pin reaches them.
- The whois tryGit spreads caller opts after env, so a future caller that passes opts.env silently drops the hardening.

Ask: one deny-by-default runner for git in a lane. For example, refuse (or scrub, where a write is allowed) any lane whose local/worktree config holds a key outside an allow-list, then route every lane-pool, whois, salvage, history, litter and repair git call through it.

Acceptance: a test that sets every git config key documented to name a command (from git help config) to a marker script in a lane, then runs status, release, reclaim --salvage and whois, and asserts the marker never runs.

## Merged item (was xl4yb58)

**Lane config scrub keeps origin's uploadpack/receivepack/vcs and an unsafe origin url, so a lane can still name a command git runs on fetch/push**



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
