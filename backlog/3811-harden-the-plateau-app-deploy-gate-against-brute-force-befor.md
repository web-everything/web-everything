---
bornAs: xtzs1ch
kind: story
size: 3
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: the first-external-access gate card (8694) is scheduled"
dateParked: "2026-11-22"
scope: ["plateau:worker.js", "plateau:wrangler.toml", "plateau:scripts/worker-gate.test.mjs"]
dateOpened: "2026-09-21"
preparedDate: "2026-10-01"
preparedAgainstSha: "9d07776cb18f1d913c167850d8e0fc414868ed9b"
tags: []
---

# Harden the plateau-app deploy gate against brute force before any customer access

## Ruling

**RULED — option B.** Operator, 2026-10-01, decision **4941**: “Let’s keep code gate for now”. Keep the custom Plateau gate, throttle POST /__gate, and issue sessions that can be revoked individually. Cloudflare Access is a later option, outside this item. This records the supplied operator ruling, not a new unresolved choice or a claim that the hardening has shipped.

Delivery follows the operator ruling in we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18–20: use independently valuable per-repo slices; coupled delivery remains future capability. The standing per-repo gate/profile rule is we:docs/agent/platform-decisions.md:5511 (`#conveyor-multi-repo-model`). This preparation changes only this card; it neither creates another card nor implements either slice.

## Progress

2026-10-01 — checked the brief on main at we:skills-src/conveyor/prepare-item-worker-brief.md:5–16 and rechecked the previous preparation's drift against current source. WE HEAD: `9d07776cb18f1d913c167850d8e0fc414868ed9b`; Plateau HEAD: `2a38182a53a32e12633c135dc4daecff5e5b101d`.

- **Old premise:** both gates issue one static 30-day cookie, revocable only by rotating the signing secret. **Correction:** Plateau already binds its grant to the current code; rotating GATE_CODE revokes all old cookies (plateau:worker.js:264–267), with an existing regression at plateau:scripts/worker-gate.test.mjs:80–89. WE still signs only the fixed grant, so rotating its code does not invalidate issued cookies (we:worker.js:118–127). Preserve Plateau's existing bulk revocation; add individual revocation.
- **Still missing:** neither POST handler throttles attempts (plateau:worker.js:287–298; we:worker.js:130–141). Plateau's cookie lifetime is 30 days, and every successful submission under the same secrets gets the same value (plateau:worker.js:37–41, :290–295); WE likewise sets the fixed expected signature (we:worker.js:122, :133–137). Neither handler records a session identifier or checks a revocation store.
- **Observed local probe:** invoked both actual exported gate functions with Request/Response and an asset sentinel. Two successful submissions produced identical cookies in each repo. Replaying after code rotation served the sentinel in WE and did not in Plateau. Twenty-five consecutive wrong submissions returned only 401 in each repo, never 429. Loaded source as ESM data URLs because direct Node import of WE's JS failed its module-mode check; Plateau's relative relay import was resolved to its unchanged source. This is a local handler probe, not a deployed-edge/WAF audit or a proof about unobserved traffic volumes.
- **Old scope:** Plateau worker/config plus WE worker, with no tests. **Corrected scope:** this card owns Plateau worker/config and its existing test suite; the independently deployable WE parity slice is specified below for a separate card. Current Worker-first routing is configured in plateau:wrangler.toml:17–24 and we:wrangler.toml:28–33. Plateau already has a separate relay Durable Object binding/migration (plateau:wrangler.toml:26–35); the gate must not reuse its storage.

## Design

The following is proposed implementation acceptance under the ruled option B, not a description of current behavior.

1. **Stateful gate authority.** Add a dedicated gate Durable Object class in plateau:worker.js and a new binding/additive migration in plateau:wrangler.toml. Keep attempt accounting and session records in durable storage, with serialized atomic updates. Do not use isolate-local counters or the WIP relay object. Missing bindings, storage failures, and unusable secrets fail closed with 503, no asset access and no cookie minting.
2. **Throttle before authentication.** Route every POST /__gate through the limiter before parsing/verifying the code, including requests carrying an existing cookie. Initial configurable defaults: 10 attempts per client IP per rolling 60 seconds and 100 total per rolling 60 seconds for this deployment. Obtain the client key from the edge-provided client address, never submitted form data or X-Forwarded-For; absent address uses one shared unknown-client bucket. Store a keyed digest of the address, expire idle counters, and count both correct and incorrect submissions. Over budget: 429, Retry-After for the remaining window, no Set-Cookie, no asset fetch. Storage errors must not reopen the unlimited path. These thresholds are implementation defaults to exercise, not measured capacity or a claim to defeat distributed attacks.
3. **Distinct, expiring sessions.** Each accepted code submission creates a cryptographically random session ID and a server-side 30-day expiry. Sign a versioned token containing ID and expiry, bound to the current code and signing secret; persist only the session metadata required for validation/revocation. Validate signature, current code binding, expiry and live record before serving protected assets or admitting gated API connections. Preserve HttpOnly, Secure, SameSite=Lax and Path=/ (current flags: plateau:worker.js:294). Reject legacy fixed-grant cookies on rollout; users re-enter the code. Code or signing-secret rotation continues to invalidate all existing tokens. Prune expired state.
4. **Operator revocation.** Add a separate POST /__gate/revoke control route authenticated by a new dedicated operator bearer secret, never the shared entry code or a visitor cookie. Accept one session ID and delete that record atomically; repeat deletion is idempotent. Return no session secret; do not log cookies, codes, bearer credentials or raw addresses. Missing operator secret fails closed. Document the operator request, secret provisioning and how to extract the non-secret session ID from the versioned cookie in plateau:worker.js comments. Revocation takes effect on the next authorization check; it does not terminate already-established WebSockets in this MVP.
5. **Preserve Plateau-specific routing.** Keep the exact public manifest/icon GET/HEAD allowlist (plateau:worker.js:25–30, :269–271), independent laptop bearer routes (plateau:worker.js:274–276), and gated snapshot/live routes (plateau:worker.js:280–284). The limiter must not consume attempts for asset reads or laptop publishing. Keep gate responses non-cacheable. The new operator route must not fall through to static assets.

