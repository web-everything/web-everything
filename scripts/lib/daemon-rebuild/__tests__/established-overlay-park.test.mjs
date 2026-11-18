import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild, readOverlayEventLog } from '../prepare.mjs';
import { readRebuildState, writeRebuildState } from '../state.mjs';
import * as planner from '../plan.mjs';
import * as auditedTip from '../audited-tip.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as localState from '../local-state.mjs';
import * as lease from '../lease.mjs';
import * as repair from '../../lane-repair.mjs';
import { addOverlay, readOverlays } from '../../daemon-overlays.mjs';

const ref = 'lane/live', sha = 'a'.repeat(40), head = 'b'.repeat(40), main = 'c'.repeat(40);
const start = Date.parse('2026-11-18T10:00:00Z');
describe('bounded established overlay hold', () => {
  let root, env, plan, time;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'established-park-'));
    const prefs = join(root, 'prefs.json');
    writeFileSync(prefs, '{}');
    env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
      WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: prefs,
      WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' };
    addOverlay(root, { ref }, { env });
    plan = { ok: true, mainSha: main, finalSha: main, inputsKey: 'main', applied: [], alerts: [],
      establishedLost: [{ ref, sha, reason: 'conflict' }],
      decisions: [{ ref, sha, action: 'drop', reason: 'conflict' }] };
    writeRebuildState(root, { adopted: { head, applied: [{ ref, sha }] },
      held: { reason: 'established-overlay-conflict', since: new Date(start).toISOString(), lastGood: head } }, env);
    time = start + 31 * 60_000;
    vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(planner, 'planRebuild').mockImplementation(async () => plan);
    // Positive cases explicitly supply proof that this exact tip adds nothing to main.
    vi.spyOn(auditedTip, 'tipInMain').mockImplementation((_git, target, tip) => target === main && tip === plan.establishedLost[0].sha);
    vi.spyOn(lease, 'claimBuildLease').mockReturnValue({ token: 'test' });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const run = (args) => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'symbolic-ref') return ok('main');
    if (args[0] === 'rev-parse') return ok(args.at(-1) === 'HEAD' ? head : main);
    if (args[0] === 'ls-files' || args[0] === 'log') return ok();
    if (args[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' };
    throw new Error(`unexpected Git: ${args.join(' ')}`);
  };
  const tick = () => prepareRebuild({ root, env, run, now: () => time, prBaseChain: () => [] });
  const held = () => readRebuildState(root, env).held;
  const parked = (r) => r.alerts.filter(a => a.kind === 'established-overlay-parked');
  it('holds under the threshold, including the exact boundary', async () => {
    time = start + 30 * 60_000;
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(held().since).toBe(new Date(start).toISOString());
    expect(parked(r)).toEqual([]);
  });
  it('parks beyond the threshold only with content proof, keeps registration and clears held before building', async () => {
    const r = await tick();
    expect(r.terminal).toBe(false);
    expect(r.plan).toBe(plan);
    expect(readOverlays(root, { env }).map(o => o.ref)).toEqual([ref]);
    expect(held()).toBeNull();
    expect(parked(r)).toEqual([{ kind: 'established-overlay-parked', detail: expect.objectContaining({ ref, sha, need: 'needs-you' }) }]);
    expect(r.alerts.map(a => a.kind)).not.toContain('established-overlay-hold');
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked'))
      .toEqual([expect.objectContaining({ ref, sha })]);
  });
  it('does not repeat the alert or re-hold the same SHA on subsequent rebuilds', async () => {
    expect(parked(await tick())).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const r = await tick();
      expect(r.terminal).toBe(false);
      expect(parked(r)).toEqual([]);
      expect(held()).toBeNull();
    }
  });
  it('an unproven overlay holds beyond the threshold', async () => {
    auditedTip.tipInMain.mockReturnValue(false);
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(parked(r)).toEqual([]);
    expect(held()).not.toBeNull();
  });
  it('unreadable content evidence fails closed to the hold', async () => {
    auditedTip.tipInMain.mockImplementation(() => { throw new Error('unreadable evidence'); });
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(parked(r)).toEqual([]);
  });
  it('a pinned-conflict-skipped overlay holds beyond the threshold even with content proof', async () => {
    plan.establishedLost[0].reason = 'pinned-conflict-skipped';
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(parked(r)).toEqual([]);
    expect(auditedTip.tipInMain).not.toHaveBeenCalled();
  });
  it.each(['conflict', 'pinned-conflict-skipped'])('a mixed set holds when the second overlay is unproven or pinned (%s)', async (reason) => {
    const other = { ref: 'lane/other', sha: 'e'.repeat(40), reason };
    addOverlay(root, { ref: other.ref }, { env });
    plan.establishedLost.push(other);
    plan.decisions.push({ ...other, action: 'drop' });
    const state = readRebuildState(root, env);
    state.adopted.applied.push({ ref: other.ref, sha: other.sha });
    writeRebuildState(root, state, env);
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(parked(r)).toEqual([]);
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked')).toEqual([]);
  });
  it('parks a superseded tip only when its content reaches the candidate carrying another overlay', async () => {
    plan.finalSha = 'f'.repeat(40);
    plan.applied = [{ ref: 'lane/replacement', sha: 'e'.repeat(40) }];
    auditedTip.tipInMain.mockImplementation((_git, target, tip) => target === plan.finalSha && tip === sha);
    const r = await tick();
    expect(r.terminal).toBe(false);
    expect(parked(r)).toHaveLength(1);
  });
  it('a previous park notice does not bypass lost content proof on the next rebuild', async () => {
    expect(parked(await tick())).toHaveLength(1);
    auditedTip.tipInMain.mockReturnValue(false);
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(parked(r)).toEqual([]);
  });
  it('setting zero disables parking', async () => {
    env.WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES = '0';
    time += 24 * 3_600_000;
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held()).not.toBeNull();
  });
  it('a changed tip starts a fresh clock, then gets its own single alert', async () => {
    expect(parked(await tick())).toHaveLength(1);
    const next = 'd'.repeat(40);
    plan.establishedLost[0].sha = next;
    plan.decisions[0].sha = next;
    time += 60_000;
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
    time += 31 * 60_000;
    expect(parked(await tick())[0].detail.sha).toBe(next);
  });
  it.each([undefined, 'unreadable'])('missing or invalid hold time %s cannot authorize parking', async (since) => {
    const state = readRebuildState(root, env);
    state.held.since = since;
    writeRebuildState(root, state, env);
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
  });
  it('a changed tip during an existing hold restarts its clock', async () => {
    plan.establishedLost[0].sha = 'd'.repeat(40);
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
  });
  it('pinned-overlay refusals are unchanged even after the threshold', async () => {
    plan = { ok: false, reason: 'pinned-overlay-conflict', detail: { ref }, alerts: [] };
    const r = await tick();
    expect(r.result.reason).toBe('pinned-overlay-conflict');
    expect(parked(r)).toEqual([]);
  });
});
