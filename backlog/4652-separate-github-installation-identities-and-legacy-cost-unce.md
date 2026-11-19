---
bornAs: x3u395z
kind: story
size: 5
status: open
scope: ["we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs", "we:scripts/lib/__tests__/gh-spend.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "44610c369027326d8a6c1427983d9bc9da181c29"
tags: []
---

# Separate GitHub installation identities and legacy cost uncertainty in the spend ledger

Preserve installation provenance from the effective credential through every transport, and report unknown caller cost honestly. The core meter changes have landed; the remaining implementation gap is the generated shim's cache-to-child provenance and direct-fallback ledger. The authenticated installation-labelled limit observation also remains outstanding.

## Design

Keep the delivered contracts in we:scripts/lib/gh-throttle.mjs:1423, we:scripts/lib/github-app-auth-env.mjs:505, and we:scripts/lib/gh-spend.mjs:146. A bucket identity comes from metadata bound to the credential actually used, never a token prefix, configured installation ID alone, or an assumed 5000-point limit. The original incident and its mixed 6100/5000 observations remain historical evidence in we:reports/2026-09-30-unmetered-app-graphql-spend.md:62.

Finish the transport boundary in we:scripts/lib/gh-app-shim.mjs:

1. Retain the selected cache's non-secret installation metadata alongside its token in `freshCachedToken`. When constructing the child environment at we:scripts/lib/gh-app-shim.mjs:1132, replace inherited provenance with `WE_GH_AUTH_INSTALLATION`, `WE_GH_AUTH_TOKEN_HASH`, and `WE_GH_AUTH_SOURCE=cache` bound to that exact token. Validate a numeric cache installation ID and its agreement with the selected owner's installation when one is known. Missing, malformed, or conflicting evidence yields unknown installation; never synthesize identity from the cache filename, owner map, configured ID, or stale parent metadata. Preserve existing credential-selection, cache-refresh, and daemon refusal policy; this is a provenance fix, not a new authorization policy.
2. Pass that same environment through the in-process, spawned CLI, and direct fallback transports. On a rejected cached token, the inherited retry must use provenance belonging to its own effective credential; it must not retain the rejected cache's installation. Actions and personal-token classification continue to use the shared rules in we:scripts/lib/gh-throttle.mjs:1423. Token rotation with the same validated installation keeps the bucket stable.
3. Embed the shared `ghAuthProvenance` implementation beside the already embedded `ghAuthIdentity` in the generated artifact at we:scripts/lib/gh-app-shim.mjs:572. The direct-fallback row must carry canonical `id` and `auth`, even after its generating checkout disappears. Derive the existing compatibility fields `installationId` and `authSource` from effective credential evidence; remove the configured-ID inference at we:scripts/lib/gh-app-shim.mjs:599. Keep these fields for existing consumers, but neither field may claim a known installation when canonical provenance is unknown. Keep the existing bounded capture, warning, no-replay behavior, and caller-output fidelity.
4. Feed newly emitted rows through the existing spend functions. Do not relabel old `app` rows using their auxiliary installation fields or rewrite raw history. Shared counter movement stays separate from measured in-band cost; missing cost remains unknown/estimated under the existing contract. Preserve nested response identities and echo deduplication, stale-observation rejection, and read-time legacy hourly-row migration in we:scripts/lib/gh-spend.mjs:476.

The touch set is the shim producer and its matching tests plus spend integration cases. The auth helper and throttle are existing dependencies, not replacement implementations. No new budget default, setting, service, or live-probe framework is needed.

## MVP

**Must:** bind selected-cache provenance before any child hop; emit matching canonical provenance from the standalone fallback; test two installations, rotation, inherited retries, Actions/personal/unknown cases, old caches, nested responses, and secret redaction through generated artifacts. Update the existing fallback fixture's default expectation from `id: app` to an installation label only when its cache supplies valid evidence. Keep explicit old-cache fixtures asserting unknown identity.

**Must:** retain the delivered accounting contracts and obtain the authenticated, installation-labelled limit observation in the proof plan before declaring the story fully proved. Lack of a configured host is outstanding proof, not permission to assume a limit or infer an installation.

**Could / follow-up:** fleet-wide adoption inventory and historical caller/gap reconciliation. These do not expand this patch into fleet deployment or replay of the incident ledger.

## Acceptance

[A1] Two selected installation caches with overlapping reset windows remain separate through in-process and spawned transports, while rotation within one installation keeps its bucket. The effective child and ledger agree.

[A1] Executable: add `selected cache identity survives every throttle transport and rotation` to we:scripts/lib/__tests__/gh-app-shim.test.mjs. Execute the real generated shim with synthetic child executables, the canonical throttle, and a relay that exercises the spawned path; then roll up the captured rows. The current cache-to-child hop leaves the identity as `app`, so the new installation-ID assertions fail before the build and pass after.

[A2] Missing, malformed, conflicting, or stale provenance cannot assert an installation. Rejected-cache retries report the inherited credential's installation, Actions repository, personal token, or unknown identity correctly. Existing daemon refusal behavior still refuses forbidden personal fallback without executing the child.

[A2] Executable: add `cache replacement and rejection never borrow another credential provenance` and `unproven cache identity remains unknown without weakening daemon refusal` to we:scripts/lib/__tests__/gh-app-shim.test.mjs. Cover old v2 caches without IDs, invalid IDs, owner mismatch, a parent hash bound to another token, and 401 retry transitions. Include a valid-cache control that requires replacement metadata, making these tests red on the current producer and green after the fix; assert zero child calls on the existing refusal branch.

[A3] Missing throttle entry/import uses the same canonical identity and auth schema as the healthy path, executes the intended request once, preserves caller output, and emits no credential, full credential-binding hash, private response, or request body into the ledger (the existing personal-token fingerprint label remains supported). Unknown provenance stays unknown even when a configured installation ID is present.

[A3] Executable: extend `disposable checkout fallback metering` in we:scripts/lib/__tests__/gh-app-shim.test.mjs:930 with `fallback ledger uses effective credential provenance`. Replace the known-cache fixture's collapsed identity assertion at we:scripts/lib/__tests__/gh-app-shim.test.mjs:990, add canonical `auth` assertions and the configured-ID negative case, and retain the existing execution-count, output, redaction, and missing-entry/import cases. These assertions fail against the current row producer and pass after the build.

[A4] The new producer's two-installation rows survive nested-wrapper deduplication and accounting without assigning invisible shared-counter movement to a legacy caller. Historical rows remain unknown-installation evidence; stale counters cannot create new spend or imply complete capture.

[A4] Executable: add `generated shim installation rows preserve legacy cost uncertainty` to we:scripts/lib/__tests__/gh-spend.test.mjs. Obtain rows from a generated-shim fixture, include outer echoes, interleaved invisible movement, a response without in-band cost, and a stale observation. Assert separate installation rows, one response per echo, unknown legacy caller cost, conserved observed movement, and unchanged raw input bytes. This end-to-end test fails before the producer fix because both caches collapse into `app`; keep the existing installation/legacy and persisted-row tests as additional regression guards.

[A5] An authenticated observation records the actual GraphQL limit with the installation used and response time/reset. No successful unlabelled query or synthetic fixture is accepted as live proof, and no 5000-point budget assumption is introduced.

[A5] Executable: add `generated shim limit observation is installation labelled` to we:scripts/lib/__tests__/gh-app-shim.test.mjs using synthetic 6100- and 5000-limit responses and missing-cost/unknown-identity controls. Assert a bound label and observed limit on the emitted row; this fails before the producer fix and passes after. Then execute the authenticated query and ledger assertions in the Proof plan on a configured host; the fixture alone cannot satisfy this guarantee.

## Edge cases

Unknown cache identity is an accounting result, not a newly authorized fallback. Retain the existing operator-visible daemon refusal and manual fallback behavior. A missing throttle module may still take its existing direct path, with the existing warning and canonical unknown provenance where necessary. Do not add retries or widen output bounds. Exercise oversized captured output using the existing shim fidelity contract if capture code changes; otherwise preserve it untouched. Never infer a historical identity from equal limits or matching reset times.

## Test plan

All test execution goes through we:scripts/readiness/heavy-admission.mjs with one bounded wait. The commands below use `P=we:` as a repository-locus marker and shell parameter removal to pass actual checkout-relative paths; run from the WE checkout.

```sh
P=we:scripts/readiness/heavy-admission.mjs
S=we:scripts/lib/__tests__/gh-app-shim.test.mjs
L=we:scripts/lib/__tests__/gh-spend.test.mjs
T=we:scripts/lib/__tests__/gh-throttle.budget-block.test.mjs
A=we:scripts/lib/__tests__/github-app-auth-env.test.mjs
node "${P#we:}" run --wait-ms=60000 -- npx vitest run "${S#we:}" "${L#we:}" "${T#we:}" "${A#we:}"
```

First add and run the new A1–A5 cases against the unchanged producer to record failures at the stated provenance assertions. Then implement the producer change and run the same affected suites. Use synthetic credentials, isolated ledgers/caches, and task scratch under `$TMPDIR`; no fixture may depend on the operator's credential store. The existing auth tests guard cache binding, and the throttle tests guard rotation and effective credential classification. Update the existing shim fixture explicitly rather than weakening an assertion. Inspect callers and old persisted rows before accepting the changed identity default.

Run the standards check through the same queue, scoped to this card during preparation and to the actual touch set during implementation. If admission stays busy after the one bounded wait, stop and report it; do not poll or run outside the queue. The runner owns stamping and final checks.

## Proof plan

1. Retain the pre-fix raw ledger unchanged. Record the new tests' failing assertions and passing reruns with the implementation SHA. Existing September validation below is historical evidence, not a result for the current checkout.
2. Use an already configured host and a freshly generated shim from the built revision. Select a known installation through the normal cache/owner routing and use a unique non-secret `GH_CALLER` marker. Issue one read-only query through that shim: `gh api graphql -f 'query=query { rateLimit { limit remaining used resetAt cost } }'`. Do not print credentials, hashes, cache contents, or private-key material. Do not run this network proof during card preparation.
3. Match the marked call to its new ledger row and assert `id` equals `app-installation-<selected installation ID>`, `auth.kind` equals `installation`, and `auth.installationId` matches the cache-bound installation. Assert the observed GraphQL limit, used/remaining, and reset agree with the response; record timestamp and revision with this non-secret evidence in this card. A successful query without matching labelled ledger evidence is a failed proof. The observed limit is evidence for that installation/window only, never a universal 5000-point default.
4. If auth, network, ledger capture, or installation provenance is unavailable, record the specific missing prerequisite and leave proof outstanding. Retry only on a configured host after that prerequisite changes. Do not replace the live observation with synthetic evidence or rewrite old rows into claimed identities.

## Follow-ups

- Coordinate caller/gap reconciliation with #4639 and standalone fallback transport coverage with #4653; this story owns the effective installation label and legacy-cost semantics. No dependency-edge change is proposed.
- After deployment through the existing shim owner, verify active callers adopted the regenerated artifact. Inventory stale artifacts separately; do not hand-edit installed shims or claim fleet adoption from source tests.
- Preserve incident evidence and unknown historical costs. Wider production coverage and incident attribution remain separate from a labelled limit observation.

## Progress

- Original premise/scope: all `ghs_` credentials collapsed to `app`, auth caches lacked installation identity, and legacy response costs used shared deltas. The original scope was we:scripts/lib/gh-throttle.mjs, we:scripts/lib/gh-spend.mjs, we:scripts/lib/github-app-auth-env.mjs, and we:scripts/lib/__tests__/gh-spend.test.mjs. The old citations to throttle line 1208, auth line 114, and spend line 181 described the September implementation, not the current code.
- Delivered subset: commit `f9d9a0635efd4e66501e2165ed227b9b37ff33e4`, merged by `577ed26659ebafd52fca7b387d6dd85f20e847ae`, implemented the core identity/accounting changes and their fixtures. Current source evidence: token-bound installation/Actions/personal classification at we:scripts/lib/gh-throttle.mjs:1423 and provenance at we:scripts/lib/gh-throttle.mjs:1478; App/installation cache comparison at we:scripts/lib/github-app-auth-env.mjs:505 and token binding at we:scripts/lib/github-app-auth-env.mjs:615; per-response identity grouping at we:scripts/lib/gh-spend.mjs:78, in-band-only attribution at we:scripts/lib/gh-spend.mjs:169, and read-time legacy migration at we:scripts/lib/gh-spend.mjs:476. Existing named tests live at we:scripts/lib/__tests__/gh-throttle.budget-block.test.mjs:180, we:scripts/lib/__tests__/github-app-auth-env.test.mjs:481, and we:scripts/lib/__tests__/gh-spend.test.mjs:326.
- Corrected premise/scope: the goal is not fully delivered. The generated shim remembers a cache installation at we:scripts/lib/gh-app-shim.mjs:802 but only replaces `GH_TOKEN` at we:scripts/lib/gh-app-shim.mjs:1132. Its fallback emits collapsed `id` and separately inferred installation metadata at we:scripts/lib/gh-app-shim.mjs:597; the current fixture explicitly expects that mismatch at we:scripts/lib/__tests__/gh-app-shim.test.mjs:990. Add this missing producer and its matching test path to scope; keep spend tests for end-to-end accounting, and remove the already-delivered core modules from the planned mutation set. Auth/throttle test paths remain explicit regression commands above.
- Sizing: retain story size **5**. Expected changes: we:scripts/lib/gh-app-shim.mjs about 60–100 lines across metadata selection, child environment binding, and fallback schema; we:scripts/lib/__tests__/gh-app-shim.test.mjs about 140–200 lines across real generated-artifact transport and negative cases; we:scripts/lib/__tests__/gh-spend.test.mjs about 25–40 lines for producer-to-rollup cases (about 225–340 changed lines total). Evidence is the three producer sites and existing fixture ranges cited above. This is a story, so no `estimatedLoc` is added.
- Historical validation from the September implementation: the card recorded 413 affected-suite passes, six skips, 11 budget-smell passes, and a standards run with zero errors. Its broader verification recorded ten unrelated failures reproduced on unchanged HEAD and sandbox restrictions. Those historical results do not establish this preparation's current test status or close the newly identified transport gap.
- Historical live-proof status: the earlier environment probe found no configured App credentials and a v2 cache without App/installation identity. No identity or 5000-point assumption was inferred. The live observation remains required; this preparation performs no credential or network probe.
- Preparation verification at checkout `44610c369027326d8a6c1427983d9bc9da181c29`: the host heavy-run queue executed the four named suites with the selector `disposable checkout fallback metering|installation provenance|installation and legacy evidence|installation-bound cache provenance|CLI call records carry`; **15 tests passed, 521 were excluded by the selector**, four files passed. In particular, the generated-artifact fallback test passed while expecting `id: app` alongside a cache installation ID, observing the remaining producer defect. No new acceptance test or runtime fix was implemented during this card-only preparation.
- Preparation standards verification: the queued `npm run check:standards` invocation scoped to this card completed with **0 errors and 7429 warnings** after the queue rejected incomplete remote standards inputs and automatically executed its local fallback. The invocation exited 0. Only this card body and `scope` changed; all other frontmatter is preserved, and no preparation stamp, commit, push, or PR was created.
