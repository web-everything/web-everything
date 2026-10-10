---
kind: story
size: 3
parent: "xayvwbh"
status: open
scope: ["we:scripts/lib/merge-queue-affected.mjs", "we:scripts/lib/__tests__/merge-queue-affected.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Merge-queue affected mode: cover shared-importer and fs-read couplings

**Status (PR 4689 review round 2):** coupling (1) below, the shared importer, is DELIVERED in PR 4689 itself (rule 5 of we:scripts/lib/merge-queue-affected.mjs: an unchanged test or spec file that reaches both a PR file and a main-changed file re-tests; the reverse graph of the tip is read in one batched git call; test case `[A1] an unchanged test that imports a PR file AND a main file`). What stays open here is (2) fs-read data, computed-path loads, and the non-source roots, plus the red-main replay corpus.

**Status (PR 4689 review round 4):** also delivered: (a) a changed non-source file (JSON, YAML, CSS, HTML, images, extensionless) on either side now re-tests (`data-file-changed`, rule 6), so data read through fs is no longer excused; (b) an entry point is a file nothing outside its own import cycle imports, so a closed cycle that CI runs is a meeting point, and an importer the PR itself changes does not count as an outside importer (the PR may drop it). Still open: `docs/` and `backlog/` files that a test or check:standards reads through fs stay exempt (`nonCodePaths`, the same policy as `any-code`; e.g. two cards with a colliding id added by main and the PR), source files read as text by a repo-scanning test, and computed-path loads.

**Accepted bound (operator ruling 2026-10-10):** a test that reads a changed SOURCE file through `fs` as text, with no import edge, stays unseen by the rule. Closing it would re-test a large share of PRs; tests still run on main and on the PR per settings, so any miss is caught eventually. The card stays open and still owns this (source-file fs reads), plus computed-path loads, `docs/` and `backlog/` readers and the red-main replay corpus. The rule is pinned by test `documented bound (card x0e6tik)`.

**Also owned here (PR 4689 review, ruled `card`):** deletion-driven resolution shadowing. A PR deletes the preferred resolution of an import specifier (the `foo` file), main changes the fallback (the `foo/index` file), and an unchanged importer names the specifier: the importer is reached from the PR side only, so the verdict is `main-delta-unaffected`. The fix is a deleted-file overlay on the importers lookup, the counterpart of the `prAdded` handling for added files.

Follow-up of PR 4689 review round 1 (security/gate-integrity, PLAUSIBLE). The affected re-test rule in we:scripts/lib/merge-queue-affected.mjs follows import chains in both directions, but still treated two couplings as unaffected: (1) a third unchanged file that imports both a PR-changed file and a main-changed file (a shared test or hub; now delivered, see above); (2) data read through fs instead of imported, such as a main-added repo-scanning test or a settings JSON a test reads (declared settings under scripts/settings are already gate files). Also not seen by the import parser: scripts spawned or loaded through a computed path (spawnSync of a script path, import of a pathToFileURL result, new URL of a relative file), and changed non-source files (HTML or CSS with imports) are never walked as roots. Replay the historical red-main pairs against the rule, add a corpus under we:scripts/lib/__tests__/ with the rule that catches each, and extend the rule (reverse closure to shared test files, bounded) only where a pair is missed, keeping the speed goal.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/merge-queue-affected.test.mjs` has a replay corpus case per historical red-main pair (and a shared-importer case) that asserts `affected: true`; it fails today for the shared-importer case.
- [A2] **Must** — a closure or graph that cannot be read or is too large still refuses to excuse the re-test (fail closed), and a changed data file (JSON, settings, fixtures) is treated cautiously, not as "no code".

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the `any-code` mode, and does not make every test file a gate file (that would erase the speed gain).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — file paths and import specifiers come from PR content; they are only matched against a file set, never executed or shelled.
2. **Truncated reads** — a changed-file list over the cap, or a closure over the cap, re-tests (existing too-many-files and closure-too-large reasons).
3. **Shared state files** — n/a: the rule is a pure read over git objects; it writes nothing.
4. **Fail closed** — an unreadable import list, a missing commit or a git failure re-tests; any new coupling check keeps that.
5. **Identity scoping** — the verdict is keyed by the PR head sha and main tip sha it was computed from.
6. **State over time** — the verdict is recomputed every drain pass from the current tip; nothing is cached across tips.
7. **Who wrote it** — n/a: the drain is the only writer of the merge decision; this rule only reads.
