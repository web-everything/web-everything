---
bornAs: xfgw4ro
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-clone-entries.mjs", "we:scripts/lib/import-closure.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-31"
tags: []
---

# Daemon closure scoping: allowlist — on-mode excludes files only when the closure is positively complete

PR 6023 round 12 judge ruling: the denylist in we:scripts/lib/daemon-clone-entries.mjs and we:scripts/lib/import-closure.mjs keeps missing code-execution vectors (node -e/--eval/-p/--print, NODE_OPTIONS preload in the LaunchAgent plist, aliased Function constructor). Replace with an allowlist: on-mode drops files only when the closure is proven complete; else full rebuild. Shipped mode is shadow; not security.

## Design

On-mode (`closureScope.mode=on`) excludes a file from the rebuild only when the closure is positively complete. It refuses, and falls back to a full rebuild, on any preload, inline code, NODE_OPTIONS, dynamic-code or unanalyzable vector. A positive completeness proof is required; absence of a known-bad pattern is not proof. Shipped mode is shadow, so nothing changes until on-mode is enabled. Not a security boundary.

## MVP

An allowlist of understood entry shapes in we:scripts/lib/daemon-clone-entries.mjs (script file plus plain args, no node flags that run code, no preload env) and of understood import forms in we:scripts/lib/import-closure.mjs (static import, literal require). Anything else marks the closure incomplete.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/closure-scope.test.mjs` (the table test below) fails on #6023 head 585a37c4 and passes after.

## Test plan

One table, each row must make on-mode refuse (full rebuild):

| Vector | Refuses |
|---|---|
| `node -e` | yes |
| `node --eval` | yes |
| `node -p` | yes |
| `node --print` | yes |
| NODE_OPTIONS `--require` (plist) | yes |
| NODE_OPTIONS `--import` (plist) | yes |
| aliased Function constructor | yes |
| aliased eval | yes |
| dynamic `import(var)` | yes |
| `createRequire(var)` | yes |

## Proof plan

Each row is red on #6023 head 585a37c4 (the denylist lets it through) and green after. Record before/after run output in the PR.

## Non-goals

- [N1] Does not change shadow mode, and does not claim security; precision (dropping more files) belongs to the require() precision card, not this one.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are repo scripts and the daemon plist, not user text.
2. **Truncated reads** — an unreadable or partial file marks the closure incomplete and refuses.
3. **Shared state files** — n/a: read-only analysis.
4. **Fail closed** — core of the card: unknown means refuse.
5. **Identity scoping** — n/a: one daemon clone at a time.
6. **State over time** — a plist or entry changed after analysis is re-read each rebuild; no cached completeness.
7. **Who wrote it** — n/a: treated the same whoever authored the script.

## Follow-ups

- Precision work: we:backlog/7482-require-precision-in-the-fail-closed-closure-scan.md and we:backlog/7483-spawned-script-precision-in-the-fail-closed-closure-scan.md (loosen only after this lands).
- Consider enabling on-mode by default once the table is stable.
