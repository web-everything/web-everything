---
bornAs: xsg9540
kind: story
size: 3
status: open
scope: ["we:scripts/lib/tools-root.mjs", "we:scripts/lib/tools-root-guard.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/remote-exec.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Optional tools-location setting (tools.root)

Delivered by PR #6112 (R259 prototype; R280 retro card). Heavy tooling always ran from the lane's own checkout. An optional tools.root (platform-preferences) or WE_TOOLS_ROOT makes heavy-admission, remote-exec and verify-lane re-exec from a configured checkout, validated (absolute, repo checkout, outside .lanes, script present); invalid or unset runs locally. Core: we:scripts/lib/tools-root.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/tools-root.test.mjs` (delivered by #6112).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
