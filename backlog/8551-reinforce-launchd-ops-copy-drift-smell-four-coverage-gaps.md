---
bornAs: xtmomvh
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/health-smells/launchd-ops-copy-drift.mjs", "we:scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Reinforce launchd-ops-copy-drift smell: four coverage gaps

Residuals ruled small under R825 from the launchd-ops-copy-drift audit: (1) a failed LaunchAgents directory read reports one launchd-agents subject, so an open drift episode can close on two unreadable scans; (2) Program plus ProgramArguments repeating one script gives two breaches in one tick, bypassing openAfter; (3) scripts hidden in sh -c command strings are skipped; (4) counterpart search covers only scripts/ on origin/main. Also add the smell to we:scripts/conveyor/health-smells-notify-list.mjs once PR 6913 lands.

PR #6927 review repair addresses (1): incomplete directory/plist scans carry persisted unknown job subjects as unverified breaches. Verified-clean labels recover even when an unrelated plist remains unreadable. Coverage includes restarted watcher state, repeated failures, matching or removed jobs, and both scan orders. The shell false-clean path in (3) now produces an unverified breach for recognized shell command invocations; shell command text is never executed or parsed. Extracting safe counterparts from shell commands remains a possible improvement, not a requirement for recovery safety. Gaps (2), (4), and notify-list wiring remain open.

## Filed advisory follow-ups

The seven later-round card suggestions from the 2026-11-16 review are recorded here rather than expanding this repair:

- Command-contract coverage (simplicity item 1; codex items 3 and 4): pin the read-only, local-only subprocess allowlist and one `git show` per unique candidate. Include timeouts, output bounds, success and failure, and assert no mutating or network commands.
- Unreadable-copy coverage (simplicity item 2): inject a failure in `hashCopy`, independently of the existing `hashMain` failure. Assert a low unverified finding and home-relative paths in every low-note path.
- Label precedence (codex item 1): an explicit out-of-scope Label must override an in-scope filename. Missing Label may retain the filename fallback.
- Duplicate arguments (codex item 2): Program and ProgramArguments referencing the same script must produce one breach per job per tick; distinct drifted scripts in one job must also respect `openAfter: 2`.
- Executable acceptance (codex item 5): the command and named planned tests below replace the template placeholder.
- Prevention owed by correctness/security: add a `check:standards` rule rejecting non-draft landing cards with the literal `TODO:` placeholder in Acceptance, Non-goals or Edge cases. Reject incomplete cards with section-specific diagnostics and test draft exemptions. This is filed work; the standards rule is not implemented by this repair.

## Acceptance

- [A1] **Executable** — run the command below from the WE repository. Add the planned tests in the Test plan below as each follow-up lands; existing passing tests alone do not complete this card.

  ```bash
  npm run test:unit -- scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs scripts/conveyor/__tests__/health-responder-core.test.mjs
  ```

- [A2] **Must** — unknown evidence retains an open episode; a verified matching job recovers after two clean ticks even during an unrelated read failure.
- [A3] **Must** — one job supplies at most one breach per tick; two separate drift ticks are required to open its episode.
- [A4] **Must** — compare supported script counterparts outside `scripts/`, preserving ambiguity handling and the one-tree-read bound.
- [A5] **Must** — explicit Label controls scope; copy-read failure stays unverified; subprocesses remain bounded, read-only and local.
- [A6] **Must** — register observation-only notification after PR #6913 lands, and implement the placeholder rejection rule with positive and negative tests.

## Risks

- R1: unknown data silently closes an episode, or unrelated unknown data prevents legitimate recovery (A2).
- R2: duplicate observations bypass the episode opening threshold (A3).
- R3: restricted counterpart discovery or filename precedence silently excludes a running stale script (A4/A5).
- R4: reads fail, commands mutate state/contact a remote, or subprocess cost grows with duplicate arguments (A5).
- R5: alerts trigger repairs, leak home paths, or follow-up cards land with untestable acceptance (A5/A6).

## Test plan

Existing regression names in `we:scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs`:

- R1/A2: `partial failures allow verified recovery while retaining unknown jobs` and `failures preserve persisted drift episodes until verified recovery` exercise production `runHealthTick` and serialized state.
- R1/A2: `shell command stays unverified through persisted health ticks` covers shell names, option clusters, quoting, interpolation and command separators. `Program shell with custom argv zero is unverified, even beside a matching direct script` covers the separate Program field.
- R5/A6: `keeps launchd copy drift observation-only` in `we:scripts/conveyor/__tests__/health-responder-core.test.mjs` pins responder behavior.

Named tests still to add before this card can close:

- R2/A3: `duplicate script arguments count once per tick` and `multiple drifted scripts in one job require two ticks`.
- R3/A4: `drifted counterpart outside scripts is compared`; include absent and ambiguous counterparts.
- R3/A5: `explicit out-of-scope Label overrides matching filename`.
- R4/A5: `unreadable copy produces a low unverified finding`; fail `hashCopy` directly.
- R4/A5: `scanner executes only bounded local read commands` and `one git show per unique candidate`; capture all injected subprocess calls and assert exact allowed argv, timeouts and buffer bounds.
- R5/A5: `all low notes redact home paths`; exercise unreadable copy, counterpart discovery and ambiguity notes.
- R5/A6: `launchd copy drift notification remains observation-only`; add alongside notify-list wiring after PR #6913.
- R5/A6: `non-draft landing cards reject TODO placeholders in required sections`; cover each section, complete cards and the draft exemption in the standards checker tests. Run that named test through `npm run test:unit -- <checker-test-file>` and `npm run check:standards` when implementing the rule.

The production lifecycle replay is `we:scripts/conveyor/soak/breaks/launchd-drift-unverified-recovery.mjs`, automatically registered by the soak registry. Its wrapper is `we:scripts/conveyor/soak/breaks/launchd-drift-unverified-recovery.soak.test.mjs`.

## Non-goals

- [N1] No automatic copying, plist edits, launchd restarts, Git writes or network reads.
- [N2] No general shell interpreter or command substitution. Recognized shell command strings may remain unverified until the job uses directly inspectable arguments.
- [N3] No new HTTP endpoints; body-size, CSRF and request-rate controls do not apply to this local reader.

## Edge cases this change must handle

1. **Untrusted text** — treat shell text as opaque; never execute substitutions, quotes, escapes, newlines or concatenated fragments. Keep Git arguments in argv arrays.
2. **Truncated reads** — command errors, timeouts and buffer overflows yield unverified findings, not empty clean scans.
3. **Shared state files** — this reader writes none; persisted episodes remain owned by the health engine.
4. **Fail closed** — retain unknown labels, but permit independently verified labels to recover; a finding for a label overrides clean evidence for that label.
5. **Identity scoping** — follow explicit Labels and deduplicate by job identity before counting breaches.
6. **State over time** — serialize/reload an open episode, repeat failed scans, then verify matching and removed-job recovery.
7. **Who wrote it** — plist contents are input data, never authority for writes or subprocess execution.
