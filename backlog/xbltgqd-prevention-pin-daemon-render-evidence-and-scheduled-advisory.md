---
kind: task
status: open
dateOpened: "2026-11-25"
tags: []
---

# Prevention: pin daemon render evidence and scheduled advisory repair contracts

Prevention owed by PR #7491's 2026-11-25 advisory review, including codex-correctness/COVERAGE. This card also groups the six later-round card suggestions by their three distinct subjects: repository scoping, read-only missing-table reporting, and unreadable filesystem evidence. Duplicate suggestions share the same acceptance below.

The PR repair adds a deterministic scheduled-frontierui integration test: resolve the actual table pass through the manifest, run one daemon iteration with controlled GitHub reads and a label provider, and assert both label transitions on PR #59. It also pins all three advisory repository scopes, both deferred ci-red-recovery jobs, and missing-plutil classification. Preserve these regressions while adding the remaining evidence tests below. The integration fixture is controlled; it does not prove host installation or a live label write.

## Acceptance

- [A1] **Executable** — Add a named `--check` test that removes a scheduled sibling from its injected table, asserts its exact missing-table report and nonzero exit status, and asserts no filesystem writes, job installation, or child launch. Keep the existing installed-reader contract tests passing.
- [A2] **Executable** — Add direct `readInstalled` tests for a dangling plist symlink and an EACCES stat/read path. Both must remain unreadable, never `PLIST_NOT_INSTALLED`. Use controlled filesystem errors so the EACCES case remains deterministic under elevated test privileges.
- [A3] **Executable** — Preserve the scheduled-frontierui one-sweep integration test, both exact repository-scope assertions, explicit ci-red-recovery deferral assertions, and the existing-plist/missing-plutil regression in `we:scripts/operations/__tests__/daemons-render.test.mjs`. A mutation that drops either label transition, changes either sibling repository, or treats a foreign ENOENT as absent must redden its named test.
- [A4] **Operational** — After the operator installs the sibling plists using PR #7491's install procedure, record the job label and reviewed head, run one frontierui sweep, then read frontier-ui/frontierui PR #59's live labels. Verify `advisory:accepted` is present and `review:awaiting-advisory` absent when a trusted covering accept advisory still makes the PR eligible. If the live head or eligibility changed, record that fact and use a controlled eligible PR; do not infer success from dry-run output. Record that `review:human` remains present.

## Non-goals

- [N1] Installing or bootstrapping jobs from tests, enabling the deferred ci-red-recovery jobs, or changing any review verdict or human hold.

## Edge cases this change must handle

1. **Untrusted text** — Use fixed comment fixtures with an explicit trusted author and current reviewed head; arbitrary comment text must not authorize a write.
2. **Truncated reads** — n/a: these cases use complete controlled evidence; production pagination behavior is unchanged.
3. **Shared state files** — Use isolated temporary directories; snapshots of installed artifacts must remain unchanged after `--check`.
4. **Fail closed** — A tool-spawn ENOENT, EACCES, dangling symlink, or malformed evidence stays unreadable. Only a confirmed missing plist receives the dedicated absence marker.
5. **Identity scoping** — Assert exactly one correct `--repo=` for each advisory manifest entry and the target repository on both live reads and writes.
6. **State over time** — The single iteration must produce both label changes; post-install proof must read the resulting live state.
7. **Who wrote it** — Retain the trusted-author filter and preserve the human review hold.
