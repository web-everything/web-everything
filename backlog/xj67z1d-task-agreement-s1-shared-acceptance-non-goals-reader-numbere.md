---
kind: story
size: 3
parent: "5399"
status: resolved
scaffoldedBy: "agreement-s1"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/backlog/task-agreement.mjs", "we:scripts/lib/task-agreement-policy.json", "we:scripts/backlog/__tests__/task-agreement.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/lib/citation-check.mjs", "we:scripts/operations/codex-worker.mjs", "we:scripts/operations/sweep-orphan-backlog-cards.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-08"
tags: []
---

# Task agreement S1: shared Acceptance/Non-goals reader, numbered card sections, advise/enforce setting

Slice S1 of #5399 (operator rulings 2026-10-08: F3 = ## Acceptance + ## Non-goals with numbered - [A1]/- [N1] items; the legacy Done-when heading read as an Acceptance alias with positional ids; a draft marker exposed as draft:true). One pure shared reader returns {acceptance, nonGoals, legacy, draft, problems}; a committed setting file holds mode advise|enforce (default advise); the gates (check:standards rules, provenance escape zones, codex-worker and orphan-sweep card readers) treat ## Acceptance like ## Done when. The card-skeleton wiring in we:scripts/backlog/scaffold.mjs is deferred to we:backlog/xsxq4fj because PR #4463 held that file.

**Format for the refresh job.** Sections `## Acceptance` then `## Non-goals`, each a list of `- [A1] …` / `- [N1] …` items (`- [N1] n/a: <why>` when nothing is excluded). A machine-drafted section carries `<!-- agreement: draft -->` on its own line directly under its heading; `readTaskAgreement` reports it as `draft: true`.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/backlog/__tests__/task-agreement.test.mjs` passes (22 tests); it failed before this slice because `we:scripts/backlog/task-agreement.mjs` did not exist, and its six gate tests fail with the gate edits reverted.
- [A2] **Executable** — `readTaskAgreement` returns `{acceptance, nonGoals, legacy, draft, problems}`; reads `## Acceptance` / `## Non-goals` items `- [A1] …` / `- [N1] …`, the legacy `## Done when` alias with positional ids, and the `<!-- agreement: draft -->` marker as `draft: true`.
- [A3] **Executable** — `we:scripts/lib/task-agreement-policy.json` ships `mode: advise` and passes `validateTaskAgreementPolicy`.
- [A4] **Observable** — `npm run check:standards` reports 0 errors, and the check:standards rules (#4438 Must citations, #4738 unfinished placeholder, #4448 scope deliverables), the provenance escape zones, the codex-worker card reader and the orphan sweep read `## Acceptance` exactly as `## Done when`.

## Non-goals

- [N1] Wiring `renderTaskAgreementSkeleton` into `we:scripts/backlog/scaffold.mjs` — that file is held by PR #4463; we:backlog/xsxq4fj does it.
- [N2] S2–S5 of #5399: file-item advice, the prepare/dispatch gate, juror input, docs and the health-audit change.
- [N3] The one-off refresh of open stories (a separate job; it uses the format and draft marker defined here).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card bodies are parsed as text only; nothing is evaluated or passed to a shell.
2. **Truncated reads** — n/a: the reader takes a string; a missing section is reported as a problem, never as agreed.
3. **Shared state files** — n/a: the setting file is committed and read-only at runtime.
4. **Fail closed** — junk input never throws and reports both sections missing; TODO, bare `none` and prose-only items are dropped with a problem.
5. **Identity scoping** — n/a: item ids are local to one card.
6. **State over time** — legacy `## Done when` cards keep working through the alias until the refresh rewrites them.
7. **Who wrote it** — the draft marker separates machine-drafted sections from author-confirmed ones.
