---
bornAs: xs5drwb
kind: task
parent: "3383"
status: resolved
scope: ["we:scripts/lib/github-app-token.mjs", "we:scripts/lib/__tests__/github-app-token.test.mjs"]
dateOpened: "2026-09-22"
dateStarted: "2026-09-22"
dateResolved: "2026-09-22"
tags: []
---

# Add a GitHub App installation-token minting utility (JWT sign + exchange)

Standalone utility for #3872's own eventual GitHub-App fork: builds the RS256 JWT a GitHub App uses to authenticate as itself (iss=App ID, iat backdated 60s for clock drift, exp = iat+600s, GitHub's own documented max), then exchanges it for a short-lived installation access token via POST /app/installations/<id>/access_tokens. Uses node:crypto's createSign directly -- no new dependency (this repo's own native-first default). Pure JWT-building core (every input injected, unit-tested with a fixture keypair) + a thin IO shell (reads the private-key file, calls the real GitHub API). Generic and decision-agnostic: does not wire into any daemon's actual credential-inheritance path (that wiring is #3872's own call to make, not presupposed here) -- it only makes the technical capability available and testable ahead of ratification, the same way #3877 built the keyed-lease MECHANISM before any daemon used it.

## Progress

Verified live against a real GitHub App (the App registered while discussing #3872), not just unit-mocked: `node we:scripts/lib/github-app-token.mjs --app-id=<real App ID> --installation-id=<real installation ID> --key=<real private-key path>` returned a real `ghs_...`-prefixed installation access token with a real 1-hour expiry, on the first run, against GitHub's live API. Confirms the JWT's exact shape (RS256, `iat` backdated 60s, `exp = iat + 600`, `iss` = App ID) is genuinely what GitHub's API accepts -- a real end-to-end network call is the only way to prove this; a mocked unit test can assert the JWT's own shape but can never prove GitHub itself accepts it. The private-key never left the operator's own disk and was never read/echoed by the assisting agent -- moved by a plain filesystem `mv` (contents untouched) into a `chmod 600` file outside any repo, and the CLI invocation's own output (the token value itself) was deliberately never printed back into the session transcript, only its presence/shape confirmed.

One real finding from the live run, not yet acted on: the minted token's own `permissions` came back empty (`{}`) -- the App has no repo permissions configured yet (Contents/Pull requests/Checks etc.), so today's token cannot actually do anything useful. That is expected at this stage (no permissions were requested while filing this item) and is exactly the kind of configuration #3872's own ratified fork should specify per daemon role, not something this generic utility should presume or default. Noted here as informational reference only, NOT a ratified scope: a read-only watcher (we:scripts/conveyor/branch-drift.mjs, we:scripts/conveyor/ci-queue-watch.mjs, we:scripts/conveyor/lane-pool-health-watch.mjs, etc.) would need at most Contents:read + Pull requests:read + Checks:read; we:skills-src/conveyor/review-daemon.mjs and we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs additionally need Pull requests:write (to label/comment) and, for Fix-dispatch specifically, Contents:write (to push a repaired commit).

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/github-app-token.test.mjs` passes (14/14): `buildAppJwt`'s signature is verified with `crypto.verify` against a real fixture RSA keypair (not merely asserted to be "some string"), and separately proven to FAIL against the wrong public key (rules out a tautological check); `iat`/`exp` match GitHub's own documented 60s-backdate / 600s-max-lifetime contract exactly; `mintInstallationToken` calls the exact documented endpoint with the exact required headers, over fully injected fakes (no real fs, no real network in the automated suite); an HTTP error surfaces the status + GitHub's own response body and never the JWT or key material.
2. **Executable, live (manual, not part of the automated suite — needs a real App)** — `node we:scripts/lib/github-app-token.mjs --app-id=<id> --installation-id=<id> --key=<path>` returns a real token with a real expiry against GitHub's actual API. Confirmed 2026-09-22 against the real App registered for #3872 (see Progress above).
