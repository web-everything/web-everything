---
bornAs: x7hy91b
kind: task
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/__tests__/daemon-rebuild-retired-sources.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Bind smoke-fallback adopted inputs to their registration

Found by the PR #5964 round-13 self-review. we:scripts/lib/daemon-rebuild/prepare.mjs binds the main plan's applied inputs to their registrationId (or stamps capturedAt), so a later re-registration of the same ref never inherits that build's mechanism pin. The smoke fallback plans built in we:scripts/lib/daemon-rebuild/smoke.mjs (planA2 set-aside and planB plain-main) are adopted through finalize with bare {ref, pr, sha} inputs: no registrationId and no capturedAt. we:scripts/lib/daemon-overlays.mjs#sameRegistration then falls back to the build's adoptedAt, which comes after smoke. Failing case: X (pr null, registration R1, tip touches mechanism files) is planned, smoke fails, X is re-registered pr-less as R2 a few minutes later, planA2 keeps R1's tip, passes smoke and is adopted. Next tick R2's branch is unavailable and prepare holds the build as pinned-overlay-unavailable on R1's pin. Fix: apply the same binding (registrationId from the registry snapshot the fallback plans were built from, else capturedAt of that snapshot) to every plan finalize adopts, not only the main one; add a test through the fallback path.

## Acceptance

- [A1] **Executable** — a new case in we:scripts/lib/__tests__/daemon-rebuild-retired-sources.test.mjs (run with
  `npm run test:unit -- <that file>`): the main candidate fails smoke, the ref is re-registered pr-less before the
  set-aside (or plain-main) fallback is adopted, and its branch is then unavailable. It fails today
  (`pinned-overlay-unavailable`) and passes once every adopted plan's inputs are bound or stamped.
- [A2] An adopted fallback record's `applied` inputs each carry `registrationId` or `capturedAt`, taken from the same
  registry snapshot the fallback plan was built from — never the adoption time.

## Non-goals

- [N1] Does not change how the main plan binds its inputs, or the archive ordering rules (`supersededSnapshots`).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external text; the inputs are registry entries and git shas.
2. **Truncated reads** — n/a: the registry snapshot is already in memory from preparation.
3. **Shared state files** — binding uses the snapshot the fallback plan was built from, not a fresh registry read, so a concurrent re-registration is told apart rather than adopted.
4. **Fail closed** — an input whose registration cannot be identified is stamped with the snapshot time, so it never pins a registration made later.
5. **Identity scoping** — match on registrationId (and PR when both name one), via `we:scripts/lib/daemon-overlays.mjs#sameRegistration`.
6. **State over time** — older adopted records without binding keep today's `adoptedAt` fallback; no migration needed.
7. **Who wrote it** — n/a: the rebuild daemon is the only writer of adopted records.
