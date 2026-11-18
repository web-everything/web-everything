import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectOverlayStale, readOverlayStale, readOpenPrHeads, overlayStaleSettings } from '../overlay-prune.mjs';
import { overlayFilePath, addOverlay } from '../../daemon-overlays.mjs';
import { prepareRebuild, readOverlayEventLog } from '../prepare.mjs';
import * as planner from '../plan.mjs';
import * as detector from '../overlay-prune.mjs';
import { readRebuildState } from '../state.mjs';
import * as localState from '../local-state.mjs';
import * as repair from '../../lane-repair.mjs';
import * as fetcher from '../edge-fetch.mjs';

const sha = c => c.repeat(40), tip = sha('a'), mainSha = sha('b'), tree = sha('c');
const ref = 'lane/stale';
let root, env, overlay, emit, git;
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR, 'overlay-stale-'));
  env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_DAEMON_STATE_DIR: join(root, 'state'), WE_NEEDS_YOU_FEED: join(root, 'attention.jsonl'),
    WE_DAEMON_AUTO_REBASE: '0' };
  overlay = { ref, pr: 0, addedAt: '2026-11-17' };
  emit = vi.fn();
  git = vi.fn(args => {
    if (args[0] === 'merge-base') return { status: args[1] === '--is-ancestor' ? 1 : 0, stdout: mainSha };
    if (args[0] === 'diff') return { status: 0, stdout: '' };
    if (args[0] === 'merge-tree') return { status: 1, stdout: tree + '\nCONFLICT' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: tip };
    throw new Error('unexpected probe');
  });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function tick(extra = {}) {
  return detectOverlayStale({ root, env, git, overlays: [overlay], plan: { applied: [], decisions: [] },
    mainSha, openPrHeads: [], remoteTips: { [ref]: tip }, settings: { enabled: true, threshold: 2 }, emit, ...extra });
}

