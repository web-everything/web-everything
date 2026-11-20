/**
 * @file sim-scenarios-smoke.test.mjs — epic #3383, the first TRACER scenario for the daemon scenario simulator
 * (`reports/2026-09-24-daemon-scenario-simulator.md`). One `review:pending` PR on a real branch; `tick review`
 * must dispatch exactly one `review-<n>` session through the REAL `review-dispatch.mjs` path (passing
 * main-staleness against the sim origin, capped by `lane-pool list --acquirable` seeing the provisioned lanes,
 * spawning the fake `claude --bg`); the session posts an `accepted` verdict and exits; the tick after that
 * dispatches nothing further.
 *
 * REAL-PROCESS COST (many `node`/`git` child spawns, a forked daemon host, a dynamic import of the sim clone's
 * own module graph) — same tier as this file's own siblings (`sim-clock.test.mjs`, `fake-claude-sessions.test.mjs`,
 * `fake-gh-state.test.mjs`), so it is registered in `vitest.integration.config.ts`, not the default unit config,
 * and pinned to the `forks` pool for the same contention reason that file's own header gives for its other
 * many-child-process members.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { scenario, runScenario } from './sim/scenario.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../lib/required-status-checks.mjs';

function tracerDef() {
  return scenario('review-pending-accept-tracer', {
    repos: ['we'],
    daemons: ['review'],
    lanes: 3,
    setup(w) {
      // This world runs fake Claude sessions, not host review-job processes. A denied
      // host process-table read must not consume its simulated review capacity.
      const bin = join(w.root, 'unreadable-process-table');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      w.env.PATH = `${bin}${delimiter}${w.env.PATH}`;
      w.git.createBranch('we', 'lane/tracer-1-thing', { from: 'main', files: { 'a.txt': 'hello from the PR\n' } });
      const pr = w.gh.openPr({
        repo: 'we',
        head: 'lane/tracer-1-thing',
        base: 'main',
        title: 'tracer: a small change',
        labels: ['review:pending'],
      });
      // A PR owes a review only once every required check succeeded on its head (review CI gate).
      w.gh.setRequiredChecks('we', FALLBACK_REQUIRED_STATUS_CHECKS);
      w.gh.setChecks('we', pr, FALLBACK_REQUIRED_STATUS_CHECKS.map((name) => ({ name, conclusion: 'SUCCESS' })));
      w.agents.script('review-*', [
        w.act.postVerdict({ verdict: 'accepted' }),
        w.act.exit({ state: 'done' }),
      ]);
      return { pr };
    },
    // Two 'agents' rounds: `stepSessions` advances ONE queued action per session per call — the first round
    // runs `postVerdict` (posts the comment + flips the label), the second runs `exit` (kills the sleeper pid,
    // marks the session `done`). Only after BOTH has the session left the LIVE (`working`/`blocked`) axis, so
    // the second `tick review` sees a settled PR with nothing live bound to it.
    play: ['tick review', 'agents', 'agents', 'tick review'],
    expect(s, { pr }) {
      const row = s.pr(pr, 'we');
      expect(row).toBeTruthy();
      expect(row.labels).toContain('review:accepted');
      expect(row.labels).not.toContain('review:pending');

      expect(s.sessions('review-*')).toHaveLength(1);

      const ticks = s.ticks('review');
      expect(ticks).toHaveLength(2);
      expect(ticks[0].error).toBeNull();
      expect(ticks[0].result?.dispatched?.length).toBe(1);
      expect(ticks[0].result?.dispatched?.[0]?.prNumber).toBe(pr);
      expect(ticks[1].error).toBeNull();
      expect(ticks[1].result?.dispatched?.length ?? 0).toBe(0);
    },
  });
}

describe('#3383 daemon scenario simulator — tracer scenario', () => {
  it('dispatches, accepts, and settles a single review:pending PR with an unreadable host process table', async () => {
    await runScenario(tracerDef(), { timeoutMs: 180_000 });
  }, 180_000);
});
