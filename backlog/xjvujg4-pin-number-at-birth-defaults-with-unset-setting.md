---
kind: task
status: open
scope: ["we:scripts/lib/__tests__/card-number-allocator.test.mjs", "we:scripts/backlog/__tests__/number-at-birth-cli.test.mjs", "we:scripts/settings/number-at-birth.json"]
dateOpened: "2026-10-26"
tags: []
---

# Test birth-numbering defaults with enablement unset

PR #5958 review (2026-10-26), later-round card suggestions from simplicity and codex-correctness: existing tests explicitly enable birth numbering. Add a settings test with no environment, tool, or platform enablement override asserting the standard enabled=on and remote=best-effort values and provenance. Add a hermetic CLI case that leaves enablement unset, observes a numeric birth with a healthy stub transport, and observes hash fallback on an unavailable transport. Keep HOME and transport isolated, and ensure the test fails if the defaults become disabled or required. File these duplicate default-path observations together; this review repair must not change the default.

## Acceptance

- [A1] **Executable** — Run the allocator and number-at-birth CLI unit suites. With enablement absent from environment, tool, and platform settings, assert enabled=on, remote=best-effort, and standard provenance. An unset-enablement CLI creates a numeric card on healthy transport and a hash card during an outage.

## Non-goals

- [N1] Change settings defaults or merge this deferred suggestion into the coverage repair for PR #5958.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new text handling; test existing enum settings.
2. **Truncated reads** — Use unavailable transport evidence to test the default fallback.
3. **Shared state files** — Use temporary HOME, lock root, and state files for all probes.
4. **Fail closed** — Default best-effort falls back to a hash; existing explicit required mode must still refuse.
5. **Identity scoping** — Keep the numeric card and bornAs relationship asserted.
6. **State over time** — Leave the setting genuinely unset rather than supplying on explicitly.
7. **Who wrote it** — Hermetic Git stub only; never claim live production numbers.
