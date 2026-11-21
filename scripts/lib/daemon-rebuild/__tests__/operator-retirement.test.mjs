import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adoption from '../adopt.mjs';
import { prepareRebuild } from '../prepare.mjs';
import { writeReadyCandidate, writeRebuildState } from '../state.mjs';
import * as planner from '../plan.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as localState from '../local-state.mjs';
import * as lease from '../lease.mjs';
import * as repair from '../../lane-repair.mjs';
import { addOverlay, appendOverlayEvent, readOverlays, removeOverlay } from '../../daemon-overlays.mjs';

const ref = 'lane/overlay-fix';
const sha = 'a'.repeat(40);
const added = { kind: 'added', ref, at: '2026-11-14T10:00:00Z' };
describe('prepare registration and audit identity hardening', () => {
  let root, env;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'overlay-retirement-'));
    env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    addOverlay(root, { ref }, { env });
    appendOverlayEvent(root, added, { env });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    'removed during planning',
    'audited omission', 'explicitly pinned omission', 're-registered pinned during planning',
  ])('prepareRebuild adapter: %s', async (mode) => {
    env = { ...env, WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_AUTO_REBASE: '0',
      WE_DAEMON_OVERLAY_FOLLOW_TIP: mode === 'audited omission' ? 'audited-only' : 'follow' };
    const liveHead = 'b'.repeat(40), mainSha = 'c'.repeat(40), candidate = 'd'.repeat(40);
    const carried = 'lane/carried';
    const pinnedOmission = ['explicitly pinned omission', 're-registered pinned during planning'].includes(mode);
    if (mode === 'explicitly pinned omission') addOverlay(root, { ref, pinned: true }, { env });
    addOverlay(root, { ref: carried, pr: 100 }, { env });
    appendOverlayEvent(root, { ...added, ref: carried }, { env });
    const plan = { ok: true, finalSha: 'e'.repeat(40), mainSha, inputsKey: 'new-plan', applied: [], decisions: [], alerts: [] };
    if (mode === 'audited omission') plan.auditAdopted = [ref];
    writeRebuildState(root, { adopted: { head: liveHead, mainSha, applied: [{ ref, sha }] } }, env);
    writeReadyCandidate(root, { kind: 'candidate', prevHead: liveHead, passedAt: '2026-11-15T10:00:00Z', tree: 'candidate-tree',
      adopt: { finalSha: candidate, mainSha, inputsKey: 'ready-plan', applied: pinnedOmission || mode === 'audited omission' ? [] : [{ ref: carried, sha }] } }, env);
    vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(planner, 'planRebuild').mockImplementation(async () => {
      if (mode === 'removed during planning') removeOverlay(root, ref, { env });
      if (mode === 're-registered pinned during planning') {
        removeOverlay(root, ref, { env });
        addOverlay(root, { ref, pinned: true }, { env });
      }
      return plan;
    });
    vi.spyOn(adoption, 'readyBuildVerified').mockReturnValue(true);
    vi.spyOn(lease, 'claimBuildLease').mockReturnValue(null);
    const matching = vi.spyOn(adoption, 'matchReadyCandidate');
    vi.spyOn(adoption, 'finalizeRebuild').mockResolvedValue({ moved: true, head: candidate });
    const run = (args) => {
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'symbolic-ref') return ok('main');
      if (args[0] === 'rev-parse') {
        const rev = args.at(-1);
        if (rev === 'HEAD') return ok(liveHead);
        if (rev === 'origin/main^{commit}') return ok(mainSha);
        if (rev === `${plan.finalSha}^{tree}`) return ok('plan-tree');
        if (rev === `refs/remotes/origin/${carried}^{commit}`) return ok(sha);
      }
      if (args[0] === 'ls-files' || args[0] === 'log') return ok();
      if (args[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' };
      if (['merge-tree', 'config'].includes(args[0])) return { status: 1, stdout: '', stderr: '' };
      throw new Error(`unexpected Git: ${args.join(' ')}`);
    };
    await prepareRebuild({ root, env, run, now: () => Date.parse('2026-11-15T10:01:00Z'), adoptOnly: true });
    expect(matching).toHaveBeenCalledOnce();
    if (pinnedOmission) {
      const hooks = matching.mock.calls[0][0];
      expect(hooks.registered(ref)).toBe(true);
      expect(hooks.auditedTip).not.toBeTypeOf('function');
      expect(readOverlays(root, { env }).find((o) => o.ref === ref)?.pinned).toBe(true);
      expect(adoption.finalizeRebuild).not.toHaveBeenCalled();
    }
    const match = matching.mock.results[0].value;
    expect(match).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${ref}` });
  });
});
