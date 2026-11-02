---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/candidate.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Port fallback-registration handling to smoke after #6033 lands

Dropped from the thin split of #6044 because it depends on #6033 registration generations. Source: branch lane/rebuild-parent-reader (#6044), we:scripts/lib/__tests__/daemon-rebuild-fallback-registration.test.mjs and the we:scripts/lib/daemon-rebuild/smoke.mjs, we:scripts/lib/daemon-rebuild/adopt.mjs, we:scripts/lib/daemon-rebuild/candidate.mjs hunks versus lane/overlay-generation-s1-r2. Findings verbatim: Drop the fallback-registration code that depends on #6033 (we:scripts/lib/daemon-rebuild/smoke.mjs:747 path) and file it as a card. Blocked by #6033.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-rebuild-fallback-registration.test.mjs` (ported from #6044) passes on main after #6033 lands.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: port only; no new behaviour beyond #6044.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: ported verbatim from #6044; re-audit when ported.
2. **Truncated reads** — n/a: ported verbatim from #6044; re-audit when ported.
3. **Shared state files** — n/a: ported verbatim from #6044; re-audit when ported.
4. **Fail closed** — n/a: ported verbatim from #6044; re-audit when ported.
5. **Identity scoping** — n/a: ported verbatim from #6044; re-audit when ported.
6. **State over time** — n/a: ported verbatim from #6044; re-audit when ported.
7. **Who wrote it** — n/a: ported verbatim from #6044; re-audit when ported.
