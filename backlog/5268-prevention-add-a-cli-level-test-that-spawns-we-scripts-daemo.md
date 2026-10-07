---
bornAs: x8ybft8
kind: story
size: 3
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-clone-registry.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a CLI-level test that spawns we:scripts/daemon-overlay.mjs with WE_DAEMON_OVERLAY_DIR set and… (from web-everything/web-everything#4249 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4249's review (reviewed head `3e384b88b47ecd3d4d558922e36d87dde01aa476`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/daemon-overlay.mjs:263` — Add a CLI-level test that spawns we:scripts/daemon-overlay.mjs with WE_DAEMON_OVERLAY_DIR set and asserts stale records are pruned. Derive the workspace through one shared helper that both guard-lane and the overlay CLI call.
2. `we:scripts/lib/daemon-clone-registry.mjs:131` — Take the per-clone list lock, or re-read and re-classify immediately before unlink. Alternatively restrict pruning to `add`/`remove` paths that already hold the lock. Add a lint or standards rule that state-file deletions must go through we:daemon-overlays.mjs.
3. `we:scripts/daemon-overlay.mjs:262` — Add a CLI-boundary test that runs we:scripts/daemon-overlay.mjs from a primary-shaped path with a leaked pool-lane record and asserts the record is dropped. Better, export one shared 'workspace from a script URL' helper that guard-lane, the registry and the overlay CLI all use.
4. `we:scripts/lib/daemon-clone-registry.mjs:125` — Re-read and re-classify immediately before unlinking, or rename to a .stale file instead of deleting. Restrict the prune to mutating subcommands. Add a test where the record gains overlays between classify and unlink.
5. `we:scripts/lib/daemon-clone-registry.mjs` — Add a deterministic regression test with .lanes symlinked outside the workspace, asserting both registry exclusion and stale-record pruning.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
