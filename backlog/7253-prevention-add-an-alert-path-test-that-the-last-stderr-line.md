---
bornAs: xmmqk8i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Add an alert-path test that the last stderr line survives redaction with a tail over 500 chars. T… (from web-everything/web-everything#5960 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:32` — Add an alert-path test that the last stderr line survives redaction with a tail over 500 chars. The durable fix is a tail-preserving redact/truncate helper (redact first, then `slice(-N)`) for `stderrTail`.
2. `we:scripts/lib/daemon-live-smoke.mjs:269` — Add a shared `redactDiagnostic` that also covers Bearer/Authorization headers, `://user:pass@` URLs, and common `*_KEY`/`*_TOKEN=` assignments. Require it, via a check:standards rule, for any field that copies child stderr into an alert or state. Add a table test with one non-GitHub secret per pattern.
3. `we:scripts/lib/__tests__/daemon-live-smoke.test.mjs:244` — Add a deterministic test named 'retains only the last six short stderr lines' using more than six lines whose combined length stays below 1200 characters, asserting the exact retained lines.
4. `we:scripts/lib/daemon-rebuild/smoke.mjs:35` — Add a deterministic end-to-end regression test with more than 1200 characters of informational stderr followed by a distinctive final error, asserting that the error survives in both alerts and held state.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5960@6b855389f3a61d57fe92840ad6b2682c6c9fcd79

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
