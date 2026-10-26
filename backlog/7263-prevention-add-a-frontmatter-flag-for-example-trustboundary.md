---
bornAs: xtx8qri
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/prepare-decision-item/SKILL.md", "we:docs/agent/backlog-workflow.md", "we:scripts/worker-brief.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a frontmatter flag, for example trustBoundary: true, and have prepare-stamp or check:standard… (from web-everything/web-everything#5949 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/prepare-decision-item/SKILL.md:250` — Add a frontmatter flag, for example `trustBoundary: true`, and have `prepare-stamp` or `check:standards` refuse to stamp when the flag is set and the `## Trust boundary and threat model` heading is absent. Add a named test for the refusal.
2. `we:skills-src/prepare-decision-item/SKILL.md:252` — A docs link or anchor checker in check:standards that resolves `→` section references.
3. `we:docs/agent/backlog-workflow.md:610` — Add a `check:standards` rule or `prepare-stamp` precondition: a card whose body names trust-boundary markers (Codex output, subprocess, git remote, PR text) must contain the `## Trust boundary and threat model` heading.
4. `we:scripts/worker-brief.mjs:115` — Have the brief renderer or card frontmatter carry an explicit `trustBoundary: true` flag that the brief keys off, instead of relying on the worker's classification. Add a test where a flagged card without the section yields stop-and-report.
5. `we:skills-src/prepare-decision-item/SKILL.md:251` — Add a lightweight source-contract test for the workflow and preparation skill that asserts the required threat-model contents and the jury-before-stamping instruction.
6. `we:skills-src/prepare-decision-item/SKILL.md:251` — Add a deterministic instruction-contract test covering the required section, its specified contents, and design red-team review before stamping in the preparation skill and workflow documentation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5949@fc7b54cf2d213e92808f4c597789e5a5331336d0

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
