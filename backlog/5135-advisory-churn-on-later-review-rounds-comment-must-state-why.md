---
bornAs: xixs5h4
kind: story
size: 3
status: resolved
scope: ["we:scripts/lib/jury-core.mjs"]
dateOpened: "2026-10-05"
dateResolved: "2026-10-05"
tags: []
---

# Advisory churn on later review rounds; comment must state why not accept

On #3794 every review round found new advisory findings (14 fix starts, 4 pushes). Consider limiting later-round advisory findings to code the last fix changed, or a round cap before the escalation ladder. Also: the advisory comment must lead with a one-line reason the verdict is not accept (e.g. Changes: security owes a prevention card), since the operator read it as accepted.

## Done when

Rule: from round 2 on (a prior review comment names a reviewed head different from this one), an advisory-lens finding (any lens not in `MANDATORY_LENSES`) whose cited lines the latest fix range (`<prior reviewed head>..<this head>`) did not touch is moved to a "Card suggestions (filed later)" list and does not count toward `changes`. Mandatory lenses (correctness, security) are never scoped. Mandatory referrals are unchanged. Knob: `WE_REVIEW_LATER_ROUND_ADVISORY_SCOPE=changed-only|all`, default `changed-only`.

1. **Executable** — `npm run test:unit -- <files>` over `we:scripts/lib/__tests__/jury-core.test.mjs`, `we:scripts/operations/__tests__/review-pr.test.mjs` and `we:scripts/operations/__tests__/review-pr-io.test.mjs` fails before this lands and passes after. The new cases cover:
   - round 2, `changed-only`: an advisory finding on an untouched line (outside a 3-line window of every changed line) is deferred and the advisory outcome is `accept`; one on a touched line still counts.
   - a mandatory-lens (correctness or security) finding on an untouched line still blocks.
   - round 1, or `WE_REVIEW_LATER_ROUND_ADVISORY_SCOPE=all`, defers nothing.
2. **Must (on error, refuse to loosen)** — if the latest fix range cannot be read (prior head missing, `git diff` fails, unparseable output) or the knob holds an unknown value, the scope falls back to `all` and the comment says so. Same for one finding: a missing file, or a file whose changes are unknown (rename, deletion, binary), keeps the finding counted. Tested.
3. **Must (non-source inputs stay cautious)** — a finding on a non-source file (docs, config, data: anything not on the source-extension list, e.g. `.md`, `.json`, `.yml`, `.toml`, `.csv`) is never line-scoped: it is deferred only when the fix did not touch that file at all; any change to the file keeps it counted. A source finding with no line number is treated the same way. Tested.
4. **One-line reason** — the advisory note's first line is the marker followed by one line naming why the outcome is not accept, e.g. `Changes: security owes a prevention card (finding \`backlog/2940-….md:58\`)` or `Changes: codex-correctness advisory owes a prevention card (finding …)`; an accept says `Accept: no blocking findings on this head`. The marker stays the leading text so `countAdvisoryComments` still counts it. Tested.
5. **Replay** — one replay of PR #3794's real advisory rounds (findings + net-basis heads parsed from its comments, fix ranges from git) prints before/after counts of findings that count toward `changes`.

## Outcome

Replay of #3794's five advisory rounds (2026-10-05): advisory findings counted toward `changes` went from 5 to 4 (one `codex-correctness` finding on an untouched card moved to card suggestions). Mandatory lenses raised 24 of the 29 findings, and those stay blocking by design, so on #3794 most of the churn came from correctness and security, not from advisory lenses. The replay also found that a fix range spanning a rebase produces a diff over 1 MB, so the diff read now allows 64 MB (past that it still falls back to `all`).
