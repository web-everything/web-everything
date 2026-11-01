---
kind: task
status: open
scope: ["we:.github/workflows/ci.yml"]
dateOpened: "2026-11-01"
tags: []
---

# Unpin CI smoke job from ubuntu-24.04 back to ubuntu-latest once Playwright supports Ubuntu 26.04

ubuntu-latest moved to Ubuntu 26.04 and Playwright 1.58.1 rejects it ('Playwright does not support chromium on ubuntu26.04-x64'), turning main red at 78401f3ac4529853364df19a32592f88a4688df8 (CI run 41286677000, job smoke). The smoke job in we:.github/workflows/ci.yml was pinned to runs-on: ubuntu-24.04 as an emergency main-fix. Once a @playwright/test release supports ubuntu26.04 and the repo bumps to it, set smoke back to ubuntu-latest and confirm a green smoke run. The visual/update-visual-baselines jobs run in the version-locked jammy container and were not pinned.

## Acceptance

- [A1] **Executable** — `grep -n "runs-on: ubuntu-24.04" we:.github/workflows/ci.yml` finds no smoke-job pin, and the smoke job of the unpin PR's CI run on `ubuntu-latest` passes (no `does not support chromium on ubuntu26.04` error).

## Non-goals

- [N1] Does not touch the `visual` / `update-visual-baselines` jobs: they run in the version-locked `mcr.microsoft.com/playwright:*-jammy` container, so the host OS does not matter.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a runner-label change, no input parsing.
2. **Truncated reads** — n/a: no file reads.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — if smoke fails on ubuntu-latest, keep the pin; do not land the unpin.
5. **Identity scoping** — n/a: CI config only.
6. **State over time** — check the Playwright release notes for ubuntu26.04 support before unpinning; the pin is the safe state until then.
7. **Who wrote it** — n/a: no authored content is consumed.
