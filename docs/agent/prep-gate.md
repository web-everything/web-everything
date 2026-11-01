# Prep gate (R282)

Before dispatching a build/fix agent, or opening a PR through
open-pr, include this block in the prompt and PR body:

```text
PREP:
Acceptance: <observable criteria>
Pre-mortem: <likely failure and mitigation>
Files: <expected paths>
Tests: <checks to run>
```

Each heading needs an inline item or continuation/bullet item with at least eight
non-whitespace characters; placeholders do not count. Headings ignore case and
accept Markdown prefixes, as does the `PREP:` start marker, which may have trailing
text. A Markdown heading (`#` through `######` followed by whitespace) other than
the four PREP headings ends the current section; following prose cannot fill it.
An operator can explicitly waive prep with
`prep: waived — <reason>`. Reasons follow the same eight non-whitespace character
and non-placeholder rules as section items. Waivers append a local audit event to
`~/workspace/.operations/prep-gate.log`. Audit-write failures emit a stderr warning
and proceed; the escape remains available when the log is unwritable.

The shared exemption matcher accepts explicit leading tasks for conflict
resolution, CI reruns, PR reviews, red-team work and card filing. For Agent/Task prompts, only the first
sentence or line within the first 240 characters of the trimmed prompt can grant
an exemption. Put the exempt task there, or supply PREP/a reasoned waiver; later
mentions never exempt a build. Only these case-insensitive phrases at the start
of the statement (after optional whitespace) grant an exemption:

- `fix merge conflict` or `fix the merge conflict`, followed by optional whitespace
  and the end of the statement or one of `. ! ? , ; :`, or whitespace and the whole
  word `and`/`then` (so `fix merge conflict detector` still requires prep);
- `resolve conflict`, optionally with `the` and/or `merge` before `conflict`;
- `rebase onto`;
- `re-run CI`, `rerun CI` or `retrigger CI`;
- `file card` or `file item`, optionally with `a`/`the` and then `backlog` before
  `card`/`item`, or `card-only`;
- `review the PR`, `review this PR` or `code review`;
- `red-team the PR`, `red-team this PR`, `redteam the PR` or `redteam this PR`.

`card-only` and `code review` require the end of the statement or one of
`. ! ? , ; :` after optional whitespace, so `card-only workflow` and
`code review guard` are not exempt. The other entries are leading phrases with
a final word boundary. For example,
`fix merge conflict` is exempt, but `implement code review
guard` and `red-team; fix and open-pr` require prep. Bare labels such as `jury`,
`read-only` and `merge conflict` never exempt a build, including when followed by
a newline and build instructions. Open-pr
matches exemptions against the entire title only (including `card-only`), never
the body, with the same leading-task allowlist.
Only the known read-only agent types `Explore`, `Plan` and `claude-code-guide`
bypass the dispatch gate (case and surrounding whitespace are ignored).
All other types, including `fork`, `statusline-setup`, custom types and omitted/blank types,
require preparation when the prompt contains `implement`, `build`, `add`, `fix`,
`refactor` or `write` as a whole word, regardless of publication wording. This
includes `Build locally`, `Fix the parser bug` and `Implement retry logic and commit`.
Hook exceptions warn,
log `hook-error`, and fail open. Open-pr skips prep for dry runs and warns/delegates
unreadable body files to its existing handling.

Open-pr is currently in **advisory rollout**: missing or incomplete readable prep
emits `open-pr: prep advisory` and logs `prep-advisory`, then continues through all
existing review and publication checks. This applies to every caller, including
held-cards, orphan-claim-release, sweep-orphan-backlog-cards, codex-worker and
main-ci-red. Their generated titles/bodies have not all been migrated to PREP.
Do not enable enforcement until every automated producer has been enumerated and
its generated payload passes a deterministic prep admission test. There is no CLI
mode switch; strict admission remains injectable for tests, including filesystem
path parity regressions. The production default is covered without an injected
prep verdict. Dispatch enforcement is active during this rollout.

For `--body-file`, the prep gate and any pre-PR review bypass body copy use
pr-land's `expandHome` behavior: replace **any** leading `~` with `homedir()` via
`replace(/^~/, homedir())`. This includes `~draft.md` and `~someone/body.md`,
which concatenate the home directory with the suffix rather than resolve a user
name. `scripts/__tests__/open-pr-prep.test.mjs` checks that the gate and bypass
copy read the same file selected by that expansion.
Both reads use the publisher's working directory for relative paths and preserve
symlink/`..` segments for filesystem traversal; lexical path normalization can
select a different body file.
