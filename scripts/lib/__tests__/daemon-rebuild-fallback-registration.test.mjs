/** Fallback smoke evidence keeps its captured registration through attribution and ready recovery.
 * Git/planning and candidate IO are injected; registry, state and cleanup use real temporary files. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as candidate from '../daemon-rebuild/candidate.mjs';
import * as planner from '../daemon-rebuild/plan.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { dropSuspectOverlays, finalizeRebuild, matchReadyCandidate } from '../daemon-rebuild/adopt.mjs';
import { readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['plain-main', 'set-aside'])('%s fallback registration evidence', (branch) => {
  describe.each(['direct', 'ready', 'ready-main-moved'])('%s adoption', (adoption) => {
    it.each(['matching', 'replaced', 'missing'])('handles %s captured registration safely', async (identity) => {
      const root = mkdtempSync(join(tmpdir(), 'fallback-registration-'));
      dirs.push(root);
      const env = {
        WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_CLOSURE_SCOPE: 'off',
        WE_REBUILD_SMOKE_REUSE_ENABLED: '0',
      };
      const bad = addOverlay(root, { ref: 'lane/bad', pr: 1 }, { env })[0];
      const good = branch === 'set-aside' ? addOverlay(root, { ref: 'lane/good', pr: 2 }, { env }).find(o => o.ref === 'lane/good') : null;
      const sha = (char) => char.repeat(40);
      const appliedBad = { ref: bad.ref, pr: bad.pr, sha: sha('b'), registrationId: bad.registrationId };
      if (identity === 'missing') delete appliedBad.registrationId;
      const appliedGood = good ? { ref: good.ref, pr: good.pr, sha: sha('c'), registrationId: good.registrationId } : null;
      const plan = { ok: true, finalSha: sha('a'), mainSha: sha('d'), inputsKey: 'failed',
        applied: [appliedBad, ...(appliedGood ? [appliedGood] : [])] };
      const fallback = { ok: true, finalSha: sha('e'), mainSha: sha('d'), inputsKey: 'passed', applied: appliedGood ? [appliedGood] : [] };
      const prevHead = fallback.finalSha; // exercise finalize's already-adopted path without Git writes
      const now = () => Date.parse('2026-10-29T12:00:00Z');
      const lease = { token: 'fallback-registration', path: join(root, 'candidate') };
      vi.spyOn(candidate, 'materializeCandidate').mockImplementation(({ path }) => ({ ok: true, path }));
      vi.spyOn(candidate, 'removeCandidate').mockImplementation(() => {});
      const replan = vi.spyOn(planner, 'planRebuild').mockResolvedValue(fallback);
      const run = vi.fn((args) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: `${fallback.finalSha}\n` };
        if (args[0] === 'merge-base') return { status: 0, stdout: `${plan.mainSha}\n` };
        if (args[0] === 'diff') return { status: 0, stdout: args.includes('--') ? '' : args.at(-1) === appliedBad.sha ? 'scripts/bad.mjs\n' : 'scripts/good.mjs\n' };
        if (args[0] === 'show') return { status: 0, stdout: '{}' };
        throw new Error(`unexpected Git command: ${args.join(' ')}`);
      });
      let current = bad;
      const runSmoke = vi.fn()
        .mockImplementationOnce(async () => {
          // Replacement occurs after preparation's snapshot, while the failing candidate is smoking.
          if (identity === 'replaced') current = addOverlay(root, { ref: bad.ref, pr: bad.pr }, { env }).find(o => o.ref === bad.ref);
          return { verdict: 'code', smoke: { results: [{ name: 'syntax', ok: false, mayBeTransient: false,
            detail: `${lease.path}/scripts/bad.mjs:1:1: SyntaxError: broken` }] } };
        })
        .mockResolvedValue({ verdict: 'pass', smoke: { results: [] } });
      let result = await smokeAndAdopt({ root, env, stEnv: env, log: {}, run, runSmoke, now, plan, prevHead,
        lease, overlaysBefore: [bad, ...(good ? [good] : [])], prepAlerts: [], mainOnly: false,
        finalLockOpts: { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 20 }, readyOnly: adoption !== 'direct',
        dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: vi.fn(), match: vi.fn() },
      });
      expect(replan).toHaveBeenCalledTimes(1);
      expect(runSmoke).toHaveBeenCalledTimes(2);
      expect(result.reason).toBe(branch === 'set-aside' ? 'overlay-set-aside' : 'fallback-plain-main');
      if (adoption !== 'direct') {
        expect(readOverlays(root, { env }).find(o => o.ref === bad.ref)?.registrationId).toBe(current.registrationId);
        const ready = JSON.parse(JSON.stringify(readReadyCandidate(root, env)));
        expect(ready.dropRefs).toEqual([{ ref: bad.ref, pr: bad.pr, sha: appliedBad.sha,
          ...(identity === 'missing' ? {} : { registrationId: bad.registrationId }) }]);
        const match = matchReadyCandidate({ ready, plan: adoption === 'ready' ? plan : { ...plan, inputsKey: 'main-moved' },
          prevHead, nowMs: now(), maxAgeMs: 60_000, stillWanted: () => true, verifyBuilt: () => true,
          registered: () => true, overlayTip: () => appliedBad.sha });
        expect(match.match).toBe(adoption === 'ready' ? 'fallback' : 'fallback-main-moved');
        result = await finalizeRebuild({ root, env, log: {}, run, now, plan: match.adopt, prevHead, lease,
          onAdopted: ({ alert }) => dropSuspectOverlays({ root, env, suspects: match.dropRefs, failed: match.failed, alert }),
        });
      }
      expect(result.adopted).toBe(true);
      const remaining = readOverlays(root, { env });
      expect(remaining.map(o => o.ref)).toEqual([
        ...(identity === 'matching' ? [] : [bad.ref]), ...(good ? [good.ref] : []),
      ]);
      const kinds = result.alerts.map(a => a.kind);
      if (identity === 'matching') {
        expect(kinds).toContain('overlay-dropped-smoke-failed');
        expect(kinds).not.toContain('overlay-registration-changed');
      } else {
        expect(remaining.find(o => o.ref === bad.ref)?.registrationId).toBe(current.registrationId);
        expect(kinds).toContain('overlay-registration-changed');
        expect(kinds).not.toContain('overlay-dropped-smoke-failed');
      }
    });
  });
});