describe('post-plan stale detector', () => {
  it('emits one conflict notice only after count exceeds two, across persisted ticks', () => {
    expect(tick()[0].count).toBe(1);
    expect(tick()[0].count).toBe(2);
    expect(emit).not.toHaveBeenCalled();
    expect(tick()[0].count).toBe(3);
    tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ ref, tip, registration: expect.any(String), count: 3, reason: 'conflict', ownerAction: `rebase ${ref} onto main` });
  });
  it('a transient unknown does not suppress the later conflict alert', () => {
    tick({ remoteTips: {} });
    const before = emit.mock.calls.length;
    tick(); tick(); tick();
    expect(emit.mock.calls.slice(before).some(([row]) => row.reason === 'conflict')).toBe(true);
  });
  it('a fork PR with the same branch name does not exclude the origin overlay', () => {
    const heads = [{ headRefName: ref, headRefOid: sha('e'), isCrossRepository: true }];
    expect(tick({ openPrHeads: heads })[0].count).toBe(1);
    expect(tick({ openPrHeads: [{ ...heads[0], isCrossRepository: false }] })).toHaveLength(0);
  });
  it('a retried notice is dropped when the overlay became pinned or its tip moved', () => {
    emit.mockImplementationOnce(() => { throw new Error('feed down'); });
    tick(); tick(); tick();
    expect(emit).toHaveBeenCalledTimes(1);
    tick({ openPrHeads: [{ headRefName: ref, headRefOid: sha('e'), isCrossRepository: false }] });
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('re-registration at the same tip changes the attention identity', () => {
    const rows = [];
    tick({ emit: r => rows.push(r) }); tick({ emit: r => rows.push(r) }); tick({ emit: r => rows.push(r) });
    overlay = { ...overlay, addedAt: 'later' };
    tick({ emit: r => rows.push(r) }); tick({ emit: r => rows.push(r) }); tick({ emit: r => rows.push(r) });
    expect(rows).toHaveLength(2);
    expect(rows[0].registration).not.toBe(rows[1].registration);
  });
  it('a retried notice is dropped once its registration is removed or the overlay is clean', () => {
    emit.mockImplementationOnce(() => { throw new Error('feed down'); });
    tick(); tick(); tick();
    const other = { ref: 'lane/other', pr: 0, addedAt: 'x' };
    tick({ overlays: [other] });
    expect(emit.mock.calls.filter(([r]) => r.ref === ref)).toHaveLength(1);
    emit.mockClear();
    git.mockImplementation(args => args[0] === 'merge-tree' ? { status: 0, stdout: tree } : args[0] === 'rev-parse' ? { status: 0, stdout: tip } : { status: args[1] === '--is-ancestor' ? 1 : 0, stdout: mainSha });
    tick({ overlays: [overlay, other] });
    expect(emit.mock.calls.filter(([r]) => r.ref === ref)).toHaveLength(0);
  });
  it('a cancelled undelivered notice can fire again when the same conflict returns', () => {
    emit.mockImplementationOnce(() => { throw new Error('feed down'); });
    tick(); tick(); tick();
    tick({ openPrHeads: [{ headRefName: ref, headRefOid: sha('e'), isCrossRepository: false }] });
    tick(); tick(); tick();
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it('a branch named __proto__ still counts conflicts across ticks', () => {
    overlay = { ref: '__proto__', pr: 0, addedAt: 'x' };
    const t = () => tick({ remoteTips: { ['__proto__']: tip } });
    expect(t()[0].count).toBe(1);
    expect(t()[0].count).toBe(2);
  });
  it('a failed publish is retried next tick and then marked delivered', () => {
    emit.mockImplementationOnce(() => { throw new Error('feed down'); });
    tick(); tick(); tick();
    expect(emit).toHaveBeenCalledTimes(1);
    tick();
    expect(emit).toHaveBeenCalledTimes(2);
    tick();
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it('resets a moved tip and re-registration; returning to an alerted tuple does not alert twice', () => {
    tick(); tick(); tick();
    const moved = { remoteTips: { [ref]: sha('d') } };
    expect(tick(moved)[0].count).toBe(1);
    expect(tick()[0].count).toBe(1);
    tick(); tick();
    expect(emit).toHaveBeenCalledTimes(1);
    overlay = { ...overlay, addedAt: 'later' };
    expect(tick()[0].count).toBe(1);
    tick(); tick();
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it('ignores stack-base cache changes in registration identity', () => {
    tick(); overlay.stackBases = ['lane/base'];
    expect(tick()[0].count).toBe(2);
  });
  it('resets consecutive conflicts after a clean or unknown probe', () => {
    tick(); tick();
    git.mockImplementationOnce(() => ({ status: 2 }));
    expect(tick()[0]).toMatchObject({ reason: 'unknown', count: 0 });
    expect(tick()[0].count).toBe(1);
    const cleanGit = args => args[0] === 'merge-tree' ? { status: 0, stdout: tree } : git(args);
    expect(tick({ git: cleanGit })[0]).toMatchObject({ reason: 'clean', count: 0 });
    expect(tick()[0].count).toBe(1);
  });
  it.each([
    ['PR registration', { pr: 42 }, {}],
    ['explicit pin', { pinned: true }, {}],
    ['edge resolution', { edgeResolution: { sha: tip } }, {}],
    ['open PR for branch', {}, { openPrHeads: [{ headRefName: ref, headRefOid: tip }] }],
    ['held application', {}, { plan: { applied: [{ ref, sha: mainSha, pinnedFrom: tip }] } }],
    ['pin decision', {}, { plan: { decisions: [{ ref, reason: 'pinned-overlay-conflict-skipped' }] } }],
  ])('never alerts for %s', (_name, entry, extra) => {
    overlay = { ...overlay, ...entry };
    for (let i = 0; i < 4; i++) expect(tick(extra)).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
  it('never alerts on a mechanism pin', () => {
    const pinnedGit = args => args[0] === 'diff' ? { status: 0, stdout: 'scripts/lib/daemon-overlays.mjs' } : git(args);
    for (let i = 0; i < 4; i++) expect(tick({ git: pinnedGit })).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
  it.each([
    ['GitHub failed', { openPrHeads: null }],
    ['tip unknown', { remoteTips: {} }],
    ['main unknown', { mainSha: null }],
    ['ancestry unknown', { plan: { applied: [{ ref: 'lane/carrier', sha: sha('d') }] },
      overlays: [{ ref }, { ref: 'lane/carrier', pr: 1 }],
      git: args => args[0] === 'merge-base' && args[1] === '--is-ancestor' ? { status: 128 } : git(args) }],
    ['merge unknown', { git: args => args[0] === 'merge-tree' ? { status: 128 } : git(args) }],
    ['unreadable merge output', { git: args => args[0] === 'merge-tree' ? { status: 1, stdout: 'fatal' } : git(args) }],
  ])('keeps and alerts once when %s', (_name, extra) => {
    expect(tick(extra)[0]).toMatchObject({ reason: 'unknown', count: 0 });
    tick(extra);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].ownerAction).toBe(`rebase ${ref} onto main`);
  });
  it('F3 uses applied T1, never fetched pinnedFrom T2, as the carrier proof', () => {
    const carrier = 'lane/carrier', T1 = sha('d'), T2 = sha('e');
    const probe = args => args[1] === '--is-ancestor'
      ? { status: args.at(-1) === T2 ? 0 : 1 } : git(args);
    const extra = { overlays: [overlay, { ref: carrier, pr: 42 }], git: probe,
      plan: { applied: [{ ref: carrier, sha: T1, pinnedFrom: T2 }] },
      openPrHeads: [{ headRefName: carrier, headRefOid: T2 }], remoteTips: { [ref]: tip, [carrier]: T2 } };
    expect(tick(extra)[0].reason).toBe('conflict');
    expect(emit).not.toHaveBeenCalled();
    extra.plan.applied[0].sha = T2;
    expect(tick(extra)[0].reason).toBe('superseded');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded', ownerAction: `daemon-overlay.mjs remove ${ref}` }));
  });
  it('accepts open PR heads as superseded carriers', () => {
    const probe = args => args[1] === '--is-ancestor' ? { status: 0 } : git(args);
    expect(tick({ git: probe, openPrHeads: [{ headRefName: 'lane/other', headRefOid: sha('d') }] })[0].reason).toBe('superseded');
  });
  it('bounds the PR read and treats failures, malformed and limit-sized listings as unknown', () => {
    const row = { headRefName: ref, headRefOid: tip };
    const query = vi.fn(() => JSON.stringify([row]));
    expect(readOpenPrHeads(root, env, query)).toEqual([row]);
    expect(query.mock.calls[0][1]).toMatchObject({ timeout: 20000, maxBuffer: 2097152 });
    for (const value of ['{}', 'bad', JSON.stringify([{}]), JSON.stringify(Array(1000).fill(row))]) {
      expect(readOpenPrHeads(root, env, () => value)).toBeNull();
    }
    expect(readOpenPrHeads(root, env, () => { throw new Error('gh failed'); })).toBeNull();
  });
  it('resolves enabled and threshold from the tool settings and honors WE_OVERLAY_STALE=0', () => {
    expect(overlayStaleSettings({ WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent') })).toEqual({ enabled: true, threshold: 2 });
    expect(tick({ settings: overlayStaleSettings({ WE_OVERLAY_STALE: '0' }) })).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
  it('writes the conflict event and needs-you attention once without changing registrations', () => {
    addOverlay(root, { ref }, { env });
    const before = readFileSync(overlayFilePath(root, env), 'utf8');
    tick({ emit: undefined }); tick({ emit: undefined }); tick({ emit: undefined }); tick({ emit: undefined });
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'overlay-stale-conflict')).toEqual([
      expect.objectContaining({ ref, tip, count: 3, ownerAction: `rebase ${ref} onto main` }),
    ]);
    expect(readFileSync(env.WE_NEEDS_YOU_FEED, 'utf8')).toContain('overlay-stale-conflict');
    expect(readFileSync(overlayFilePath(root, env), 'utf8')).toBe(before);
  });
  it('stale CLI reads persisted output without bumping counters or writing cleanup state', () => {
    tick();
    const file = `${overlayFilePath(root, env)}.stale-state`, before = readFileSync(file, 'utf8');
    expect(readOverlayStale(root, env)[0].count).toBe(1);
    const result = spawnSync(process.execPath, ['scripts/daemon-overlay.mjs', 'stale', `--clone=${root}`, '--json'],
      { env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(readOverlayStale(root, env));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('STATIC detector contains no registration mutation APIs or overlay-file write', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/overlay-prune.mjs'), 'utf8');
    expect(source).not.toMatch(/removeOverlay|addPending|removeRegistration/);
    expect(source).not.toMatch(/writeFileSync\(\s*(?:overlayFilePath|overlayFile)/);
    expect(source).toContain('writeFileSync(tmp,');
  });
});

function stubPrepare() {
  vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
  vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
  vi.spyOn(fetcher, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
}
const headSha = sha('1'), newSha = sha('2');
const gitRun = args => ({ status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : args[0] === 'rev-parse' ? headSha : '' });
function writePending(mode) {
  const file = `${overlayFilePath(root, env)}.drop-pending`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, mode === 'pending' ? JSON.stringify({ pending: [{ ref }] }) : 'bad');
}

it.each(['pending', 'unreadable'])('F1 %s drop intent refuses a build that changes applied overlays, after planning', async mode => {
  stubPrepare(); writePending(mode);
  const plan = vi.spyOn(planner, 'planRebuild').mockResolvedValue({ ok: true, finalSha: newSha, mainSha, applied: [{ ref, sha: tip }], decisions: [], alerts: [] });
  const result = await prepareRebuild({ root, env, run: gitRun, now: () => 0, prBaseChain: () => [] });
  expect(result).toMatchObject({ terminal: true, result: { moved: false, reason: 'drop-pending-unsettled' } });
  expect(plan).toHaveBeenCalledTimes(1);
});

it('a pending drop intent also refuses an unchanged-HEAD plan that would remove a registration', async () => {
  stubPrepare(); writePending('pending');
  vi.spyOn(planner, 'planRebuild').mockResolvedValue({ ok: true, finalSha: headSha, mainSha, applied: [], decisions: [{ ref, action: 'remove', reason: 'pr-closed' }], alerts: [] });
  const result = await prepareRebuild({ root, env, run: gitRun, now: () => 0, prBaseChain: () => [] });
  expect(result.result.reason).toBe('drop-pending-unsettled');
});

it('a pending drop intent still lets unverified-build recovery run (it never drops registrations)', async () => {
  stubPrepare(); writePending('pending');
  const { writeRebuildState } = await import('../state.mjs');
  writeRebuildState(root, { unverified: { head: headSha, prevHead: headSha } }, env);
  vi.spyOn(planner, 'planRebuild').mockResolvedValue({ ok: false, reason: 'test-plan', applied: [], decisions: [], alerts: [] });
  const result = await prepareRebuild({ root, env, run: gitRun, now: () => 0, prBaseChain: () => [] });
  expect(result.result.reason).toBe('test-plan');
  expect(readRebuildState(root, env).unverified ?? null).toBeNull();
});

it('prepare runs detection after planning and contains detector failures', async () => {
  vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
  vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
  vi.spyOn(fetcher, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
  const plan = { ok: false, reason: 'test-plan', applied: [], decisions: [], alerts: [] };
  const planning = vi.spyOn(planner, 'planRebuild').mockResolvedValue(plan);
  const detect = vi.spyOn(detector, 'detectOverlayStale').mockImplementation(() => {
    expect(planning).toHaveBeenCalledOnce();
    throw new Error('sidecar unavailable');
  });
  const run = args => ({ status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : args[0] === 'rev-parse' ? mainSha : '' });
  const result = await prepareRebuild({ root, env, run, now: () => 0, prBaseChain: () => [] });
  expect(detect).toHaveBeenCalledTimes(1);
  expect(detect).toHaveBeenCalledWith(expect.objectContaining({ plan, mainSha }));
  expect(result.result.reason).toBe('test-plan');
  expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-stale-unknown' }));
});

it('observes real merge-tree conflicts and publishes one event on the third tick', () => {
  const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  const must = args => { const r = run(args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  must(['init', '-b', 'main']); must(['config', 'user.name', 'Test']); must(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(root, 'file'), 'base\n'); must(['add', 'file']); must(['commit', '-m', 'base']);
  must(['checkout', '-b', ref]); writeFileSync(join(root, 'file'), 'overlay\n'); must(['commit', '-am', 'overlay']);
  const overlayTip = must(['rev-parse', 'HEAD']);
  must(['checkout', 'main']); writeFileSync(join(root, 'file'), 'main\n'); must(['commit', '-am', 'main']);
  const main = must(['rev-parse', 'HEAD']); must(['update-ref', `refs/remotes/origin/${ref}`, overlayTip]);
  for (let i = 0; i < 4; i++) tick({ git: run, mainSha: main, remoteTips: undefined });
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ref, tip: overlayTip, reason: 'conflict', count: 3 }));
});
