---
bornAs: xug05a8
kind: story
size: 2
status: open
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/settings/merge-queue.json", "we:scripts/conveyor/health-smells/"]
dateOpened: "2026-10-10"
tags: []
---

# Temporary policy overrides carry their own end condition

Held item 210 (session 2026-10-10). Twice today drain freshness was switched off/on by hand-editing the override file with an "until #4689 lands" note. Fix: override entries accept `until: { time | prMerged: N | liveOn: <clone>@<pr> }`; the settings resolver (we:scripts/lib/policy-cascade.mjs, plus the merge-queue settings loader) ignores an expired override and logs the reversion; a health smell lists active overrides with age.

## Acceptance

- [A1] **Executable** — tests: an override with `until.time` in the past is ignored and the reversion is logged; `prMerged` ends when the PR is merged; an override without `until` behaves as today.
- [A2] **Live** — the health smell lists active overrides with age.

## Non-goals

- [N1] Removing the ability to set an override with no end.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: settings files only.
2. **Truncated reads** — An unreadable `until` condition keeps the override and raises the smell (never silently reverts).
3. **Shared state files** — Override files are read-only to the resolver.
4. **Fail closed** — Unknown `until` kind -> keep override, alert.
5. **Identity scoping** — `liveOn` is scoped to one clone.
6. **State over time** — Expiry is checked on every resolve.
7. **Who wrote it** — The log names the override's author/reason when present.
