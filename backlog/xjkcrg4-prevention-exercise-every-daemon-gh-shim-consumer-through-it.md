---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs", "we:scripts/lib/__tests__/github-app-auth-env.test.mjs", "we:scripts/operations/open-pr-io.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: exercise every daemon gh shim consumer through its caller

PR #5729 advisory identified an existing swallowed guard refusal in open-pr-io and incomplete consumer coverage. Add a deterministic integration matrix for every consumer of buildGhShimSettingsEnv and ensureFreshGithubAppEnv, including createPrLandRunner. Drive explicit and XPC-only daemon identity through missing-real-gh and failed-shim-write branches. Assert rejection before any legacy shim, personal credential, or real gh invocation; preserve interactive best-effort behavior. Inventory try/catch consumers with rg, naming any excluded path and its owning regression. Gate the matrix with npm run test:unit -- we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs and affected consumer suites. Named test daemon shim consumers propagate guard refusal must fail on swallowed daemon refusal.

## Acceptance

- [A1] **Executable** — Add `daemon shim consumers propagate guard refusal`, including integration through createPrLandRunner and a subprocess invocation recorder. Explicit and XPC-only daemon markers must reject missing-real-gh and failed-write cases with zero real-gh or legacy-shim calls. The current swallowed refusal must make the test fail. Run `npm run test:unit -- <suite>` from the WE checkout, using the repository-relative path for suite `we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs`.
- [A2] **Executable** — Inventory every buildGhShimSettingsEnv and ensureFreshGithubAppEnv consumer with `rg`; add each caller to a parameterized integration matrix or cite its existing named guard regression. Include interactive fallback and successful shim installation as controls.

## Non-goals

- [N1] Changing role-table ownership or supported GitHub CLI syntax.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this matrix supplies controlled synthetic daemon markers and paths.
2. **Truncated reads** — n/a: consumer discovery scans whole source files with rg.
3. **Shared state files** — Use isolated temporary shim directories and invocation logs per case.
4. **Fail closed** — Daemon installation refusal propagates before executing any gh subprocess.
5. **Identity scoping** — Explicit and XPC-only daemon identities refuse; interactive callers retain fallback.
6. **State over time** — Cover shim PATH entries absent, later and already first, plus repeated installation.
7. **Who wrote it** — Test the real land-runner wiring, rather than only the isolated helper.
