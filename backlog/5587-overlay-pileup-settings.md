---
bornAs: xrxmm8e
kind: story
size: 5
status: open
scope: ["we:scripts/lib/settings-files.mjs", "we:scripts/settings/", "we:scripts/dispatch-settings.json", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/conveyor/health-smells/overlay-dropped.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Overlay pile-up: per-feature settings files, rebuild retry pass, overlay-dropped smell

Held item 168: the fix-daemon rebuild kept conflict-dropping overlays (#4527, #4560, #4510) because every feature appended keys to we:scripts/dispatch-settings.json. Settings now load from we:scripts/settings/<feature>.json merged with the frozen legacy file; planRebuild retries a conflict-dropped overlay once on the final tip; health smell overlay-dropped (high) names a registered overlay missing from the adopted build plus its conflicting files.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- <tests>` (we:scripts/lib/__tests__/settings-files.test.mjs, we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs, we:scripts/conveyor/health-smells/__tests__/overlay-dropped.test.mjs) fails on main (no per-feature reader or legacy-key guard; no retry pass; no smell) and passes after.
- [A2] Settings: one reader (we:scripts/lib/settings-files.mjs) merges the legacy we:scripts/dispatch-settings.json and every we:scripts/settings/*.json; the legacy file is left byte-identical and its current keys are frozen: a new key there, or one leaf owned by two files, fails the layout test. Resolved values are unchanged.
- [A3] Rebuild: a conflict-dropped overlay is retried once, plain merge only, on the final tip; a still-conflicting one stays dropped. The adoption verifier accepts the retried chain. No merge-gate guard changes.
- [A4] Smell `overlay-dropped` (high): fires for a registered overlay absent from the adopted build, names the PR and conflicting files, and says settings-only vs code conflict. Both say the PR must rebase; a settings-only conflict on the legacy file also says NOT to move existing keys, because the readers listed in `LEGACY_ONLY_READERS` (we:scripts/lib/settings-files.mjs) read only that file, and only a NEW key read through `readSettings()` goes in a feature file. Live fixture 2026-10-09.
- [A5] Live: on wev-fix-daemon, #4527 and #4560 are both ancestors of HEAD after this lands on the edge.

## Non-goals

- [N1] Not moving existing legacy keys out: any edit to the shared file conflicts with some open PR (live: #4527 was rebased onto the push-on-green keys mid-change). Moving them, and switching the other readers (we:scripts/lib/dispatch-throttle.mjs, the main-red freeze reader) to the merged reader, is a follow-up for a window when no open PR touches the file. Until then those direct readers are named in `LEGACY_ONLY_READERS` and pinned against the tree by we:scripts/lib/__tests__/settings-files.test.mjs; a new direct reader fails that test.
- [N2] No JSON-aware merge driver: the retry pass only re-runs the plain merge.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a broken settings file is skipped and named in `errors`; readers fall back to env/built-in.
2. **Truncated reads** — n/a: whole small JSON files; a parse failure is the broken-file case above.
3. **Shared state files** — the point of the change: features stop sharing one settings file; the smell only reads the rebuild alert/state files.
4. **Fail closed** — the retry pass only applies a clean merge; any git failure leaves the overlay dropped, as before.
5. **Identity scoping** — the smell's subject is per clone and per overlay ref.
6. **State over time** — a drop alert older than `freshMinutes` (30) or older than the overlay's auto-drop closes the episode.
7. **Who wrote it** — n/a: settings files and rebuild alerts are repo- and daemon-written, not user input.
