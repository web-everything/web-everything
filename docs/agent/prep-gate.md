# Prep gate (R282)

Before dispatching a build/fix agent that will publish code, or opening a PR through
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
accept Markdown prefixes. An operator can explicitly waive prep with
`prep: waived — <reason>` (at least four characters). Waivers append a local audit
event to `~/workspace/.operations/prep-gate.log`.

The shared exemption matcher covers conflict resolution, reruns, red-team work,
reviews, read-only work and card filing. For Agent/Task prompts, only the first
sentence or line within the first 240 characters of the trimmed prompt can grant
an exemption. Put the exempt task there, or supply PREP/a reasoned waiver; later
mentions never exempt a build. The case-insensitive, whole-word matcher gives any
occurrence of `implement`, `build`, `add`, `fix`, `refactor` or `write` in that
statement precedence over an exemption phrase. It does not parse grammar, so noun
uses of these words also count. Only these phrases at the start of the statement
(after optional whitespace) win over build words:

- `fix merge conflict` or `fix the merge conflict`, followed by optional whitespace
  and the end of the statement or one of `. ! ? , ; :`, or whitespace and the whole
  word `and`/`then` (so `fix merge conflict detector` still requires prep);
- `resolve conflict`, optionally with `the` and/or `merge` before `conflict`;
- `rebase onto`;
- `re-run CI`, `rerun CI` or `retrigger CI`;
- `file card` or `file item`, optionally with `a`/`the` and then `backlog` before
  `card`/`item`, or `card-only`;
- `review the PR`, `review this PR` or `code review`.

Except for the `fix merge conflict` boundary above, these are leading phrases;
any trailing text is allowed after the final word boundary. For example,
`fix merge conflict` is exempt, but `implement code review
guard` and `red-team; fix and open-pr` require prep. Other existing exemptions
still apply when none of the six build words occurs in the statement. Open-pr
matches exemptions against the entire title only (including `card-only`), never
the body, with the same precedence and leading-phrase allowlist.
Omitted/blank agent types are treated as
general-purpose; other read-only agent types are allowed. Hook exceptions warn,
log `hook-error`, and fail open. Open-pr skips prep for dry runs and warns/delegates
unreadable body files to its existing handling. Missing or incomplete readable prep
is refused. Tests inject readers/gates explicitly to isolate other runner checks.
