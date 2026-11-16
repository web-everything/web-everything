---
kind: story
size: 3
status: open
dateOpened: "2026-11-14"
tags: []
---

# Claude account map: fail closed when the map file is unreadable or invalid (R903 residual)

loadAccountMap returns null on unreadable/invalid JSON, so account routing is silently bypassed and the inherited login is kept. Make mapped build/fix daemons refuse instead. Disclosed residual from auth-split PR2.

PR #6832 repair (operator ruling R939, block): `loadAccountMap` no longer returns null. It reads and validates the map on every call and throws one fixed, secret-free diagnostic (`ACCOUNT_MAP_UNAVAILABLE`, naming we:scripts/settings/claude-accounts.json and the repair step) for a missing, unreadable, unparseable or structurally invalid map. Every caller now fails closed and reports it:

- Daemon launch (we:scripts/operations/session-role.mjs `accountSessionEnv`) refuses a launchd label before any Keychain, stat or access call, and logs the refusal on stderr. Interactive and non-launchd callers never read the map. `resolveAccount` refuses a launchd label when handed an unavailable map.
- Session management (we:scripts/lib/claude-sessions.mjs) refuses discovery and stop before inherited-profile IO or cache reads.
- The reaper's trust revoke (we:scripts/operations/dispatch-lane-io.mjs `revokeDispatchTrust`) revokes nothing and reports `refused`, instead of revoking only the inherited profile.
- we:scripts/lib/ai-routing.mjs `aiRoutingValidators` (default map) now throws instead of treating every account as unknown.
- `check:standards` treats an unavailable map like `routing.accountB: true`: every direct session reader in the whole repository fails the gate.

Coverage: `we:scripts/lib/__tests__/claude-account.test.mjs` (`loadAccountMap fails closed (card xvfqava)`), `we:scripts/operations/__tests__/session-role.test.mjs` (`unreadable or invalid account maps refuse daemon launch before credential IO`), and `we:scripts/operations/__tests__/dispatch-account-lifecycle.test.mjs` (`missing, unreadable and corrupt map files cannot reuse cached session evidence and recover on the next read`, `an unavailable account map (%s) refuses the reaper revoke and reports it, never an A-only revoke`).

## Acceptance

- [A1] **Executable** — run `npm run test:unit --` with we:scripts/lib/__tests__/claude-account.test.mjs, we:scripts/operations/__tests__/session-role.test.mjs and we:scripts/operations/__tests__/dispatch-account-lifecycle.test.mjs. `unreadable or invalid account maps refuse daemon launch before credential IO` (session-role) and `missing, unreadable and corrupt map files cannot reuse cached session evidence and recover on the next read` (lifecycle) fail on the null-return loader and pass after repair.
- [A2] Missing, unreadable, truncated JSON, JSON null/arrays/scalars and invalid accounts/daemons objects must produce an explicit unavailable-map result. Build/fix launch and session management must refuse it; neither inherited login nor cached rows may substitute for that evidence.
- [A3] Interactive, non-launchd environments retain their documented behavior. A valid map with routing.accountB false keeps launch routing off. Malformed routing and non-string account mappings still refuse.
- [A4] Diagnostics identify the map path and recovery action without echoing file contents, tokens or raw filesystem errors. Replacing a broken file with a valid map permits the next call without a daemon restart.

## Non-goals

- [N1] No account switch, credential migration, login-file content reads or automatic map repair. No network receive/write endpoint is added; HTTP body limits, CSRF and rate limiting do not apply.

## Risks

- An absent map on a fresh install can stop daemons. Refuse with provisioning guidance rather than falling back to A (A1/A2).
- Logging parse or IO errors can leak map content. Emit a fixed safe diagnostic (A4).
- Cached session rows can conceal a newly corrupt map. Resolve and validate before cache lookup (A2).

## Test plan

- A1/A2: temporary map files for ENOENT, a directory in place of the file (deterministic read failure), truncated JSON, null, arrays, numbers, strings and malformed object fields; assert zero Keychain/stat/access calls and zero cached-result returns. Named tests: `unreadable or invalid account maps refuse daemon launch before credential IO`, `missing, unreadable and corrupt map files cannot reuse cached session evidence and recover on the next read`, `%s map is unavailable evidence with a secret-free diagnostic`.
- A3: `a launchd label with an unavailable map (%j) refuses; interactive stays none`, plus the existing `shipped routing-off map leaves build daemon env unchanged apart from the marker` and malformed-switch / non-string-mapping negatives.
- A4: the `%s map is unavailable evidence with a secret-free diagnostic` cases assert secret sentinels and the temp path never appear in the message or stack; `replacing a broken map with a valid one recovers on the next read without a restart` asserts recovery.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Never echo map contents or raw IO errors; A4 sentinel test.
2. **Truncated reads** — Partial JSON is unavailable evidence, never an empty map; A2 fixtures.
3. **Shared state files** — Read each call; an atomic replacement yields an old or new complete map, a partial write refuses; A4 recovery test.
4. **Fail closed** — Unknown map state refuses daemon launch and management before credentials/cache; A1/A2.
5. **Identity scoping** — Check launchd labels independently of malformed map contents; preserve the interactive exception; A3.
6. **State over time** — No cached null/success survives the next read; A2/A4.
7. **Who wrote it** — Operator-owned local config is still validated; no agent prompt can select a different map path in production; A2/A3.

## Duplicate admission

new residual from auth-split PR2 audit
