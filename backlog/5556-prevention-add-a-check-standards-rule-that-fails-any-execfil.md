---
bornAs: xsgw78z
kind: story
size: 3
status: open
scope: ["we:scripts/lib/lane-hold-io.mjs", "we:scripts/lib/__tests__/lane-hold-io.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that fails any execFileSync/spawnSync('git', …) with a lane cwd that d… (from web-everything/web-everything#4508 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4508's review (reviewed head `cc86709596727fa907d2bcb3f837bdc2a9096982`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/lane-hold-io.mjs:98` — Add a check:standards rule that fails any `execFileSync`/`spawnSync('git', …)` with a lane `cwd` that does not pass `laneGitHardeningEnv`. Then make `snapshotGit` in we:lane-history.mjs pin through `laneGitHardeningEnv`.
2. `we:scripts/lib/lane-hold-io.mjs:143` — Compare the lane's origin URL against the pool's declared origin (the provisioned `--origin`, or the reference clone's config). Query that trusted URL instead, and add a test with a repointed origin that expects the hold to stand.

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
