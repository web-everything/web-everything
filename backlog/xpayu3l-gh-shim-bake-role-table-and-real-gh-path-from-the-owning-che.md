---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/github-app-identity.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# gh shim: bake role table and real-gh path from the owning checkout, not the writing caller

Every daemon on a host runs one generated gh shim (we:scripts/lib/gh-app-shim.mjs checkoutShimDir is keyed by the control-clone throttle path), but the writer still bakes caller-local state into it. PR #5729 made the personal-fallback policy owner-derived; two inputs remain: (1) roleTable/callerRoles come from the writer's readDeliveryIdentity({env}), so a caller's WE_DELIVERY_IDENTITY=none pin or JSON override, or an unmerged lane's we:scripts/settings/delivery-identity.json, changes which App every other daemon's gh uses (reviewer/author separation); (2) realGhPath comes from the writer's PATH, so a test or soak child with a fake gh first on PATH bakes that fake binary for every daemon. Also we:scripts/operations/open-pr-io.mjs legacy branch checks PATH.includes(dir) instead of first-entry precedence (same miss fixed in we:scripts/lib/github-app-auth-env.mjs defaultInstallOwnerShim by PR #5729). Fix: derive every baked shim input from the owning checkout (or key the shim dir by rendered content), and require first-entry precedence in open-pr-io.

## Acceptance

- [A1] **Executable** — run the shim test file (we:scripts/lib/__tests__/gh-app-shim.test.mjs). A new test renders the shim through `buildGhShimSettingsEnv` for one `ghThrottleCliPath` from two callers. The callers differ in `WE_DELIVERY_IDENTITY` (`none` vs unset), in their writer checkout's delivery-identity settings, and in a fake `gh` first on `PATH`. The test asserts the two rendered shims are byte-identical. It fails today and passes after.
- [A2] **Executable** — a test for we:scripts/operations/open-pr-io.mjs where the shim dir is later on `PATH` behind another `gh` expects the shim dir to be moved first. It fails today and passes after.

## Non-goals

- [N1] Does not change the personal-fallback policy source. PR #5729 already reads its tool and platform layers from the owning checkout.
- [N2] Does not remove a caller's run-time `WE_GH_AUTH_PERSONAL_FALLBACK` override, which the shim reads per call by design.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Relative `PATH` entries (`.`, a literal `~/…`) never select the real gh. PR #5729 already does this; keep it.
2. **Truncated reads** — An unreadable owner settings file fails closed. It yields an empty role table (no App role) and never falls back to the writer's own file.
3. **Shared state files** — Two writers of one shim dir must render identical bytes. Any input that can differ between writers is a bug.
4. **Fail closed** — If no real gh can be resolved without the caller's `PATH`, daemon dispatch refuses, as it does today for a missing binary.
5. **Identity scoping** — The reviewer and author roles stay separate for every daemon, whatever another caller's identity pin says.
6. **State over time** — A pre-fix checkout that still writes the same dir can overwrite the file. Say how the owner rewrite wins: the next refresh tick, or a content-keyed dir.
7. **Who wrote it** — The shim records nothing about its writer today. Consider baking the owner checkout path, so a smell can tell when a shim was not written from its owner.
