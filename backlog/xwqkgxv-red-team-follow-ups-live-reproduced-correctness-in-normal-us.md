---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-jobs.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7552 (head 35c9902ab)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7552 (reviewed head `35c9902ab5dfcde747b3770d924e3503184618b8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-jobs.mjs:448` — (edge-case, degraded) Formula revisions are ignored, producing unknown statuses before and after a valid upgrade.
   - Scenario: Supply gh inventory with versions.stable='2.80.0', revision=1, installed version '2.80.0', and outdated current_version='2.80.0_1'. The watcher reports unknown with conflicting evidence instead of outdated. After installing '2.80.0_1' and clearing outdated.formulae, it still reports unknown instead of current. Formula latest-version comparison must include Homebrew's revision suffix.
   - Class: live-reproduced (basis: Direct Node probes reproduced both failures using the exported factory. Local Homebrew source confirms inventory exposes revision separately, installed keg versions include it, and outdated.current_version uses the full package version.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-jobs.mjs:456` — (edge-case, degraded) Retaining an older formula keg makes an up-to-date tool report unknown.
   - Scenario: Supply gh inventory with installed versions '2.79.0' and '2.80.0', versions.stable='2.80.0', revision=0, linked_keg='2.80.0', outdated=false, and empty outdated arrays. The watcher emits an unknown advisory because one retained keg differs from latest. It should report current when the current linked version is installed; retaining an old keg does not contradict Homebrew's freshness evidence.
   - Class: live-reproduced (basis: A direct Node probe reproduced the false unknown advisory. Local Homebrew source includes every installed keg in inventory but returns no outdated kegs when a current linked keg exists.)
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
