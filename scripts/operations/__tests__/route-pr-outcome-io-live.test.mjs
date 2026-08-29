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

describe('createRouteOutcomeReader — against the real `gh` binary', () => {
  it('a real, unauthenticated `gh` failure THROWS out of the reader, never a safe-looking empty read', async () => {
    await withRealRepo(async (repo) => {
      const ghConfigDir = mkdtempSync(join(tmpdir(), 'we-gh-config-'));
      try {
        const read = createRouteOutcomeReader({
          // The REAL `execFileSync`, not a fake — only `cwd`/`env` are supplied, the same shape
          // `dispatch-spawn-live.test.mjs`'s `spawnVia` uses on the real `defaultSpawnAgent`.
          run: (bin, argv, opts) => execFileSync(bin, argv, {
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
        expect(() => read({ repo: 'chalbert/web-everything', pr: 1 })).toThrow();
      } finally {
        rmSync(ghConfigDir, { recursive: true, force: true });
      }
    });
  });
});
