---
bornAs: xbu87uk
kind: story
size: 3
status: resolved
scope: ["we:scripts/lane-whois.mjs"]
dateOpened: "2026-10-18"
dateResolved: "2026-10-18"
tags: []
---

# Host overload guard: cap concurrent lane-whois transcript greps and git gc across lanes

Live 2026-10-17 23:00-00:30 ET: host load ~98 on 12 cores, from `grep -hF -f lane-whois-patterns` over all ~/.claude/projects transcripts (we:scripts/lane-whois.mjs), several `git pack-objects` (gc), and vitest. It caused dispatch-smoke timeouts (431s and 468s) that rolled back the edge-loads of PR #5510 and PR #5551. [A1] Executable: a host-wide cap on concurrent lane-whois transcript greps and git gc runs, with a test that a second concurrent grep waits or refuses.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/lane-whois-cap.test.mjs` fails before (two concurrent greps both run) and passes after (second waits or refuses).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change what lane-whois reports.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no free text is parsed beyond existing validated fields.
2. **Truncated reads** — The change reads bounded inputs only; a truncated read counts as unknown, never as clear.
3. **Shared state files** — State files are written atomically through the existing helpers; no new shared file.
4. **Fail closed** — On any error the guard refuses or keeps the prior state, never silently proceeds.
5. **Identity scoping** — n/a: keyed by repo + PR number + head sha, as today.
6. **State over time** — Debounce or cursor state expires on its own and survives a restart.
7. **Who wrote it** — n/a: operator-facing tooling; authorship is not trusted for decisions.
