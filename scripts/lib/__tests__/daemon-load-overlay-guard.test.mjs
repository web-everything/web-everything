/**
 * @file scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs
 * @description PR #5809 (Codex audit, 2026-10-21) — `daemon-load-overlay` registered a ref with NO conflict check, a
 *   side door around `daemon-overlay add`'s guard. It now runs add's own admission (stack-aware merge-tree preview
 *   under the add-guard lock, plus the operator-credential `--allow-conflict` rule) before registering. Real git repos.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDaemonLoadOverlay } from '../daemon-load-overlay.mjs';
import { addOverlay, readOverlays, removeOverlay } from '../daemon-overlays.mjs';
import { rebuildClone, dryRunRebuild, previewOverlayConflict } from '../daemon-rebuild.mjs';
import { stackAwareOverlayCheck } from '../../daemon-overlay.mjs';
import * as planner from '../daemon-rebuild/plan.mjs';
import * as strategies from '../daemon-rebuild/overlay-strategies.mjs';

const temps = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };

function fixture() {
  const base = mktemp('we-load-guard-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, 'shared.mjs', 'export const X = 0;\n');
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const push = (ref, files, from = 'origin/main') => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env, WE_DAEMON_OVERLAY_DIR: mktemp('we-load-guard-overlay-'), WE_DAEMON_OVERLAY_STACK_BASES: '{}',
  };
  push('lane/fix-procedure', { 'shared.mjs': 'export const X = 2;\n' });
  push('lane/promote-stale-green', { 'shared.mjs': 'export const X = 3;\n' });
  push('lane/unrelated', { 'other.mjs': 'ok\n' });
  gitOk(clone, ['fetch', '-q', 'origin']);
  addOverlay(clone, { ref: 'lane/fix-procedure', pr: 2821 }, { env });
  const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
  const load = (o) => runDaemonLoadOverlay({
    clone, pr: 2826, env, rebuild, versions: null, installed: () => ({ inHead: true, tip: 'x', head: 'y', reason: 'in-head' }),
    log: { error: () => {}, log: () => {} }, ...o,
  });
  return { clone, env, rebuild, load, push };
}

describe('daemon-load-overlay runs daemon-overlay add\'s conflict guard before registering', () => {
  it.each(['0', '1'])('admits a full-plan replay-resolved candidate only with edge resolution on: %s', async (edgeResolve) => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = edgeResolve;
    const first = f.push('lane/replay', { 'shared.mjs': 'export const X = 2;\n' });
    const tip = f.push('lane/replay', { 'shared.mjs': 'export const X = 3;\n' }, first);
    // Force the direct resolver to fall through so the real planner's resolver is the admission evidence.
    const resolver = vi.spyOn(strategies, 'resolveOverlayConflict');
    if (edgeResolve === '1') resolver.mockReturnValueOnce({ ok: false, files: ['shared.mjs'], tried: [] });
    const plan = vi.spyOn(planner, 'planRebuild');
    const result = await f.load({ ref: 'lane/replay', pr: null });
    expect(plan).toHaveBeenCalledTimes(2);
    const fullPlan = await plan.mock.results[1].value;
    if (edgeResolve === '1') {
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(fullPlan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/replay', sha: tip, resolvedVia: 'replay' }));
      expect(result.refused).toBeFalsy();
      expect(readOverlays(f.clone, { env: f.env }).find(o => o.ref === 'lane/replay').conflictOverride).toBeUndefined();
      expect(f.rebuild).toHaveBeenCalledOnce();
    } else {
      expect(resolver).not.toHaveBeenCalled();
      expect(result).toMatchObject({ refused: true, registered: false, reason: 'conflict' });
      expect(readOverlays(f.clone, { env: f.env }).some(o => o.ref === 'lane/replay')).toBe(false);
      expect(f.rebuild).not.toHaveBeenCalled();
    }
  });

  it.each(['0', '1'])('refuses admission that replaces an existing applied tip with an older pin; edge resolve=%s', async (edgeResolve) => {
    const f = fixture();
    Object.assign(f.env, {
      WE_DAEMON_STATE_DIR: mktemp('we-rollback-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rollback-lock-'),
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: edgeResolve,
      WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    });
    const a0 = f.push('lane/a', { 'a.txt': 'A\n' });
    addOverlay(f.clone, { ref: 'lane/a' }, { env: f.env });
    expect(await rebuildClone({
      root: f.clone, env: f.env, prState: async () => 'OPEN',
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [] } }),
    })).toMatchObject({ adopted: true });
    removeOverlay(f.clone, 'lane/fix-procedure', { env: f.env });
    const a1 = f.push('lane/a', { 'shared.mjs': 'export const X = 1;\n' }, a0);
    const existing = await dryRunRebuild({ root: f.clone, env: f.env, prState: async () => 'OPEN' });
    expect(existing.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/a', sha: a1 }));
    const candidate = await dryRunRebuild({
      root: f.clone, env: f.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/fix-procedure' }],
    });
    expect(candidate.plan).toMatchObject({ ok: true, establishedLost: [] });
    expect(candidate.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/a', sha: a0, pinnedFrom: a1 }));
    expect(candidate.plan.applied.find(o => o.ref === 'lane/fix-procedure').pinnedFrom).toBeUndefined();
    const registered = readOverlays(f.clone, { env: f.env });
    expect(await stackAwareOverlayCheck({
      root: f.clone, ref: 'lane/fix-procedure', existingOverlays: registered, env: f.env,
    })).toMatchObject({ ok: true, clean: false, files: ['shared.mjs'] });
    expect(await f.load({ ref: 'lane/fix-procedure', pr: null }))
      .toMatchObject({ registered: false, refused: true, reason: 'conflict' });
    expect(readOverlays(f.clone, { env: f.env })).toEqual(registered);
    expect(f.rebuild).not.toHaveBeenCalled();
  }, 60_000);

  it.each([false, true])('refuses a carried conflicting tip when the full plan drops an existing overlay; still registered=%s', async (stillRegistered) => {
    const f = fixture();
    Object.assign(f.env, {
      WE_DAEMON_STATE_DIR: mktemp('we-drop-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-drop-lock-'),
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0',
      WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    });
    removeOverlay(f.clone, 'lane/fix-procedure', { env: f.env });
    const a0 = f.push('lane/a', { 'a.txt': 'A\n', 'shared.mjs': 'export const X = 1;\n' });
    addOverlay(f.clone, { ref: 'lane/a' }, { env: f.env });
    expect(await rebuildClone({
      root: f.clone, env: f.env, prState: async () => 'OPEN',
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [] } }),
    })).toMatchObject({ adopted: true });
    if (!stillRegistered) removeOverlay(f.clone, 'lane/a', { env: f.env });
    addOverlay(f.clone, { ref: 'lane/fix-procedure' }, { env: f.env });
    const registered = readOverlays(f.clone, { env: f.env });
    const live = await dryRunRebuild({
      root: f.clone, env: f.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/a' }],
    });
    expect(live.plan).toMatchObject({ ok: true, establishedLost: [] });
    expect(live.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/a', sha: a0 }));
    expect(live.plan.decisions).toContainEqual(expect.objectContaining({ ref: 'lane/fix-procedure', action: 'drop', reason: 'conflict' }));

    // The CLI passes the whole registry; load-overlay already filters the candidate out.
    const check = await stackAwareOverlayCheck({
      root: f.clone, ref: 'lane/a', existingOverlays: registered, env: f.env,
    });
    expect(check).toMatchObject({ ok: true, clean: false, files: ['shared.mjs'] });
    const result = await f.load({ ref: 'lane/a', pr: null });
    expect(result).toMatchObject({ registered: false, refused: true, reason: 'conflict' });
    expect(result.conflictCheck).toMatchObject({ ok: true, clean: false, files: ['shared.mjs'] });
    expect(readOverlays(f.clone, { env: f.env })).toEqual(registered);
    expect(f.rebuild).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    { name: 'planner is not ok', ok: false, establishedLost: [] },
    { name: 'establishedLost is non-empty', ok: true, establishedLost: [{ ref: 'lane/fix-procedure', reason: 'conflict' }] },
    { name: 'an existing applied overlay is missing', ok: true, establishedLost: [], omitExisting: true },
    { name: 'an existing applied tip is replaced with an older pin', ok: true, establishedLost: [], pinExisting: true },
    { name: 'retained ancestry is unreadable', ok: true, establishedLost: [], retainedSha: 'f'.repeat(40) },
    { name: 'a retained SHA is missing', ok: true, establishedLost: [], retainedSha: '' },
  ])('refuses full-plan admission when $name even with the candidate applied unpinned', async ({ ok, establishedLost, omitExisting, pinExisting, retainedSha }) => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
    const ref = 'lane/promote-stale-green';
    const sha = gitOk(f.clone, ['rev-parse', `origin/${ref}`]).trim();
    const registered = readOverlays(f.clone, { env: f.env });
    const realPlan = planner.planRebuild;
    let fullPlanCalls = 0;
    // Keep the actual step-3 merge conflict and registration path. At the full-plan boundary, isolate
    // each refusal conjunct: the candidate IS applied at its current tip, and only this condition fails.
    const plan = vi.spyOn(planner, 'planRebuild').mockImplementation(async (options) => {
      if (!options.overlays.some(o => o.ref === ref)) return realPlan(options);
      fullPlanCalls++;
      expect(options.overlays.map(o => o.ref)).toEqual(['lane/fix-procedure', ref]);
      const existingSha = gitOk(f.clone, ['rev-parse', 'origin/lane/fix-procedure']).trim();
      const existing = pinExisting
        ? { ref: 'lane/fix-procedure', sha: gitOk(f.clone, ['rev-parse', 'origin/main']).trim(), pinnedFrom: existingSha }
        : { ref: 'lane/fix-procedure', sha: retainedSha ?? existingSha };
      return {
        ok, reason: ok ? undefined : 'pinned-overlay-conflict',
        applied: [...(omitExisting ? [] : [existing]), { ref, sha }], establishedLost,
      };
    });

    const result = await f.load({ ref, pr: null });
    expect(fullPlanCalls).toBe(1); // proves this reached the full-plan admission gate
    expect(plan).toHaveBeenCalledTimes(2); // existing stack, then candidate-inclusive plan
    expect(result).toMatchObject({ registered: false, refused: true, reason: 'conflict' });
    expect(result.conflictCheck).toMatchObject({ ok: true, clean: false, files: ['shared.mjs'] });
    expect(readOverlays(f.clone, { env: f.env })).toEqual(registered);
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it('refuses re-registering a carried ref whose conflicting tip is only applied as a pin without an operator override', async () => {
    const f = fixture();
    Object.assign(f.env, {
      WE_DAEMON_STATE_DIR: mktemp('we-reregister-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-reregister-lock-'),
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0',
      WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    });
    const a0 = f.push('lane/a', { 'a.txt': 'A\n' });
    addOverlay(f.clone, { ref: 'lane/a' }, { env: f.env });
    expect(await rebuildClone({
      root: f.clone, env: f.env, prState: async () => 'OPEN',
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [{ name: 'fixture', ok: true }] } }),
    })).toMatchObject({ adopted: true });
    removeOverlay(f.clone, 'lane/a', { env: f.env });
    const a1 = f.push('lane/a', { 'shared.mjs': 'export const X = 1;\n' }, a0);
    const live = await dryRunRebuild({
      root: f.clone, env: f.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/a' }],
    });
    expect(live.plan).toMatchObject({ ok: true, establishedLost: [] });
    expect(live.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/a', sha: a0, pinnedFrom: a1 }));

    const check = await stackAwareOverlayCheck({
      root: f.clone, ref: 'lane/a', existingOverlays: readOverlays(f.clone, { env: f.env }), env: f.env,
    });
    expect(check).toMatchObject({ ok: true, clean: false, files: ['shared.mjs'] });
    const refused = await f.load({ ref: 'lane/a', pr: null });
    expect(refused).toMatchObject({ registered: false, refused: true, reason: 'conflict' });
    expect(readOverlays(f.clone, { env: f.env }).some(o => o.ref === 'lane/a')).toBe(false);
    expect(f.rebuild).not.toHaveBeenCalled();

    const allowed = await f.load({
      ref: 'lane/a', pr: null, allowConflict: true,
      operatorInstruction: 're-register the carried overlay', readViewer: async () => 'chalbert',
    });
    expect(allowed.refused).toBeFalsy();
    expect(readOverlays(f.clone, { env: f.env }).find(o => o.ref === 'lane/a').conflictOverride).toMatchObject({
      instruction: 're-register the carried overlay', actor: 'chalbert', files: ['shared.mjs'],
    });
    expect(f.rebuild).toHaveBeenCalledOnce();
  }, 60_000);

  it('admits M0/A0/M1/A1/R repair through the full plan with edge resolution off and no override', async () => {
    const f = fixture();
    Object.assign(f.env, {
      WE_DAEMON_STATE_DIR: mktemp('we-repair-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-repair-lock-'),
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0',
      WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    });
    removeOverlay(f.clone, 'lane/fix-procedure', { env: f.env });
    const m0 = f.push('main', { 'shared.mjs': 'base\n', 'a.txt': 'base\n' });
    const a0 = f.push('lane/a', { 'a.txt': 'old-A\n' }, m0);
    addOverlay(f.clone, { ref: 'lane/a' }, { env: f.env });
    const rebuild = () => rebuildClone({
      root: f.clone, env: f.env, prState: async () => 'OPEN',
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [{ name: 'fixture', ok: true }] } }),
    });
    expect(await rebuild()).toMatchObject({ adopted: true });
    const m1 = f.push('main', { 'shared.mjs': 'main\n' }, m0);
    const a1 = f.push('lane/a', { 'shared.mjs': 'new-A\n', 'a.txt': 'new-A\n' }, a0);
    const repair = f.push('lane/repair', { 'shared.mjs': 'base\n', 'a.txt': 'new-A\n', 'repair.txt': 'R\n' }, m1);
    const live = await dryRunRebuild({
      root: f.clone, env: f.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/repair' }],
    });
    expect(live.plan).toMatchObject({ ok: true, establishedLost: [] });
    for (const [ref, sha] of [['lane/a', a1], ['lane/repair', repair]]) {
      expect(live.plan.applied).toContainEqual(expect.objectContaining({ ref, sha }));
    }
    const result = await f.load({ ref: 'lane/repair', pr: null, rebuild });
    expect(result.refused, JSON.stringify(result)).toBeFalsy();
    expect(readOverlays(f.clone, { env: f.env }).find(o => o.ref === 'lane/repair')).toBeDefined();
    for (const sha of [a1, repair]) {
      expect(gitOk(f.clone, ['merge-base', '--is-ancestor', sha, 'HEAD'])).toBe('');
    }
  }, 60_000);

  it('fails closed when the adopted HEAD cannot be read', async () => {
    const run = vi.fn(() => ({ status: 1, stdout: '', stderr: 'HEAD unavailable' }));
    expect(await previewOverlayConflict({
      root: '/unused', ref: 'lane/c', existingOverlays: [], originUrl: '/unused-origin', run,
    })).toEqual({ ok: false, reason: 'head-unresolved' });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([true, false])('checks the live adopted stack when A moves and B stays established: compatible=%s', async (compatible) => {
    const f = fixture();
    Object.assign(f.env, {
      WE_DAEMON_STATE_DIR: mktemp('we-load-guard-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-load-guard-lock-'),
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0',
      WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    });
    removeOverlay(f.clone, 'lane/fix-procedure', { env: f.env });
    const a0 = f.push('lane/a', { 'a.txt': 'A\n' });
    f.push('lane/b', { 'shared.mjs': 'export const X = 2;\n' });
    for (const ref of ['lane/a', 'lane/b']) addOverlay(f.clone, { ref }, { env: f.env });
    const adopted = await rebuildClone({
      root: f.clone, env: f.env, prState: async () => 'OPEN',
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [{ name: 'fixture', ok: true }] } }),
    });
    expect(adopted.adopted).toBe(true);
    const a1 = f.push('lane/a', { 'shared.mjs': 'export const X = 1;\n' }, a0);
    f.push('lane/c', { 'shared.mjs': `export const X = ${compatible ? 2 : 3};\n`, 'c.txt': 'C\n' });
    const live = await dryRunRebuild({
      root: f.clone, env: f.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/c' }],
    });
    expect(live.plan.establishedLost).toEqual([]);
    expect(live.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/a', sha: a0, pinnedFrom: a1 }));
    expect(live.plan.applied.some(o => o.ref === 'lane/c')).toBe(compatible);

    const check = await stackAwareOverlayCheck({
      root: f.clone, ref: 'lane/c', existingOverlays: readOverlays(f.clone, { env: f.env }), env: f.env,
    });
    expect(check).toMatchObject({ ok: true, clean: compatible });
    const result = await f.load({ ref: 'lane/c', pr: null });
    if (compatible) {
      expect(result.refused).toBeFalsy();
      expect(f.rebuild).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ registered: false, refused: true, reason: 'conflict' });
      expect(result.conflictCheck.files).toEqual(['shared.mjs']);
      expect(f.rebuild).not.toHaveBeenCalled();
    }
    expect(readOverlays(f.clone, { env: f.env }).some(o => o.ref === 'lane/c')).toBe(compatible);
  }, 60_000);

  it('an UNREGISTERED ref that conflicts with a registered overlay is refused: nothing registered, no rebuild', async () => {
    const f = fixture();
    const r = await f.load({ ref: 'lane/promote-stale-green' });
    expect(r).toMatchObject({ registered: false, refused: true, reason: 'conflict' });
    expect(r.conflictCheck.files).toEqual(['shared.mjs']);
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/fix-procedure']);
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it('a typed --actor=operator does not get it in: without the operator credential it is refused', async () => {
    const f = fixture();
    const r = await f.load({
      ref: 'lane/promote-stale-green', allowConflict: true, operatorInstruction: 'yes load it anyway', actor: 'operator',
      readViewer: async () => 'web-everything-bot[bot]',
    });
    expect(r).toMatchObject({ registered: false, refused: true });
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/fix-procedure']);
  });

  it('the operator-credential --allow-conflict registers the confirmed conflict and records the quote + files', async () => {
    const f = fixture();
    const r = await f.load({
      ref: 'lane/promote-stale-green', allowConflict: true, operatorInstruction: 'yes load it anyway', readViewer: async () => 'chalbert',
    });
    expect(r.refused).toBeFalsy();
    const entry = readOverlays(f.clone, { env: f.env }).find((o) => o.ref === 'lane/promote-stale-green');
    expect(entry.conflictOverride).toMatchObject({ instruction: 'yes load it anyway', actor: 'chalbert', files: ['shared.mjs'] });
    expect(f.rebuild).toHaveBeenCalled();
  });

  it('a clean ref registers and rebuilds as before', async () => {
    const f = fixture();
    const r = await f.load({ ref: 'lane/unrelated' });
    expect(r.refused).toBeFalsy();
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/fix-procedure', 'lane/unrelated']);
    expect(f.rebuild).toHaveBeenCalled();
  });

  it.each([1000, 1001])('operator-instruction length %s enforces the 1000-character cap before load registration', async (length) => {
    const f = fixture();
    const instruction = `yes load ${'x'.repeat(length - 9)}`;
    expect(instruction).toHaveLength(length);
    const r = await f.load({
      ref: 'lane/promote-stale-green', allowConflict: true, operatorInstruction: instruction,
      readViewer: async () => 'chalbert',
    });
    const entry = readOverlays(f.clone, { env: f.env }).find((o) => o.ref === 'lane/promote-stale-green');
    if (length === 1000) {
      expect(r.refused).toBeFalsy();
      expect(entry.conflictOverride.instruction).toBe(instruction);
      expect(f.rebuild).toHaveBeenCalledOnce();
    } else {
      expect(r).toMatchObject({ registered: false, refused: true });
      expect(entry).toBeUndefined();
      expect(f.rebuild).not.toHaveBeenCalled();
    }
  });

  it.each(['yes load', 'yes load anyway'])('operator-instruction word boundary before load registration: %s', async (instruction) => {
    const f = fixture();
    const r = await f.load({
      ref: 'lane/promote-stale-green', allowConflict: true, operatorInstruction: instruction,
      readViewer: async () => 'chalbert',
    });
    const entry = readOverlays(f.clone, { env: f.env }).find(o => o.ref === 'lane/promote-stale-green');
    if (instruction === 'yes load') {
      expect(r).toMatchObject({ registered: false, refused: true });
      expect(entry).toBeUndefined();
      expect(f.rebuild).not.toHaveBeenCalled();
    } else {
      expect(r.refused).toBeFalsy();
      expect(entry.conflictOverride).toMatchObject({ instruction, actor: 'chalbert' });
      expect(f.rebuild).toHaveBeenCalledOnce();
    }
  });

  it('a check that cannot run (ref missing on origin) refuses — fail closed', async () => {
    const f = fixture();
    const r = await f.load({ ref: 'lane/does-not-exist' });
    expect(r).toMatchObject({ registered: false, refused: true, reason: 'conflict-check-failed' });
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/fix-procedure']);
  });
});
