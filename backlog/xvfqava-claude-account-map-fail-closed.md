---
kind: story
size: 3
status: open
dateOpened: "2026-11-14"
tags: []
---

# Claude account map: fail closed when the map file is unreadable or invalid (R903 residual)

The original auth-split PR2 loader returned null on unreadable/invalid JSON, silently bypassing routing and keeping the inherited login. The PR #6832 repair now returns explicit unavailable evidence and refuses daemon launch before credential IO.

PR #6832 repair: launch and session management share the same shape validator. Session management rejects unavailable evidence before selecting profiles, reading cached sessions or stopping jobs. Regression coverage is in `we:scripts/operations/__tests__/dispatch-account-lifecycle.test.mjs` (`invalid account map … refuses discovery and stop before inherited-profile IO` and `missing, unreadable and corrupt map files cannot reuse cached session evidence and recover on the next read`). Launch coverage is `unreadable or invalid account maps refuse daemon launch before credential IO and recover on the next read` in `we:scripts/operations/__tests__/session-role.test.mjs`. The loader's explicit result and permission-error coverage are in `we:scripts/lib/__tests__/claude-account.test.mjs`. Final verification remains owed before closing this card.

## Acceptance

- [A1] **Executable** — run `npm run test:unit --` with we:scripts/lib/__tests__/claude-account.test.mjs and we:scripts/operations/__tests__/session-role.test.mjs. Add `unreadable or invalid account maps refuse daemon launch before credential IO` and `invalid map cannot reuse cached session evidence`. These proposed tests must fail on the current null-return behavior and pass after repair.
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

- A1/A2: temporary map files for ENOENT, injected EACCES, truncated JSON, null, arrays, numbers and malformed object fields; assert zero spawn, zero Keychain reads, zero cached-result returns. Named tests: `unreadable or invalid account maps refuse daemon launch before credential IO`, `invalid map cannot reuse cached session evidence`.
- A3: `valid off map and interactive callers retain documented routing` covers false/missing switch and interactive callers alongside malformed switch and non-string mapping negatives.
- A4: `map diagnostics are secret free and recover on the next call` uses secret sentinels in malformed contents and errors, then atomically replaces the map with a valid file and asserts recovery. This is planned coverage, not a claim that these tests exist yet.

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
