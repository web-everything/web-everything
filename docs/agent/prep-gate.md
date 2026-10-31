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
mentions never exempt a build. Explicit `implement`/`build` instructions, or `add`
instructions naming a feature, code, guard or function, take precedence over
exemption phrases in that statement. Open-pr matches exemptions against the title
only (including `card-only`), never the body, with the same build precedence.
Omitted/blank agent types are treated as
general-purpose; other read-only agent types are allowed. Hook exceptions warn,
log `hook-error`, and fail open. Open-pr skips prep for dry runs and warns/delegates
unreadable body files to its existing handling. Missing or incomplete readable prep
is refused. Tests inject readers/gates explicitly to isolate other runner checks.
