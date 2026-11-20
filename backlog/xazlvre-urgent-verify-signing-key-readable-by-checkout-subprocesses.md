---
kind: story
size: 3
status: open
priority: high
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/urgent-verify-marker.mjs"]
dateOpened: "2026-11-19"
tags: []
---

# urgent-verify signing key readable by checkout subprocesses via HOME (receipt forgery)

Checkout subprocesses in we:scripts/operations/urgent-verify.mjs run as the signing user, so a test or script in the verified checkout can read or preseed the predictable urgent signing key and forge a green receipt. Worktree isolation does not stop this. A private HOME and file permissions now reduce accidental access, but a same-uid process can chmod the key, read it, and restore its mode without changing the current fingerprint. It can also plant Git config that the parent subsequently executes with its real HOME. This card remains open for an enforced uid or sandbox boundary and hardened parent Git inspection. Found by the R1085 audit of lane/urgent-verify-fixes; confirmed as a residual by review of PR #7187. Priority high (security).

## Acceptance

- [A1] **Executable baseline** — `npm run test:unit -- scripts/operations/__tests__/urgent-verify.test.mjs`: preserve the named tests `a step cannot read the signing key`, `step children get the throwaway HOME, parent-side git calls keep the real one`, `keeps the throwaway HOME present for wrapper children and removes it after exit %s`, `the real wrapper admits an isolated step into the parent temporary pool with the exact wrapper env`, and `every admission call requires a slot (no-pool / bypass means refusal)`.
- [A2] **Required closure regression** — Add a step that chmods, reads, and restores the key mode; it must fail to obtain the key under a separate uid or sandbox. The existing plain-read test alone cannot close this card.
- [A3] **Required closure regression** — Plant checkout `.git/config` fsmonitor and hook commands; parent status/ls-files inspection must not execute them. Pin the parent's Git config and env at every inspection call.
- [A4] **Must refuse** — Missing isolation support, unreadable signing state or bypassed admission produces no green receipt. Treat checkout scripts, config, docs and data as equally untrusted. Keep signing and ledger writes in the trusted parent.

## Non-goals

- [N1] No receipt schema migration or general-purpose sandbox platform; this card concerns urgent verification's signing boundary.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Checkout stderr is diagnostic only, limited to 20 nonempty lines and 8 KiB; it never authorizes a receipt. Token redaction is not yet provided; operators must avoid emitting secrets.
2. **Truncated reads** — Preserve the exact stderr suffix within those limits; tests cover ASCII and multibyte oversized lines. Truncated diagnostics never imply success.
3. **Shared state files** — The trusted parent owns the key and ledger; test modification, creation and replacement attempts. No concurrent-run serialization guarantee is added here.
4. **Fail closed** — Refuse missing isolation or admission, and keep step/exit/stderr in persisted red diagnostics. No HTTP endpoint is introduced, so CSRF and request rate limiting are inapplicable.
5. **Identity scoping** — Private HOME is insufficient for same-uid code; enforce the process boundary before closing A2. Resolve the admission pool before changing HOME or cwd.
6. **State over time** — Retain crash-lock recovery and cleanup on green, red and setup failure. Keep the private HOME alive until step completion.
7. **Who wrote it** — Only the parent signs receipts after checking checkout and signing state; checkout config must never cause that parent to execute arbitrary code (A3).
