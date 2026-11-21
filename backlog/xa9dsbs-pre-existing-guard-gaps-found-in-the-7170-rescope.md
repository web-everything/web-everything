---
kind: task
status: open
scope: ["we:designs/pr7170-rescope-judgement.md", "we:scripts/__tests__/pr7170-guard-gaps.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Pre-existing guard gaps found in the #7170 rescope

From we:designs/pr7170-rescope-judgement.md section Pre-existing: _guard.sh HELD=1 trust; the npm shim misses test/run; permission-change misses scripts/**/*.json; tripwire identity pins; F11 roots. Source: build-queue 22:24 ET 2026-11-20.

## Acceptance

- [A1] **Executable · Planned** — Run `test_file=we:scripts/__tests__/pr7170-guard-gaps.test.mjs; npm run test:unit -- "${test_file#we:}"`; add these five regressions, exercising real shim processes and temporary filesystem fixtures:
  - `forged HELD=1 refuses admission`: a caller-set flag alone cannot bypass the guard; genuine admission still works.
  - `npm test and npm run test require admission`: both invocation forms reach the heavy-run guard; refusal never launches the runner.
  - `scripts JSON permission changes are classified`: nested scripts JSON widening is detected alongside existing source/config/data cases; unreadable evidence refuses clearance.
  - `tripwire identity pins reject mismatches`: a mismatched or missing required identity pin cannot satisfy a tripwire; the matching identity can.
  - `F11 roots enforce the documented boundary`: recover the cited rescope design to identify F11's exact roots, then test allowed roots, sibling/prefix lookalikes and outside-root paths; missing root evidence refuses clearance with an operator-visible reason.

## Non-goals

- [N1] No S1e environment narrowing, unrelated guard redesign, or new receive/write endpoint.

## Edge cases this change must handle

1. **Untrusted text** — Treat command text, paths and identity claims as inert data; adversarial fixtures must not execute embedded shell text.
2. **Truncated reads** — Incomplete or unreadable admission, identity or root evidence refuses clearance and names the missing evidence to the operator.
3. **Shared state files** — Use isolated temporary state; caller-set HELD flags cannot substitute for queue-owned admission evidence.
4. **Fail closed** — Keep refusal on verification errors; preserve coverage for source, docs, config and data rather than narrowing protection to code.
5. **Identity scoping** — Bind admission and tripwire evidence to the intended process/repository identity; reject sibling and prefix-lookalike roots.
6. **State over time** — Recheck expired or replaced admission/identity evidence before execution; stale evidence must not authorize a later run.
7. **Who wrote it** — Validate evidence against its trusted producer; caller-controlled environment variables or copied pins alone confer no authority.

## Duplicate admission

nd