## MVP

**Plateau slice — this card, independently useful and deployable:** plateau:worker.js (authority class, throttle, token validation, revoke route, operator instructions), plateau:wrangler.toml (binding, additive migration, non-secret limits), plateau:scripts/worker-gate.test.mjs (existing suite extended for all new behavior). Provision the operator secret separately through deployment secret management; commit no credentials. No new dependency is required by this proposed native Worker/DO design.

**WE slice — separate follow-up card, not this card's dispatch scope:** we:worker.js, we:wrangler.toml, we:functions/__tests__/gate.test.ts. Apply equivalent throttle/session/revocation acceptance while adding code-rotation revocation that WE currently lacks. WE's existing test entry imports its actual Worker (we:functions/__tests__/gate.test.ts:11–16). Give that slice its own preparation, gate and deployment proof. No runtime dependency edge is needed between the two slices: each hosts its own gate, secrets and state; completing Plateau must not imply WE is hardened. No coupled implementation dispatch or new backlog file in this preparation.

## Test plan

Extend plateau:scripts/worker-gate.test.mjs, retaining its Node environment because its current harness explicitly depends on real Cookie/Set-Cookie behavior (plateau:scripts/worker-gate.test.mjs:1–10). Use a controllable clock and durable-storage fake shared across fresh authority instances; exercise the real gate and authority methods, not a fake limiter that always returns the desired result.

- Boundary attempts: first 10 admitted, eleventh 429 for one client; another client has an independent bucket until the deployment cap; malformed/correct-code submissions and an existing cookie cannot bypass accounting. Verify window recovery, Retry-After, missing-address bucket, forged forwarding headers, concurrent attempts and state surviving instance replacement.
- Two successful entries yield distinct tokens. Revoke A, then A cannot read protected assets or initiate the gated APIs while B still can. Test unknown/repeated revocation, absent/wrong operator bearer, and that a visitor cookie/code cannot authorize revocation.
- Reject tampering, missing session records, expired sessions at the exact boundary and legacy tokens. Preserve the code-rotation regression at plateau:scripts/worker-gate.test.mjs:80; add signing-secret rotation. Missing/blank secrets, missing binding, storage read/write failures and malformed input never mint a cookie or serve protected content.
- Retain current asset/deep-link, wrong-code and public-asset tests (plateau:scripts/worker-gate.test.mjs:26–65, :113–128). Cover laptop bearer routes and gated live-route admission. Assert flags, 302 success, 401 wrong code before exhaustion, 429 exhaustion, 503 unavailable state, and no-store on authentication responses.

## Proof plan

1. In the future Plateau implementation lane, run the existing targeted Vitest suite against the actual Worker. The new exhaustion and two-session revocation assertions must fail against the baseline and pass with the implementation; retain both outputs and candidate SHA. Command, with that repo as cwd:

   ```sh
   npx vitest run scripts/worker-gate.test.mjs
   ```

2. Exercise the real binding/migration in an isolated Worker preview with dummy secrets and a protected sentinel asset. Use two cookie jars; prove 302 then successful asset access for each, revoke one via the operator route, and show only that jar loses access. Cross the attempt threshold, record 429/Retry-After, wait out the window and prove recovery. Recreate the Worker instance and verify revocation/accounting persist; code rotation rejects both old jars. Capture sanitized status/header evidence, never cookie values or credentials.
3. Probe a deep link, direct asset, public icon/manifest, laptop bearer route and gated API handshake. Demonstrate fail-closed behavior with the gate binding/secret unavailable. Verify deployed client-address handling and counters; local fake storage cannot establish edge durability or trusted-header behavior. Use isolated preview traffic, not customer brute-force traffic.
4. Run the Plateau profile's required gate/CI against its candidate. The separate WE slice must run its own targeted suite and lane verifier; a WE green result does not verify Plateau. This card-only preparation runs we:scripts/verify-lane.mjs and the WE standards check; neither is claimed as proof of unimplemented hardening.

## Done when

Plateau's new automated throttle/session tests pass, real preview evidence demonstrates exhaustion/recovery and selective revocation without breaking existing routes, and the operator can revoke a single session using the documented control request. The deployment uses the required durable binding and secrets. Cloudflare Access and WE parity are not completion criteria for this Plateau slice.

## Follow-ups

- File the independent WE parity story with the exact three-file scope above and equivalent tests/proof; explicitly preserve the fact that code rotation currently does not revoke WE cookies.
- Reconsider Cloudflare Access later under a separate decision; option B does not establish per-person identity or prevent a revoked visitor who still knows the shared code from signing in again. Rotate the shared code for that case.
- Tune limits from observed preview usage; monitor global-limit denial of service and shared-IP contention. Broader distributed abuse defenses and active WebSocket termination on revocation require separate work.
- Testing lesson: Node's package module mode can prevent direct import of an otherwise valid Worker. Use each repo's existing Vitest harness for implementation verification and separately exercise actual durable bindings in preview. Keep this lesson here; do not append it to shared agent documentation.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: before any external user gets access (first customer or public beta).

Gate card: 8694 (First external access (beta) release gate) refuses outside access while this card is not resolved. Unpark when the first-external-access gate card is scheduled.
