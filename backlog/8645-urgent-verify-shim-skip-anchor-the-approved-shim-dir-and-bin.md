---
bornAs: x2z0mo2
kind: task
status: open
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# urgent-verify shim skip: anchor the approved shim dir and bind tools to absolute paths

Follow-up to card xsut90f: anchor the approved shim dir to the launcher's real home (not any prefix), resolve symlinks, bind probed tools to absolute paths, classify relative PATH entries against the supplied cwd. Source: build-queue 02:37 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `rejects shim prefix lookalikes and symlink escapes` in `we:scripts/operations/__tests__/urgent-verify.test.mjs`: Use real directories and symlinks; assert neither a sibling prefix nor a link outside the approved directory receives the shim skip.
- [A2] **Executable** — Planned `anchors shim tools to real launcher home` in `we:scripts/operations/__tests__/urgent-verify.test.mjs`: Use a misleading supplied HOME and PATH; assert the approved directory comes from real launcher home and every probed tool uses an absolute executable path.
- [A3] **Executable** — Planned `resolves relative PATH against supplied cwd` in `we:scripts/operations/__tests__/urgent-verify.test.mjs`: Run from a different process cwd; assert relative PATH entries resolve against supplied cwd and cannot select the outside shim.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No expansion of approved shim locations.

## Edge cases this change must handle

1. **Untrusted text** — Treat PATH and cwd values as data.
2. **Truncated reads** — Unresolved home or tool paths cannot authorize a skip.
3. **Shared state files** — n/a: path-resolution fixtures need no shared-state writes.
4. **Fail closed** — Resolution errors refuse the shim skip.
5. **Identity scoping** — Bind home, cwd and tool identity to this launch.
6. **State over time** — A tool-path change invalidates the prior probe.
7. **Who wrote it** — Caller-supplied prefixes cannot establish approval.

## Duplicate admission

nd
