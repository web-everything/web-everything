---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-target.mjs", "we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7572 (head 35b65c761)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7572 (reviewed head `35b65c761875812a9b777d53914aec7cafaabb84`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/remote-target.mjs:2` — (failing-input, degraded) The CLI still overrides the Mesa default with the retired forge alias
   - Scenario: Run node we:scripts/readiness/remote-exec.mjs -- npm run check:standards with valid canonical preferences, Mesa available, and forge unavailable. parseArgs still supplies host='forge', so the new target-selection path probes only forge and falls back locally without trying mesa-01. Omitting --host should select the new default; only an explicitly supplied host should override it.
   - Class: live-reproduced (basis: Executed the real parseArgs-to-main path with in-memory preferences and filesystem mutations disabled. An injected runner-missing response produced exactly one readiness probe, targeting forge, followed by local fallback.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/readiness/remote-exec.mjs:1841` — (failing-input, degraded) The new readiness probe drops custom SSH transport options
   - Scenario: Call main with host='mesa-01', sshOptions=['-p','2222','-i','/custom/key'], healthy telemetry supplied through readTelemetry, and a runner requiring that port and identity. main forwards those options to runRemote but omits them from runWithRemoteDecision. The newly required readiness probe therefore uses the default port and identity, declares the runner unreachable, and falls back locally before the configured transport runs. Forward options.sshOptions to the admission decision so readiness uses the job's connection settings.
   - Class: live-reproduced (basis: Ran main with those SSH options while intercepting the actual defaultExec spawn and disabling filesystem mutations. The captured SSH arguments contained only ConnectTimeout=5, BatchMode=yes, the host, and the readiness command; both supplied connection options were absent. A simulated SSH failure then selected local fallback.)
   - Also class: correctness-in-normal-use
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
