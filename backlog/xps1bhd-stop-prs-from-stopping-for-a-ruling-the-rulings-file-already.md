---
kind: task
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Stop PRs from stopping for a ruling the rulings file already answers

20 PRs on 2026-11-20 stopped for a ruling. No fix exists. Add a fix slice so a stop that an existing standing ruling already answers resolves automatically. Source: lessons-report LESSON-CARD ruling-needed (8:38 PM ET).

## Acceptance

- [A1] **Executable** — Planned `resolves stop using matching standing ruling` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Supply a stop with one applicable standing ruling; assert automatic resolution without another human request.
- [A2] **Executable** — Planned `retains human stop for absent or ambiguous ruling` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Parameterize no matching ruling and competing applicable rulings; assert the stop remains for a human and no automatic resolution occurs.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No creation or extension of standing rulings.

## Edge cases this change must handle

1. **Untrusted text** — Stop text cannot invent a ruling.
2. **Truncated reads** — Incomplete ruling reads retain the stop.
3. **Shared state files** — n/a: matching does not author rulings.
4. **Fail closed** — Absent or ambiguous matches retain a visible human stop.
5. **Identity scoping** — Apply only the ruling relevant to the stopped PR.
6. **State over time** — Recheck when the ruling changes.
7. **Who wrote it** — Only the standing rulings source authorizes automatic resolution.

## Duplicate admission

new card from build-queue CARD line
