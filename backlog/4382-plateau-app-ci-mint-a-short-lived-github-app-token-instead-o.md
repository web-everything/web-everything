---
bornAs: x8x0ris
kind: story
size: 5
tier: pinned
status: open
scope: ["plateau:.github/workflows/ci.yml", "plateau:.github/workflows/deploy.yml", "plateau:.github/workflows/deploy-alpha.yml", "plateau:scripts/check-sibling-credential.mjs", "plateau:scripts/lib/sibling-credential.mjs", "plateau:scripts/check-sibling-credential.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "8efa93ed7d2a942f9ec1c6b0896c0986241e87bd"
tags: []
---

# plateau-app CI: mint a short-lived GitHub App token instead of the static FUI_READ_TOKEN secret

plateau-app PR #187's `test` and `e2e` jobs fail at step "Checkout FUI (sibling, private)" with "Bad credentials" — the repo secret FUI_READ_TOKEN (a static PAT) is invalid/expired. This blocks EVERY plateau-app PR; ci-heal correctly escalated needs-human (2026-09-28 ~5:31 PM ET).

## Full design

plateau-app's CI, e2e, and deploy workflows (`plateau:.github/workflows/ci.yml`, `plateau:.github/workflows/deploy.yml`, `plateau:.github/workflows/deploy-alpha.yml`) each check out the private chalbert/frontierui sibling using a static fine-grained PAT (`secrets.FUI_READ_TOKEN`). A static PAT expires/rotates silently and has no automated renewal, so this class of failure recurs. The durable fix is to mint a short-lived GitHub App installation token at CI-run time instead of relying on a long-lived secret:

- Register (or reuse) a web-everything GitHub App with `contents:read` on frontier-ui/frontierui, installed on that repo.
- Store the App id as a plateau-app repo variable `WE_APP_ID` and the private key as a repo secret `WE_APP_PRIVATE_KEY` (the web-everything convention; see Progress).
- In each workflow's sibling-checkout step, run `actions/create-github-app-token` (or equivalent) to mint an installation token scoped to frontier-ui/frontierui, and pass that token to the `actions/checkout` step in place of `secrets.FUI_READ_TOKEN`.
- Add a CI preflight / health smell that checks the sibling-checkout credential BEFORE the real checkout (or wraps the checkout's failure) and reports "invalid sibling-checkout credential" clearly, rather than surfacing an opaque "Bad credentials" only inside the checkout step's raw log.
- frontierui's own CI (`frontierui:.github/workflows/ci.yml`) was checked: it checks out webeverything as a PUBLIC sibling with no token, so it does NOT share this mirror-dependency failure mode — no matching change needed there.

## Explicit MVP cut

MVP = in plateau-app's workflow(s) under `plateau:.github/workflows/`, mint an installation token with `actions/create-github-app-token` (or equivalent) from the web-everything GitHub App and use it for the sibling checkout in `plateau:.github/workflows/ci.yml`'s `test`/`e2e` jobs (the two failing on PR #187); keep the static PAT as a fallback only during the switch (e.g. `token: ${{ steps.app-token.outputs.token || secrets.FUI_READ_TOKEN }}`). Include the CI preflight / health smell for an invalid sibling-checkout credential. `plateau:.github/workflows/deploy.yml`/`plateau:.github/workflows/deploy-alpha.yml`'s own sibling-checkout steps use the same pattern once the App token is proven in `plateau:.github/workflows/ci.yml`, but are not MVP-blocking for this card.

## Done when

1. **Executable** — Running vitest (`npx vitest run`, from the plateau-app root) on `plateau:scripts/check-sibling-credential.test.mjs` fails before this item lands (no preflight script, no App-token mint in `plateau:.github/workflows/ci.yml`) and passes after.
2. **Operator step (not code)** — set the `WE_APP_ID` repo variable and the `WE_APP_PRIVATE_KEY` repo secret on plateau-app (or at the org level) for the existing web-everything GitHub App, which already has Contents:Read on `frontier-ui/frontierui` (web-everything's own CI already mints from it; see Progress). Until they are set, plateau-app CI keeps using the `FUI_READ_TOKEN` fallback and the preflight names a bad PAT clearly.

## Progress

- 2026-10-07 prepare pass (premise + scope check against plateau-app `origin/main` 0bc08da and web-everything `origin/main`):
  - **Premise holds, not delivered.** `plateau:.github/workflows/ci.yml:61-65` (`test`) and `:116-120` (`e2e`), `plateau:.github/workflows/deploy.yml:154-159` and `plateau:.github/workflows/deploy-alpha.yml:83-87` still check out the FUI sibling with `secrets.FUI_READ_TOKEN`; no `create-github-app-token` step exists in plateau-app. `git log origin/main --grep=4382` in plateau-app finds nothing. An earlier unlanded build attempt (salvage `lane-1.bundle`, commits e0ab6e6/2cda68f) sits on a stale base (`f1a83271`, 164 files / 17k lines behind `main`); it is not reusable as-is.
  - **Drift corrected.** (1) The private repo is `frontier-ui/frontierui`, not `chalbert/frontierui` (`plateau:.github/workflows/ci.yml:64`); the salvaged attempt scoped the mint to the wrong owner. (2) web-everything already shipped this exact pattern for its own CI (`we:.github/workflows/ci.yml:133-147`, test `we:scripts/__tests__/ci-fui-checkout-app-token.test.mjs`): `actions/create-github-app-token@v2`, `app-id: ${{ vars.WE_APP_ID }}` (a repo VARIABLE, not a secret), `private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}`, `owner: frontier-ui`, `repositories: frontierui`, `permission-contents: read`, guarded by `if: vars.WE_APP_ID != ''`. The card's "secrets `WE_APP_ID`" is corrected to follow that precedent so one App serves both repos. (3) `size:` 5 unchanged. `scope:` gains the new preflight script + its test (still led by the CI workflow).
  - Done-when #1 was a TODO; now concrete (above).
- [ ] Build: the `## MVP` below.

## Design

Two changes, both under plateau-app, mirroring we's shipped pattern so there is one mental model across the constellation.

1. **Mint step in `test` and `e2e`** (`plateau:.github/workflows/ci.yml`, directly before each `Checkout FUI (sibling, private)` step at `:61` and `:116`): `id: fui-app-token`, `if: vars.WE_APP_ID != ''`, `uses: actions/create-github-app-token@v2`, inputs exactly as in `we:.github/workflows/ci.yml:133-142`. The FUI checkout's `token:` becomes `${{ steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN }}`. With the variable unset the step is skipped and behaviour is byte-for-byte today's (PAT). The mint step stays unconditional on the job's other gates (we's `e7beec0bc` learned a compound `if:` breaks the guard test). The token is minted per job and never written to `.git/config` beyond what `actions/checkout` already does in the checkout's own git config; the `permissions: contents: read` workflow default (`:45`) is unchanged because the App token is a separate credential, not `GITHUB_TOKEN`.
2. **Preflight** `plateau:scripts/check-sibling-credential.mjs` (plain node, no deps, CLI like `plateau:scripts/check-render-conformance.mjs`) with pure rules in `plateau:scripts/lib/sibling-credential.mjs`. A new step `Preflight FUI credential` runs after `Checkout plateau-app` and after the mint step, before the FUI checkout: `node plateau-app/` + `plateau:scripts/check-sibling-credential.mjs`, with env `FUI_TOKEN: ${{ steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN }}`, `FUI_TOKEN_SOURCE: ${{ steps.fui-app-token.outputs.token && 'github-app' || 'FUI_READ_TOKEN' }}`. It does one `GET https://api.github.com/repos/frontier-ui/frontierui` with `Authorization: Bearer`, a 10s `AbortSignal.timeout`, and classifies the response by status:
   - missing/empty token → FAIL (`::error title=Invalid sibling-checkout credential::` naming the source and the fix);
   - 200 → ok (prints the source only, never the token);
   - 401 → FAIL "credential rejected (expired or revoked)"; 404 → FAIL "credential cannot see frontier-ui/frontierui (missing Contents:Read or App not installed)"; 403 with `x-ratelimit-remaining: 0` → WARN (rate limited, the checkout may still pass); 429, or a 403 carrying `retry-after` (secondary rate limit) → WARN; any other 403 → FAIL; any other unlisted status → WARN "unclassified status N" (explicit, tested; the checkout stays the final authority);
   The probe base URL is read from `FUI_API_BASE` (default `https://api.github.com`) so the spawned-CLI test can point it at a local stub server.
   **Mint failure handling:** the mint step also carries `continue-on-error: true`, and the preflight step gets `FUI_APP_MINT_OUTCOME: ${{ steps.fui-app-token.outcome }}`. If that is `failure` (bad/missing private key, App not installed, fork PR with `vars` visible but no secrets) the token falls back to the PAT and the preflight prints a `::warning` "App token mint failed, using FUI_READ_TOKEN" so the failure is named, not silent. (A `secrets` check in the step `if:` is not possible: the `secrets` context is unavailable there.)
   - 5xx, network error, timeout → WARN (`::warning`), exit 0: an outage of the probe must not block CI the checkout could pass.
   The annotation text is fixed strings plus the status code and the source label; the response body is never echoed.

`plateau:.github/workflows/deploy.yml` and `plateau:.github/workflows/deploy-alpha.yml` are untouched in the MVP. Caution recorded for the follow-up: `plateau:scripts/alpha-workflows.test.mjs:29` pins the alpha `build` job's only secret as `FUI_READ_TOKEN` (that job runs branch code), and the deploy workflow runs in a SHA-pinned, `persist-credentials: false` env split (`plateau:.github/workflows/deploy.yml:138-160`), so adding `WE_APP_PRIVATE_KEY` there needs its own security review.

## MVP

Musts:
- App-token mint step + `token:` expression in `plateau:.github/workflows/ci.yml` `test` and `e2e` (the two jobs failing on PR #187), PAT kept as fallback.
- `plateau:scripts/check-sibling-credential.mjs` + `plateau:scripts/lib/sibling-credential.mjs` + the preflight step in both jobs.
- `plateau:scripts/check-sibling-credential.test.mjs` (below).

Out of MVP (see Follow-ups): the deploy and deploy-alpha workflows, dropping the PAT fallback, creating/installing the App or setting the plateau-app secrets (operator step), registering a separate App.

## Test plan

Vitest in plateau-app (`plateau:scripts/check-sibling-credential.test.mjs`, picked up by the existing `plateau:vitest.config.ts` `*.test.mjs` include for the scripts directory). All are RED today because the module and the CI workflow steps do not exist.
- `classifyProbe` table: 200→ok; 401→fail; 404→fail; 403+`x-ratelimit-remaining:0`→warn; 403 with `retry-after`→warn; 429→warn; other 403→fail; 500/502→warn; unlisted status (e.g. 418)→warn; thrown/timeout→warn; mint outcome `failure`→warn note added; missing or whitespace-only token→fail. Asserts the verdict and that the message names the token source.
- `probeSiblingCredential` with a stubbed `fetch`: sends `Authorization: Bearer <t>` to `/repos/frontier-ui/frontierui`; output never contains the token even if the stubbed body or error message echoes it.
- Untrusted text: a stubbed 401 body containing newlines, backticks and `::set-output` is not reflected in the annotation (fixed text only).
- Spawned CLI (`plateau:scripts/check-sibling-credential.mjs`, stub server via env override of the API base): missing token exits 1 with the `::error title=Invalid sibling-checkout credential::` line; stub 401 exits 1; stub 503 exits 0 with `::warning`.
- CI workflow shape (parse with `js-yaml`, as `plateau:scripts/alpha-workflows.test.mjs` does): in BOTH `test` and `e2e`, the step order is checkout plateau-app → mint (`id: fui-app-token`, `if: vars.WE_APP_ID != ''`, `actions/create-github-app-token@v2`, `owner: frontier-ui`, `repositories: frontierui`, `permission-contents: read`, `continue-on-error: true`) → preflight (env includes `FUI_APP_MINT_OUTCOME`) → FUI checkout whose `token:` is `steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN`. The FUI checkout must be the only `FUI_READ_TOKEN` use besides the preflight env.
- Regression guard (existing, must stay green): `plateau:scripts/alpha-workflows.test.mjs` — proves deploy-alpha's build job is untouched.

## Proof plan

- **Before/after on a real surface, no secrets needed:** run `plateau:scripts/check-sibling-credential.mjs` with `FUI_TOKEN=bogus` and `FUI_TOKEN_SOURCE=FUI_READ_TOKEN` against live `api.github.com` — expect exit 1 and the `Invalid sibling-checkout credential` annotation (401); then with a valid token (`FUI_TOKEN=$(gh auth token)`) expect exit 0. Paste both into the PR.
- **At build time (the build branch's OWN plateau-app PR run — re-running PR #187 would not execute this change):** before = opaque "Bad credentials" inside the checkout step (PR #187's log); after = the preflight step fails first with the named `Invalid sibling-checkout credential` message while the PAT is still bad, and the mint step is skipped (variable unset).
- **Post-merge, after the operator step (a `workflow_dispatch` run of the CI workflow on plateau-app `main`):** `Mint FUI read token` goes green, the preflight reports `github-app`, and `test`/`e2e` pass with no `FUI_READ_TOKEN` involvement. This half cannot be shown at build time and is recorded as the operator's acceptance check.
- `actionlint` on `plateau:.github/workflows/ci.yml` clean if available.

## Edge cases this change must handle

1. **Untrusted text** — the probe response body and error messages never reach the annotation (fixed strings + status + source label only); the token never printed; test with a stub that echoes the token and newlines/backticks. `foldUntrusted` is not needed (no free text passes through). The CLI takes no argv.
2. **Truncated reads** — one single-object `GET` (no pagination); a non-2xx or unparseable response is classified by status, never treated as success; the headers are read, not a body page.
3. **Shared state files** — n/a: the script writes no files and shares no state.
4. **Fail closed** — a missing/empty token, 401, 404 or non-rate-limit 403 fails the job with a named reason; only a 5xx, network error, timeout, 429, secondary rate limit or unlisted status warns (explicit allow-list, each tested), and the checkout step remains the final authority.
5. **Identity scoping** — the probe targets exactly `frontier-ui/frontierui` (owner spelled correctly, not the card's stale `chalbert/`); the mint is scoped to that one repo with `permission-contents: read`; the message names the credential source (`github-app` vs `FUI_READ_TOKEN`).
6. **State over time** — installation tokens expire after 1 hour: minted per job immediately before use, so a re-run mints a fresh one; a rate-limit window is a warn, not a fail; no state survives between runs.
7. **Who wrote it** — fork/Dependabot PRs get no secrets but DO see `vars`: with `WE_APP_ID` set the mint step runs with an empty key and fails; `continue-on-error` lets the job reach the preflight, which warns about the mint failure and then fails on the empty PAT with a clear named message instead of the old opaque checkout error (same pass/fail outcome as today, better text). The preflight runs PR-branch code with the token in its env — the same trust level as the checkout step it precedes; no new exposure. `vars.WE_APP_ID` is read from the base repo's variables; the private key never leaves the `create-github-app-token` step.

## Follow-ups

- Same mint + preflight in `plateau:.github/workflows/deploy.yml` and `plateau:.github/workflows/deploy-alpha.yml` after the App token is proven in the CI workflow; includes updating `plateau:scripts/alpha-workflows.test.mjs:29` and `plateau:scripts/deploy-config.test.mjs:91` (pins the deploy token as exactly `secrets.FUI_READ_TOKEN`) and a security review of exposing the App private key to the alpha `build` job (branch code runs there).
- Drop the `FUI_READ_TOKEN` fallback and delete the secret once the App path has run green for all plateau-app workflows.
- A web-everything-side health smell that flags a plateau-app/frontierui repo still relying on the PAT fallback.
- Registering a separate plateau-specific App (only if sharing the web-everything App proves undesirable).
- Operator step (not a build item): set `WE_APP_ID` / `WE_APP_PRIVATE_KEY` on plateau-app.
