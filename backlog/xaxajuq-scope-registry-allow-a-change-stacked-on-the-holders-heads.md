---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/free-scope-cli.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Scope registry: allow a change stacked on the holders' heads

we:scripts/operations/free-scope-cli.mjs refuses any overlap, so a prototype hook built ON TOP of the open PRs that hold a file is refused like an unrelated edit. Live 2026-10-20: we:skills-src/conveyor/review-daemon.mjs was held by PRs #5768/#5769/#5771 and blocked 3 small fixes in one evening (stale cap message, refill hook, auto-refresh). Proposal: register --stacked-on=<branch|sha> is admitted when that base contains every holder's head (git merge-base --is-ancestor per holder), logged with the holders listed; anything else is still refused. Also: a release with an owner-token mismatch (release --agent=review-cap-reason-refresh printed 'released 0') should say why.

## Acceptance

- [A1] **Executable** — a test in the free-scope test file registers scope with `--stacked-on=<sha>` where the base contains every holder's head and expects admission; the same call with a base missing one holder's head expects refusal. Both fail before this lands (the flag is unknown) and pass after.
- [A2] **Must** — admission needs `git merge-base --is-ancestor <holder-head> <base>` to succeed for EVERY holder; one missing holder, or any git error, means refuse (fail closed).
- [A3] **Must** — every stacked admission is logged with the base, its resolved sha, and the list of holders (PR number and head sha); `list` shows the registration as stacked.
- [A4] **Must** — the loosening applies to code files only. A held docs, config or data file (backlog cards, settings, state files) is still refused with `--stacked-on`, because stacking order does not make concurrent edits of those safe.
- [A5] **Executable** — `release --agent=<name>` with an owner-token mismatch prints the reason (token mismatch, or no such registration) instead of only `released 0`; a test asserts the message.
- [A6] **Must** — with no `--stacked-on`, behavior is byte-for-byte as today: any overlap is refused.

## Non-goals

- [N1] Does not merge, rebase, or reorder the holders' PRs, and does not decide landing order.
- [N2] Does not admit overlap with holders that are NOT ancestors of the base, and does not add an override flag.
- [N3] Does not change how holders are discovered (open PRs and registered agents).
- [N4] Does not fix the three review-daemon edits themselves; those are separate cards.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the `--stacked-on` value is passed to git as an argument list (never a shell string), rejected if it starts with `-`, and resolved with `rev-parse --verify` before use. Branch names and PR titles in the log are treated as text.
2. **Truncated reads** — a holder list cut short by an API page limit or timeout must not read as "all holders". If the PR list is flagged truncated or fails, refuse.
3. **Shared state files** — the registry file is read and written by many agents; the stacked flag is recorded in the same locked write as the registration, so no half-written entry exists.
4. **Fail closed** — unknown base, unreachable holder head (not fetched), git error, or a missing holder sha: refuse and say which holder failed.
5. **Identity scoping** — the holder's head is the PR head of THAT PR (not a same-named branch of another repo); a stacked registration is owned by the registering agent and release is checked against its owner token.
6. **State over time** — a holder can be force-pushed, rebased or merged after admission. Admission records the head sha it checked; `list` re-evaluates and flags a stacked registration whose holder head moved off the base's history. A merged holder drops out of the holder set.
7. **Who wrote it** — the holders' PRs may be written by other agents or by the operator; the check is by git ancestry, not by author, so a bot-written holder is treated like any other.
