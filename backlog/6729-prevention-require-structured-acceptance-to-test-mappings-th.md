---
bornAs: xinx54f
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x5e50t3-dispatch-smoke-launcher-diagnostics-path-has-a-real-run-test.md", "we:backlog/xh6o4xy-tighter-redaction-of-the-local-stderr-diagnostics-file.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Require structured acceptance-to-test mappings through a deterministic card check. For this card,… (from web-everything/web-everything#5522 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6214-dispatch-smoke-launcher-diagnostics-path-has-a-real-run-test.md:12` — Require structured acceptance-to-test mappings through a deterministic card check. For this card, plan `real_launcher_failure_writes_private_diagnostics` in `we:scripts/lib/dispatch-smoke-launch.real-run.test.mjs`, explicitly asserting real subprocess failure, allow-listed summary output, and stderr-file mode 0600, with the Vitest command recorded.
2. `we:backlog/6215-tighter-redaction-of-the-local-stderr-diagnostics-file.md:12` — Require structured acceptance-to-test mappings through a deterministic card check. Plan `redacts_generic_key_assignments`, `redacts_multiline_quoted_credentials`, and `redacts_tail_inside_credential` in `we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.test.mjs`, each asserting credential bytes are absent; also name a repository-qualified test exercising worker-wrapper compaction and asserting its output excludes credential bytes.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5360, finding 4 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5522@8be5a616ca9523be54a4be4fb1dfbf5bae692bc7

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
