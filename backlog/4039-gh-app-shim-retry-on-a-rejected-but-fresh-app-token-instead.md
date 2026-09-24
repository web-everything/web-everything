---
bornAs: xkse05k
kind: story
size: 3
parent: "3383"
status: resolved
scope: ["we:scripts/lib/gh-app-shim.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# gh-app-shim: retry on a rejected-but-fresh App token instead of failing the session

we:scripts/lib/gh-app-shim.mjs's generated gh wrapper trusts the shared App token cache's recorded expiresAt as proof the token is still good; GitHub can reject an installation token before that recorded expiry (revoked, an installation change, or a mint-time clock/skew edge). Live-caught: wev-review-daemon session review-2582 (c9d499b1, 2026-09-24 13:26 ET) failed its review outright on the FIRST gh call with HTTP 401 Bad credentials via api.github.com/graphql, even though the shared cache (we:scripts/lib/github-app-auth-env.mjs) reported the token fresh for another ~55 minutes; personal gh auth on the same host was confirmed fine the whole time. Fix: the shim now runs an App-token gh call with output captured; if it fails with an HTTP 401 / Bad credentials signature, it best-effort deletes the shared cache (so the fleet's next refresh mints a replacement instead of every dispatch hitting the same bad token for up to an hour) and retries the SAME call once on whatever auth is already in effect, instead of failing the whole session. Every other outcome (success, or an unrelated failure) is unchanged, byte-identical to before.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
