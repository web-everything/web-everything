---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/lib/ci-selection-settings.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7123 (head cecaea39e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `cecaea39e042db8a5f1fb1d183946fd2430ec46e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:115` — (failing-input, degraded) Reads through symlinks miss dependencies on the tracked target
   - Scenario: Read 'we:.claude/skills/jury/SKILL.md', then merge the snapshot and compare against changed='we:skills-src/jury/SKILL.md'. The existing symlink resolves to that tracked file, but the trace records only 'we:.claude/skills/jury/SKILL.md'. Replay returns traced:false, traceKnown:true and incomplete:false. It should retain the resolved target dependency as well as the alias.
   - Class: live-reproduced (basis: A Node probe successfully read 9198 bytes through the repository's existing symlink and reproduced the complete-but-negative coverage result without filesystem writes.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/ci/dep-trace.mjs:383` — (edge-case, degraded) Exit-handler reads occur after the trace has already been saved
   - Scenario: Activate tracing, then register process.on('exit', () =&gt; fs.readFileSync('we:scripts/settings/ci-selection.json')). The tracer's earlier exit listener saves an empty, complete snapshot before the application's listener reads the file. The live tracer subsequently contains the read, but replay of the saved snapshot returns traced:false and incomplete:false. Exit-handler dependencies should be persisted or their absence marked unknown.
   - Class: live-reproduced (basis: Observed with actual activateTrace and a real filesystem read on Node 22.1.0; only artifact mkdir/write operations were replaced with an in-memory sink. The persisted snapshot was empty while the subsequent live snapshot contained the dependency.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/ci/dep-trace.mjs:332` — (failing-input, degraded) Directory listing dependencies do not match changed directory entries
   - Scenario: A test checks that fs.readdirSync('scripts/settings') includes 'we:ci-selection.json'. Tracing records only file='scripts/settings', kind='list'. Replay with changed='we:scripts/settings/ci-selection.json', such as a deletion that breaks this assertion, returns traced:false with complete evidence because it requires an exact path match. Listing dependencies should cover changes to directory membership.
   - Class: live-reproduced (basis: A real readdirSync returned the named entry, and merging its snapshot then replaying the child path produced traced:false, traceKnown:true and incomplete:false. No directory modification was performed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
4. `we:scripts/lib/ci-selection-settings.mjs:24` — (failing-input, degraded) The settings loader suppresses automatic platform preference loading
   - Scenario: With no tool-layer trace overrides and platform preferences containing 'ci.selection.trace': {enabled:false,maxEdgesPerTest:19}, call loadCiSelection with platform omitted. It passes platform:{} to cascadePolicy, preventing that function from consulting the platform preference file, and returns enabled:true,maxEdgesPerTest:5000. The omitted platform argument should allow normal platform resolution, including when the tool settings file is absent or unreadable.
   - Class: live-reproduced (basis: An in-memory readFileSync fixture supplied the platform preference file through WE_PLATFORM_PREFERENCES_FILE. Direct cascadePolicy resolved false/19, while loadCiSelection with the same environment and tool:{} resolved true/5000.)
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
