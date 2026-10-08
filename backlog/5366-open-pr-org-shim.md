---
bornAs: xpd70wx
kind: story
size: 3
status: resolved
scaffoldedBy: "open-pr-org-token"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/gh-app-shim.mjs", "we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-08"
tags: []
---

# open-pr / pr-land resolve the gh shim for the target repo's org (plateau PRs via the normal flow)

`open-pr` / `pr-land` fell back to the stale legacy `gh-shim/gh` (no per-org token map) when the caller's env had no App config, so a plateauapp PR could not be opened through the product (plateau-app#217 got raw `gh pr create`: no label-on-green, no review label). Resolve the org-aware shim (the per-checkout `gh-shim.d/<hash>` the daemons use) before the legacy one; never print a token. Also record whether the review daemon covers plateau PRs with no `review:*` label.

## Done when

1. **Executable** — `node --test`/vitest on `we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs` is red on old code and green after; `open-pr --dry-run` against plateauapp/plateau-app resolves the org-aware shim and reads the repo.

## Edge cases this change must handle

1. **Untrusted text** — n/a: only a local shim path is chosen; no PR text is read.
2. **Truncated reads** — n/a: the shim file is checked by a marker substring, a short read is treated as not org-aware.
3. **Shared state files** — n/a: read-only; the shim dir is never written by this path.
4. **Fail closed** — no org-aware shim found: fall back to the old behaviour (legacy shim), never to a token in argv or logs.
5. **Identity scoping** — the shim picks the App installation by the target repo's owner (plateauapp, frontier-ui, web-everything).
6. **State over time** — a legacy shim without the owner map is skipped as it ages.
7. **Who wrote it** — n/a: no authorship decision.
