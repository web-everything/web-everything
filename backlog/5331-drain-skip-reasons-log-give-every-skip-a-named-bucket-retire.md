---
bornAs: x2dhhsl
kind: story
size: 1
status: open
scope: ["we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Drain skip-reasons log: give every skip a named bucket, retire the 'other' bucket

Original incident: plateau-app #212 spent 86 drain passes in an unnamed bucket while WE #4288 was checks-pending. The requested named buckets and partner explanation now exist in this checkout; this card needs disposition rather than duplicate implementation.

## Done when

- [A1] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-skip-reasons.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — existing cases assert partner-pending for that incident, ready-not-reached for unvisited ready PRs, and unrecognized-reason instead of other. This is a shipped-behavior check, not a new red/green change; no missing implementation is established.

## Non-goals

- [N1] No merge-policy change, log backfill, new endpoint or guard relaxation; body-size/rate/CSRF checks are inapplicable to a pure log classifier.

## Edge cases this change must handle

1. **Untrusted text** — Keep raw reason text as JSON-escaped data; never execute it.
2. **Truncated reads** — Missing/unknown reasons map to unrecognized-reason, not an invented diagnosis.
3. **Shared state files** — n/a: classifier is pure; existing drain owns log emission.
4. **Fail closed** — n/a: classifications grant no merge permission.
5. **Identity scoping** — Rows retain repo and PR; couple explanations identify the partner.
6. **State over time** — Classify each pass independently; do not rewrite historical log rows.
7. **Who wrote it** — source records the drain bucket; reasons are observations, not operator rulings.

## Grounding

`we:scripts/lib/drain-skip-reasons.mjs:13` lists all requested buckets; `we:scripts/lib/drain-skip-reasons.mjs:81` identifies the partner. `we:scripts/lib/__tests__/drain-skip-reasons.test.mjs:35` reproduces the exact incident; line 43 rejects other.

## Open questions

STALE: should this card be closed as already implemented? Matching code and regression assertions exist. The queued regression attempt was deferred by host load (exit 75); no passing run is claimed.
