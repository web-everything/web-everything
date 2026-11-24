---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7427 (head 3e24a0543)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7427 (reviewed head `3e24a0543ef3283098f786116d8db01e42748618`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/remote-exec.mjs:238` — (edge-case, degraded) Probe deadline does not bound waiting for inherited output pipes
   - Scenario: Configure the first target with ProxyCommand running node -e 'process.on("SIGHUP",()=&gt;{});setTimeout(()=&gt;{},12000)'. With the production 10000ms deadline, discovery reached the fallback target only after 12058ms. defaultExec waits for close, which requires the proxy's inherited stderr to close; SSH exiting or being killed does not settle it. A proxy that remains alive can block fallback indefinitely. Discovery should advance within its advertised deadline regardless of descendant-held pipes.
   - Class: live-reproduced (basis: Reproduced using actual OpenSSH and defaultExec through pickRemoteTarget, retaining its production connection timeout and execution deadline. No network connection or filesystem writes were needed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/readiness/heavy-admission.mjs:1329` — (failing-input, degraded) Configured ordering overrides an explicit --host request
   - Scenario: Configure remote.hosts as Mesa then Forge, with Mesa reachable, and invoke we:scripts/readiness/remote-exec.mjs --host=forge -- npm run test:unit -- we:a.test.mjs. main forwards the explicit Forge host, but custom target discovery unconditionally replaces it with Mesa. The command targets Mesa despite explicitly requesting Forge. Explicit host selection should take precedence over the configured default ordering.
   - Class: correctness-in-normal-use (basis: A read-only runWithRemoteDecision probe with host='forge', the ordered configuration, and successful injected discovery observed selected=mesa-01. The probe stopped at that log before filesystem writes. The CLI forwards options.host directly into this function.)
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
