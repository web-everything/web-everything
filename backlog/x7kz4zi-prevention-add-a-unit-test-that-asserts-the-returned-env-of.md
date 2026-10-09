---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/git-transport-branch.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:backlog/xmzttwc-wire-daemonclonebranches-probe-into-health-watch-so-daemon-c.md", "we:scripts/lib/__tests__/git-transport-branch.test.mjs", "we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/wrong-branch-heal.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a unit test that asserts the returned env of worktreeGitEnv. More generally, require a named… (from web-everything/web-everything#4613 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4613's review (reviewed head `93dec9a2ac2c85efff1aa580ecd52ba1cf03e6ef`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/git-transport-branch.mjs:48` — Add a unit test that asserts the returned env of worktreeGitEnv. More generally, require a named test for each guard clause that a comment describes.
2. `we:scripts/lib/daemon-rebuild/prepare.mjs:172` — Require an integration test at each call site when a new pure module is wired into an existing orchestrator. A review lens on 'new module wired in → seam test' is the cheapest guard.
3. `we:backlog/xmzttwc-wire-daemonclonebranches-probe-into-health-watch-so-daemon-c.md:13` — When a PR lands the work a filed card describes, close or rescope the card. A standards check that rejects an open card whose scope file shows the described change already merged would catch this.
4. `we:scripts/lib/__tests__/git-transport-branch.test.mjs:121` — Add a pure `worktreeGitEnv` unit test with a poisoned base env, and have the replay test run with GIT_DIR set to the board's .git. File it as a backlog item.
5. `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs:94` — Add mandatory real-Git regression tests with an untracked directory obstructing restoration of a tracked store file and an ignored file conflicting with main; assert refusal and byte-for-byte preservation before permitting destructive healing.
6. `we:scripts/lib/__tests__/git-transport-branch.test.mjs:128` — Add a mandatory parameterized environment-isolation test covering each removed variable, using explicit hostile values rather than ambient process defaults.

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
