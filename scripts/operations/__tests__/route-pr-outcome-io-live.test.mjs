/**
 * @file route-pr-outcome-io-live.test.mjs — the #2949 fidelity qualifier for `route-pr-outcome-io.mjs`
 *   (`we:scripts/lib/operation-io-fidelity.mjs`), against the REAL `gh` binary.
 *
 * WHAT AN INJECTED-STUB TEST CANNOT PROVE HERE. Every other test for this module (`route-pr-outcome.test.mjs`)
 * drives `createRouteOutcomeReader({ run: fakeRun })`, and `fakeRun` can return or throw anything — it has no
 * clone geometry, no real argv parser, no real process exit code, exactly the vacuity #3264's postmortem names
 * (`we:scripts/lib/operation-io-fidelity.mjs`'s header). This file drives the reader through its REAL default —
 * the real `execFileSync` spawning the real `gh` binary — so the one property that matters for a routing
 * operation (a failed read THROWS, it never degrades into the safe-looking `no-escalation-reasons` shape) is
 * proven against the actual subprocess boundary, not a promise about it.
 *
 * WHY THIS IS NOT THE SAME GAP `pr-status`/`open-pr` ARE EXEMPT FOR. Both are permanently listed in
 * `UNCONVERTED_IO_MODULES` because "the effect IS the remote call" — their SUCCESS path answers with real PR
 * data that no offline fixture can fabricate, so there is nothing hermetic to assert there. This operation's
 * fidelity-critical property is narrower and does not have that problem: it is the FAILURE path — does a real,
 * unrecoverable `gh` failure actually throw all the way out, rather than being read as "nothing escalated"? A
 * real, deterministic, OFFLINE `gh` failure (unauthenticated, no network attempted) proves that without needing
 * a live PR, live network, or a live token — see below for how.
 *
 * HOW THE FAILURE IS MADE REAL, DETERMINISTIC, AND OFFLINE, all three at once. `GH_CONFIG_DIR` is pointed at a
 * fresh empty directory and `GH_TOKEN`/`GITHUB_TOKEN` are cleared, so `gh` finds no stored credential — it
 * refuses immediately with `please run gh auth login` (verified by hand against this machine's real,
 * ALREADY-AUTHENTICATED `gh`: with the config dir and env cleared, the keyring-stored login is not consulted,
 * so the refusal is real and does not depend on this host's own auth state, its network reachability, or GitHub
 * being up). `execFileSync` is never replaced — only its `env`/`cwd` are, the same shape
 * `dispatch-spawn-live.test.mjs`'s `spawnVia` uses on the real `defaultSpawnAgent`.
 *
 * ONE MORE THING PATH-CLEARING ALONE DOES NOT COVER (live-caught 2026-09-25, xpc3krl): a fleet Mac running
 * daemon dispatches opts into `we:scripts/lib/gh-app-shim.mjs`'s GitHub App shim — a small wrapper script
 * installed under `~/.claude/github-app-token/gh-shim(.d/<key>)` that answers `gh` calls from its OWN cached
 * App-installation token file, never from `GH_TOKEN`/`GH_CONFIG_DIR`. If that directory sits ahead of the real
 * `gh` on THIS test's own inherited `PATH` (true on a host mid-dispatch, never in CI), a bare `execFileSync('gh',
 * ...)` resolves to the shim instead — which authenticates fine regardless of the env clearing above, and the
 * "unauthenticated failure" this test exists to prove never happens. `resolveRealGhBinary` (the same helper
 * `buildGhShimSettingsEnv` uses to find what to shadow) walks `PATH` and skips every directory under the shim
 * root, so `bin` below is always the real binary, never whatever shim happens to be ahead of it.
 *
 * A REAL GIT REPO (`withRealRepo`) roots the call in a genuine directory rather than this test file's own cwd —
 * not because `gh pr view --repo <slug>` needs git context (it does not; the target repo is named explicitly),
 * but because it is the realistic shape a production caller's `cwd` takes, and it is the harness this repo's
 * #2949 fidelity check looks for.
 *
 * COSTS NOTHING and touches no network: `gh` refuses locally, before any HTTP request is attempted.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRealRepo } from './helpers/real-repo.mjs';
import { createRouteOutcomeReader } from '../route-pr-outcome-io.mjs';
import { resolveRealGhBinary } from '../../lib/gh-app-shim.mjs';

describe('createRouteOutcomeReader — against the real `gh` binary', () => {
  it('a real, unauthenticated `gh` failure THROWS out of the reader, never a safe-looking empty read', async () => {
    await withRealRepo(async (repo) => {
      const ghConfigDir = mkdtempSync(join(tmpdir(), 'we-gh-config-'));
      // Skip the App shim if this host's PATH already has one ahead of the real binary (see the file header) —
      // falls back to the bare command on a host with no real `gh` outside PATH at all (never expected here).
      const realGh = resolveRealGhBinary() || 'gh';
      try {
        const read = createRouteOutcomeReader({
          // The REAL `execFileSync`, not a fake — only `cwd`/`env` are supplied, the same shape
          // `dispatch-spawn-live.test.mjs`'s `spawnVia` uses on the real `defaultSpawnAgent`.
          run: (bin, argv, opts) => execFileSync(bin === 'gh' ? realGh : bin, argv, {
            ...opts,
            cwd: repo.root,
            env: {
              ...process.env,
              GH_CONFIG_DIR: ghConfigDir, // no stored login reachable from here
              GH_TOKEN: '',
              GITHUB_TOKEN: '',
            },
          }),
        });

        // The repo/pr are irrelevant — `gh` refuses on the missing credential before it would ever ask
        // GitHub whether either exists. What matters is that the REAL non-zero exit reaches the reader as a
        // throw, exactly as `execFileSync`'s real contract says it must.
        expect(() => read({ repo: 'web-everything/web-everything', pr: 1 })).toThrow();
      } finally {
        rmSync(ghConfigDir, { recursive: true, force: true });
      }
    });
  });
});
