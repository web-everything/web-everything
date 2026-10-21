---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/github-app-identity.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# gh shim: bake role table and real-gh path from the owning checkout, not the writing caller

Writers share a generated gh shim keyed by the owning checkout's throttle path, but bake caller-local roles and real-gh paths into it. Identity pins, writer settings, and a fake gh on the writer's PATH can therefore change other daemons' authentication. Derive baked inputs from the owner, refuse unreadable owner settings, and enforce shim-first PATH precedence in we:scripts/operations/open-pr-io.mjs. The policy and path safeguards described by PR #5729 are not present in this checkout; supply them if absent, as required below.

## Required baseline safeguards

The owner-derived personal-fallback policy, per-call `WE_GH_AUTH_PERSONAL_FALLBACK` handling, and rejection of relative real-gh candidates described by PR #5729 are behavioral prerequisites, not guaranteed by this card's checkout. Before building, run the A3 baseline probes against the actual build tree. If any fails, implementing the missing safeguard is required work in this card's declared shim scope before the owner-input change can be accepted; a PR reference or an assumed merge is not evidence. This card can therefore be built before PR #5729 lands, but cannot ship without those safeguards.

## Acceptance

- [A1] **Executable** — run the shim test file (we:scripts/lib/__tests__/gh-app-shim.test.mjs). A new test renders the shim through `buildGhShimSettingsEnv` for one `ghThrottleCliPath` from two callers. The callers differ in `WE_DELIVERY_IDENTITY` (`none` vs unset), in their writer checkout's delivery-identity settings, and in a fake `gh` first on `PATH`. The test asserts the two rendered shims are byte-identical. It fails today and passes after.
- [A2] **Executable** — a test for we:scripts/operations/open-pr-io.mjs where the shim dir is later on `PATH` behind another `gh` expects the shim dir to be moved first. It fails today and passes after.
- [A3] **Executable** — add named baseline cases to we:scripts/lib/__tests__/gh-app-shim.test.mjs and run that file via `npm run test:unit -- <shim-test-file>`. Through `buildGhShimSettingsEnv`, assert that personal-fallback tool/platform policy is read from the owning checkout despite conflicting writer settings. Execute the generated shim with missing caches, inherited personal `GH_TOKEN`/`GITHUB_TOKEN` and `WE_GH_AUTH_PERSONAL_FALLBACK=0`: it must return nonzero with a refusal diagnostic and never invoke real gh. Cover an App-token authentication failure followed by the same refusal, and a per-call override allowed by owner policy. Resolve real gh with existing candidates under empty, `.`, `relative/bin`, `../bin` and literal `~/bin` PATH entries: none may be selected; only an absolute trusted candidate may succeed. These are required acceptance gates even when PR #5729 has not landed.
- [A4] **Executable** — add owner-settings failure cases to the same shim test file. Through `buildGhShimSettingsEnv`, supply a missing, unreadable, truncated/invalid JSON, or structurally invalid owner settings file alongside valid writer settings, fresh reviewer/worker/legacy caches, and inherited personal tokens. Dispatch must refuse with a named owner-settings error before invoking gh; returning `null` and continuing with ambient gh is not refusal. If a generated error shim is used, execute it with `WE_GITHUB_APP_ROLE=reviewer` and assert nonzero, a diagnostic, and zero gh calls, also with personal fallback explicitly allowed. Repeat with an existing valid shim in the shared dir to ensure a failed refresh cannot leave that shim usable for the failed dispatch. Separately test a successfully read, valid owner configuration with no App roles: it retains the existing documented legacy behavior and is not classified as a read failure.

## Non-goals

- [N1] Does not redesign personal-fallback policy. The owner-derived source and baseline safeguards are required by A3, including implementation when absent from the build tree.
- [N2] Does not remove a caller's run-time `WE_GH_AUTH_PERSONAL_FALLBACK` override where owner policy permits it. A3 requires per-call handling; an owner-settings failure always refuses regardless of that override.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Relative `PATH` entries (empty, `.`, `relative/bin`, `../bin`, a literal `~/…`) never select the real gh. This is required work under A3 if absent; do not assume PR #5729 supplied it.
2. **Truncated reads** — Missing/unreadable, malformed/truncated JSON, or structurally invalid owner settings produce an explicit error state, distinct from a successfully read valid configuration with no roles. Refuse authentication and dispatch with a diagnostic: never substitute an empty role table, writer settings, worker/legacy cache, personal tokens or saved gh login. Returning `null` must not allow ambient-gh dispatch, and a stale shared shim must not bypass this refusal (A4).
3. **Shared state files** — Two writers of one shim dir must render identical bytes. Any input that can differ between writers is a bug.
4. **Fail closed** — If no real gh can be resolved without the caller's `PATH`, daemon dispatch must refuse; a missing binary or failed shim setup must not continue via ambient gh.
5. **Identity scoping** — The reviewer and author roles stay separate for every daemon, whatever another caller's identity pin says.
6. **State over time** — A pre-fix checkout that still writes the same dir can overwrite the file. Say how the owner rewrite wins: the next refresh tick, or a content-keyed dir.
7. **Who wrote it** — The shim records nothing about its writer today. Consider baking the owner checkout path, so a smell can tell when a shim was not written from its owner.
