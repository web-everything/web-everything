import { it, expect, vi } from 'vitest';
import * as planner from '../plan.mjs';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { finalizeRebuild } from '../adopt.mjs';
import { prepareRebuild } from '../prepare.mjs';
import { gitRun } from '../../main-staleness.mjs';
import { clearOverlayConflictWake, readOverlayConflictWakes } from '../../overlay-conflict-wake.mjs';
import { readMainSyncConflicts } from '../overlay-main-sync.mjs';
import { overlayFilePath, readOverlayState } from '../../daemon-overlays.mjs';
import { readRebuildStateStrict, rebuildStatePath, readReadyCandidate, readReadyCandidateStrict, writeReadyCandidate } from '../state.mjs';
import { SMOKE_CHECKS } from '../../daemon-live-smoke.mjs';
import { createSetAsideFixture, probeRebuildSetAside } from '../../../conveyor/soak/fixtures/rebuild-set-aside-probe.mjs';

// Negative cases come first: the new policy must retain the old refusal/hold protections.
it.each(['ordinary', 'strict'])('key/ref mismatch is malformed continuity: %s reader', async reader => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const before = f.head();
    const state = f.state();
    state.setAside = { 'lane/wrong-key': {
      eligible: true, ref: f.ref, sha: f.tip, mainSha: f.main,
      reason: 'main-sync-conflict', files: [f.file],
    } };
    writeFileSync(rebuildStatePath(f.root, f.env), JSON.stringify(state));
    if (reader === 'strict') {
      expect(() => readRebuildStateStrict(f.root, f.env)).toThrow('Invalid rebuild state setAside');
    } else {
      expect(f.state().setAside).toBeUndefined();
      expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
      expect(f.head()).toBe(before);
      expect(f.alerts().some(a => a.kind === 'overlay-main-sync-set-aside')).toBe(false);
      // With the overlay absent from main, unknown history must still require its audit.
      expect(f.git(['reset', '--hard', f.main]).status).toBe(0);
      await f.repair();
      await f.rebuild();
      expect(f.head()).toBe(f.main);
      expect(f.state().adopted?.applied.some(o => o.ref === f.ref)).not.toBe(true);
      expect(f.state().setAside).toBeUndefined();
      expect(f.alerts().some(a => a.kind === 'overlay-unaudited-tip')).toBe(true);
    }
  } finally { f.cleanup(); }
}, 60_000);

it.each(['array', 'string', 'record'])('malformed continuity is unknown and holds last-good: %s', async kind => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const before = f.head();
    const path = rebuildStatePath(f.root, f.env);
    const state = f.state();
    state.setAside = kind === 'array' ? [] : kind === 'string' ? 'bad' : { [f.ref]: { eligible: true } };
    writeFileSync(path, JSON.stringify(state));
    expect(f.state().setAside).toBeUndefined();
    expect(() => readRebuildStateStrict(f.root, f.env)).toThrow('Invalid rebuild state setAside');
    expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.head()).toBe(before);
    expect(f.alerts().some(a => a.kind === 'overlay-main-sync-set-aside')).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

it.each(['array', 'string', 'record'])('malformed continuity never restores first-adoption exemption: %s', async kind => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    expect(await f.rebuild()).toMatchObject({ adopted: true });
    const before = f.head();
    const state = f.state();
    state.setAside = kind === 'array' ? [] : kind === 'string' ? 'bad'
      : { [f.ref]: { ...state.setAside[f.ref], files: [] } };
    writeFileSync(rebuildStatePath(f.root, f.env), JSON.stringify(state));
    expect(f.state().setAside).toBeUndefined();
    await f.repair();
    await f.rebuild();
    expect(f.head()).toBe(before);
    expect(f.state().adopted?.applied.some(o => o.ref === f.ref)).not.toBe(true);
    expect(f.state().setAside).toBeUndefined();
    expect(f.alerts().some(a => a.kind === 'overlay-unaudited-tip')).toBe(true);
  } finally { f.cleanup(); }
}, 60_000);

it.each(['legacy', 'missing'])('unknown continuity holds an established running tip with one existing loss alert per tick: %s', async kind => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const before = f.head();
    const path = rebuildStatePath(f.root, f.env);
    const state = f.state();
    delete state.setAside;
    writeFileSync(path, JSON.stringify(state));
    if (kind === 'missing') unlinkSync(path);
    for (const tick of [1, 2]) {
      const alertsBefore = f.alerts().length;
      expect(await f.rebuild(), `tick ${tick}`).toMatchObject({ reason: 'established-overlay-conflict' });
      expect(f.head()).toBe(before);
      expect(f.state().setAside).toBeUndefined();
      expect(f.alerts().slice(alertsBefore).filter(a => a.detail?.ref === f.ref
        && ['established-overlay-dropped', 'overlay-main-sync-set-aside', 'overlay-unaudited-tip'].includes(a.kind))
        .map(a => a.kind)).toEqual(['established-overlay-dropped']);
    }
  } finally { f.cleanup(); }
}, 60_000);

it.each(['inference', 'log'])('unreadable running ancestry retains the established hold: %s', async kind => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head();
    const base = f.git(['rev-parse', `${f.tip}^`]).stdout.trim();
    const tree = f.git(['rev-parse', `${f.tip}^{tree}`]).stdout.trim();
    const replacement = f.git(['-c', 'user.name=t', '-c', 'user.email=t@t',
      'commit-tree', tree, '-p', base, '-m', 'replacement']).stdout.trim();
    expect(f.git(['update-ref', `refs/remotes/origin/${f.ref}`, replacement]).status).toBe(0);
    let failedRead = false;
    const git = args => {
      if (args[0] === 'log' && args.includes('--first-parent')) {
        if (kind === 'log') failedRead = true;
        return { status: kind === 'log' ? 128 : 0, stdout: '' };
      }
      if (kind === 'inference' && args[0] === 'merge-base' && args[1] === '--all'
        && args[2] === before && args[3] === replacement) {
        failedRead = true;
        return { status: 128, stdout: '' };
      }
      return f.git(args);
    };
    const plan = await planner.planRebuild({ git, headSha: before, mainRef: 'origin/main',
      overlays: f.overlays(), edgeResolve: false, setAside: {},
      mainSyncConflicts: { conflictMain: { [f.ref]: f.main }, conflictTip: { [f.ref]: replacement } } });
    expect(failedRead).toBe(true);
    expect(plan.establishedLost.map(o => o.ref)).toEqual([f.ref]);
    expect(plan.decisions.some(d => d.setAside)).toBe(false);
    expect(plan.alerts.filter(a => a.detail?.ref === f.ref).map(a => a.kind))
      .toEqual(['established-overlay-dropped']);
    expect(f.head()).toBe(before);
  } finally { f.cleanup(); }
}, 60_000);

it.each([{ pinned: true, why: 'flag' }, { guard: true, why: 'mechanism' }])(
  'never sets aside a protected overlay: %j', async ({ why, ...options }) => {
    const f = await createSetAsideFixture(options);
    try {
      const result = await f.rebuild();
      expect(result.adopted).not.toBe(true);
      expect(f.state().setAside?.[f.ref]).toBeUndefined();
      expect(f.alerts().some(a => /pinned|established-overlay/.test(a.kind))).toBe(true);
      expect(planner.mainSyncSetAside(f.git, { ref: f.ref, pinned: options.pinned }, f.main, f.tip))
        .toMatchObject({ eligible: false, reason: why });
    } finally { f.cleanup(); }
  }, 60_000);

it.each(['unparseable', 'empty', 'error'])('unknown conflict evidence escalates: %s', async kind => {
  const f = await createSetAsideFixture();
  try {
    const git = args => args[0] === 'merge-tree'
      ? { status: kind === 'error' ? 128 : 1, stdout: kind === 'unparseable' ? 'garbage\n100644 not-a-sha 1\tworker.mjs\n' : '' }
      : f.git(args);
    expect(planner.mainSyncSetAside(git, { ref: f.ref }, f.main, f.tip))
      .toMatchObject({ eligible: false, reason: 'conflict-evidence-unknown' });
    // Fail only the guarded evidence read; ordinary merge planning still observes the
    // real conflict, so this verifies that the loss-protection hold remains intact.
    let afterConfig = false;
    const planGit = args => {
      const inject = args[0] === 'merge-tree' && afterConfig;
      afterConfig = args[0] === 'config';
      return inject ? git(args) : f.git(args);
    };
    const plan = await planner.planRebuild({ git: planGit, headSha: f.head(), mainRef: 'origin/main',
      overlays: f.overlays(), edgeResolve: false, mainSyncConflicts: readMainSyncConflicts(f.root, f.env) });
    expect(plan.establishedLost.map(o => o.ref)).toEqual([f.ref]);
    expect(plan.decisions.some(d => d.setAside)).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

it('adopts current main, records files, alerts once across ticks, and re-adds a repaired overlay', async () => {
  expect(await probeRebuildSetAside()).toMatchObject({ adopted: true, onMain: true, alerts: 1, events: 1, registered: true, rebuildAlerts: 1,
    alertMessage: expect.stringContaining('rebase its branch onto main'),
    aside: { reason: 'main-sync-conflict', files: ['worker.mjs'], ref: 'lane/set-aside' },
    repaired: true, reapplied: true, cleared: true });
}, 60_000);

it('does not invent adopted ancestry for omitted content, and still audits its repair', async () => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const result = await f.rebuild();
    expect(result.adopted).toBe(true);
    expect(f.git(['merge-base', '--is-ancestor', f.main, f.head()]).status).toBe(0);
    expect(f.git(['merge-base', '--is-ancestor', f.tip, f.head()]).status).not.toBe(0);
    expect(f.state().setAside[f.ref].files).toEqual([f.file]);
    // A clean replacement still needs its ordinary audit. Set-aside cannot erase that gate.
    await f.repair();
    expect(f.state().adopted.applied.some(o => o.ref === f.ref)).toBe(false);
    expect(f.alerts().some(a => a.kind === 'overlay-unaudited-tip')).toBe(true);
  } finally { f.cleanup(); }
}, 60_000);

it('unreadable main-sync state keeps the live overlay hold and names operator repair', async () => {
  const f = await createSetAsideFixture();
  try {
    writeFileSync(`${overlayFilePath(f.root, f.env)}.main-sync.state`, '{broken');
    const result = await f.rebuild();
    expect(result).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.state().setAside?.[f.ref]).toBeUndefined();
    expect(f.alerts()).toContainEqual(expect.objectContaining({ kind: 'overlay-main-sync-state-unknown',
      detail: expect.objectContaining({ message: expect.stringContaining('repair main-sync state') }) }));
  } finally { f.cleanup(); }
}, 60_000);

it('reads pre-continuity persisted state, round-trips set-aside, and refuses malformed evidence', async () => {
  const f = await createSetAsideFixture();
  try {
    const path = rebuildStatePath(f.root, f.env);
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    delete legacy.setAside;
    writeFileSync(path, JSON.stringify(legacy));
    expect(() => readRebuildStateStrict(f.root, f.env)).not.toThrow();
    expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.state().setAside).toBeUndefined();
    // Explicit known-empty continuity still round-trips a subsequent omission.
    writeFileSync(path, JSON.stringify({ ...f.state(), setAside: {} }));
    await f.rebuild();
    expect(readRebuildStateStrict(f.root, f.env).setAside[f.ref].files).toEqual([f.file]);
    const broken = JSON.parse(readFileSync(path, 'utf8'));
    broken.setAside[f.ref].files = [];
    writeFileSync(path, JSON.stringify(broken));
    expect(() => readRebuildStateStrict(f.root, f.env)).toThrow('Invalid rebuild state setAside');
  } finally { f.cleanup(); }
}, 60_000);

it.each(['main', 'tip', 'missing-main'])('stale or incomplete sync pair retains the hold: %s', async kind => {
  const f = await createSetAsideFixture();
  try {
    const path = `${overlayFilePath(f.root, f.env)}.main-sync.state`;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'missing-main') delete data.conflictMain[f.ref];
    else data[kind === 'main' ? 'conflictMain' : 'conflictTip'][f.ref] = 'a'.repeat(40);
    writeFileSync(path, JSON.stringify(data));
    expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.state().setAside?.[f.ref]).toBeUndefined();
  } finally { f.cleanup(); }
}, 60_000);

it('keeps the old hold when the overlay also conflicts with an applied overlay', async () => {
  const f = await createSetAsideFixture({ sibling: true });
  try {
    expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.state().setAside?.[f.ref]).toBeUndefined();
  } finally { f.cleanup(); }
}, 60_000);

it('keeps the hold when independence from another overlay cannot be proved', async () => {
  const f = await createSetAsideFixture({ sibling: true });
  try {
    const git = args => args[0] === 'merge-tree' && args.includes(f.tip) && args.some(a => a.startsWith('--merge-base='))
      ? { status: 128, stdout: '' } : f.git(args);
    const plan = await planner.planRebuild({ git, headSha: f.head(), mainRef: 'origin/main',
      overlays: f.overlays(), edgeResolve: false, mainSyncConflicts: readMainSyncConflicts(f.root, f.env) });
    expect(plan.establishedLost.map(o => o.ref)).toContain(f.ref);
    expect(plan.decisions.some(d => d.setAside)).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

it('wakes the set-aside overlay PR even when the resolver diagnostic is suppressed', async () => {
  const f = await createSetAsideFixture({ pr: 123 });
  try {
    clearOverlayConflictWake(f.env, 123);
    expect(await f.rebuild()).toMatchObject({ adopted: true });
    expect(readOverlayConflictWakes(f.env).get(123)).toMatchObject({ ref: f.ref, files: [f.file] });
  } finally { f.cleanup(); }
}, 60_000);

it('launches automatic rebase for a set-aside overlay without holding the rebuild', async () => {
  const f = await createSetAsideFixture();
  try {
    const kickAutoRebase = vi.fn(async () => ({ started: [f.ref], skipped: [] }));
    const result = await prepareRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now, prState: async () => 'OPEN', autoRebase: { resolveAutoRebaseSwitch: () => ({ enabled: true, source: 'test' }),
      finishPendingSwaps: async () => {}, kickAutoRebase } });
    expect(result.terminal).toBe(false);
    expect(result.plan.establishedLost).toEqual([]);
    expect(kickAutoRebase).toHaveBeenCalledWith(expect.objectContaining({ lost: [expect.objectContaining({ ref: f.ref })] }));
  } finally { f.cleanup(); }
}, 60_000);

it('retains set-aside evidence until the repaired candidate is adopted', async () => {
  const f = await createSetAsideFixture();
  try {
    await f.rebuild();
    const record = f.state().setAside[f.ref];
    let observed = false;
    await f.repair({ runSmoke: async () => {
      observed = true;
      expect(f.state().setAside?.[f.ref]).toEqual(record);
      throw new Error('smoke unavailable');
    } });
    expect(observed).toBe(true);
    expect(f.state().setAside?.[f.ref]).toEqual(record);
    expect(await f.rebuild()).toMatchObject({ adopted: true });
    expect(f.state().setAside?.[f.ref]).toBeUndefined();
  } finally { f.cleanup(); }
}, 60_000);

it('refuses adoption if an omitted overlay becomes pinned during smoke', async () => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head();
    const result = await f.rebuild({ runSmoke: async () => {
      const path = overlayFilePath(f.root, f.env);
      const list = JSON.parse(readFileSync(path, 'utf8'));
      list.overlays.find(o => o.ref === f.ref).pinned = true;
      writeFileSync(path, JSON.stringify(list));
      return { verdict: 'pass', attempts: 1, smoke: { results: SMOKE_CHECKS.map(({ name }) => ({ name, ok: true })) } };
    } });
    expect(result.adopted).not.toBe(true);
    expect(result.reason).toBe('established-overlay-conflict');
    expect(f.head()).toBe(before);
  } finally { f.cleanup(); }
}, 60_000);

it.each(['sha', 'mainSha'])('strict set-aside validation rejects coerced array %s', async field => {
  const f = await createSetAsideFixture();
  try {
    await f.rebuild();
    const path = rebuildStatePath(f.root, f.env);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.setAside[f.ref][field] = [state.setAside[f.ref][field]];
    writeFileSync(path, JSON.stringify(state));
    expect(() => readRebuildStateStrict(f.root, f.env)).toThrow('Invalid rebuild state setAside');
  } finally { f.cleanup(); }
}, 60_000);


it('failed first set-aside smoke preserves omission history and rechecks conflict evidence', async () => {
  const f = await createSetAsideFixture();
  try {
    const before = f.state();
    const result = await f.rebuild({ runSmoke: async () => { throw new Error('failed smoke'); } });
    expect(result.adopted).not.toBe(true);
    expect(f.state().adopted).toEqual(before.adopted);
    expect(f.state().setAside).toEqual(before.setAside);
    const path = `${overlayFilePath(f.root, f.env)}.main-sync.state`;
    writeFileSync(path, '{broken');
    expect(await f.rebuild()).toMatchObject({ reason: 'established-overlay-conflict' });
  } finally { f.cleanup(); }
}, 60_000);

it.each(['legacy', 'missing'])('unknown continuity evidence does not restore first-adoption exemption: %s', async kind => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    await f.rebuild();
    const path = rebuildStatePath(f.root, f.env);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    delete state.setAside;
    writeFileSync(path, JSON.stringify(state));
    if (kind === 'missing') unlinkSync(path);
    await f.repair();
    expect(f.state().adopted?.applied.some(o => o.ref === f.ref)).not.toBe(true);
    await f.rebuild();
    expect(f.state().adopted?.applied.some(o => o.ref === f.ref)).not.toBe(true);
    expect(f.state().setAside).toBeUndefined();
  } finally { f.cleanup(); }
}, 60_000);

it('retains a mechanism pin from any running sha after a replacement tip removes it', async () => {
  const f = await createSetAsideFixture();
  try {
    const base = f.git(['rev-parse', `${f.tip}^`]).stdout.trim();
    const tree = f.git(['rev-parse', `${f.tip}^{tree}`]).stdout.trim();
    const newer = f.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', base, '-m', 'newer overlay']).stdout.trim();
    const replacement = f.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', base, '-m', 'replacement']).stdout.trim();
    const running = f.git(['-c', 'user.name=daemon-rebuild', '-c', 'user.email=daemon-rebuild@localhost',
      'commit-tree', tree, '-p', f.head(), '-p', newer, '-m',
      `daemon-rebuild: merge overlay ${f.ref} onto ${f.head()}`]).stdout.trim();
    expect(f.git(['update-ref', `refs/remotes/origin/${f.ref}`, replacement]).status).toBe(0);
    const git = (args, options) => args[0] === 'diff' && args.includes(f.tip)
      ? { status: 0, stdout: 'scripts/lib/daemon-rebuild.mjs\n' } : f.git(args, options);
    const plan = await planner.planRebuild({ git, headSha: running, mainRef: 'origin/main',
      overlays: f.overlays(), edgeResolve: false,
      mainSyncConflicts: { conflictMain: { [f.ref]: f.main }, conflictTip: { [f.ref]: replacement } } });
    expect(plan.establishedLost.map(o => o.ref)).toContain(f.ref);
    expect(plan.decisions.some(d => d.setAside)).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

it.each([1, 128])('holds when combined applied content conflicts or is unknown despite clean original tips: %s', async status => {
  const f = await createSetAsideFixture({ sibling: true });
  try {
    const sibling = f.git(['rev-parse', 'refs/remotes/origin/lane/sibling']).stdout.trim();
    const tree = f.git(['rev-parse', `${sibling}^{tree}`]).stdout.trim();
    let combinedSha;
    const git = (args, options) => {
      if (args[0] === 'merge-tree' && args.includes(f.tip) && args.includes(sibling))
        return { status: 0, stdout: tree + '\n' };
      if (args[0] === 'merge-tree' && args.includes(f.tip) && args.some(a => a.startsWith('--merge-base='))) {
        combinedSha = args.at(-2);
        return { status, stdout: '' };
      }
      return f.git(args, options);
    };
    const plan = await planner.planRebuild({ git, headSha: f.head(), mainRef: 'origin/main',
      overlays: f.overlays(), edgeResolve: false, mainSyncConflicts: readMainSyncConflicts(f.root, f.env) });
    expect(plan.establishedLost.map(o => o.ref)).toContain(f.ref);
    expect(plan.decisions.some(d => d.setAside)).toBe(false);
    expect(combinedSha).toBe(plan.finalSha);
    expect(combinedSha).not.toBe(sibling);
    expect(combinedSha).not.toBe(f.main);
  } finally { f.cleanup(); }
}, 60_000);

it.each([false, true])('omitted registered pin blocks normal adoption but permits safety rollback: rollback=%s', async rollback => {
  const f = await createSetAsideFixture({ pinned: true });
  try {
    const result = await finalizeRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      prevHead: f.head(), lease: { token: rollback ? 'force-adopt-rollback' : 'normal' }, freshSmoke: f.main,
      plan: { ok: true, finalSha: f.main, mainSha: f.main, inputsKey: 'rollback-test', applied: [], decisions: [] } });
    if (rollback) {
      expect(result.adopted).toBe(true);
      expect(f.head()).toBe(f.main);
    } else {
      expect(result).toMatchObject({ reason: 'established-overlay-conflict' });
      expect(f.head()).not.toBe(f.main);
    }
  } finally { f.cleanup(); }
}, 60_000);

it('a set-aside never takes the skip-unrelated adopt path: candidate smoke is forced', async () => {
  const f = await createSetAsideFixture();
  try {
    const skipCheck = vi.fn(() => ({ skip: true, reason: 'test-unrelated' }));
    const result = await prepareRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now, prState: async () => 'OPEN', skipCheck,
      autoRebase: { resolveAutoRebaseSwitch: () => ({ enabled: false, source: 'test' }), finishPendingSwaps: async () => {}, kickAutoRebase: async () => ({ started: [], skipped: [] }) } });
    expect(result.plan.decisions.some(d => d.setAside)).toBe(true);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(result.result?.skippedSmoke).not.toBe(true);
    expect(result.terminal).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

it('strictAdopt direct finalize refuses a set-aside without fresh smoke and keeps HEAD', async () => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head(), adopted = f.state().adopted;
    const job = await f.rebuild({ readyOnly: true });
    expect(job.reason).toBe('ready-recorded');
    expect(job.plan.decisions.some(d => d.setAside)).toBe(true);
    const result = await finalizeRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      plan: job.plan, prevHead: before, lease: { token: 'normal' } });
    expect(result).toMatchObject({ moved: false, reason: 'strict-adopt-needs-fresh-smoke' });
    expect(f.head()).toBe(before);
    expect(f.state().adopted).toEqual(adopted);
    expect(readReadyCandidate(f.root, f.env)).toBeNull();
  } finally { f.cleanup(); }
}, 60_000);

it('gate derives strictness from facts: a smoke-fallback drop (no planner decisions) is refused without fresh smoke', async () => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head(), adopted = f.state().adopted;
    const job = await f.rebuild({ readyOnly: true });
    const registered = readOverlayState(f.root, { env: f.env }).overlays;
    expect(registered.length).toBeGreaterThan(0);
    // The fallback dropped every registered overlay and left no planner decision behind.
    const plan = { ...job.plan, applied: [], decisions: [] };
    const result = await finalizeRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      plan, prevHead: before, lease: { token: 'normal' } });
    expect(result).toMatchObject({ moved: false, reason: 'strict-adopt-needs-fresh-smoke' });
    expect(f.head()).toBe(before);
    expect(f.state().adopted).toEqual(adopted);
  } finally { f.cleanup(); }
}, 60_000);

it('strictAdopt ready reuse refuses a strict candidate without its fresh smoke mark', async () => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head(), adopted = f.state().adopted;
    const job = await f.rebuild({ readyOnly: true });
    expect(job.reason).toBe('ready-recorded');
    const ready = readReadyCandidate(f.root, f.env);
    expect(ready).toMatchObject({ strictAdopt: true, freshSmoke: job.plan.finalSha });
    delete ready.freshSmoke; // A persisted ready verdict alone cannot prove a complete fresh smoke.
    expect(writeReadyCandidate(f.root, ready, f.env)).toBe(true);
    const result = await prepareRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      prState: async () => 'OPEN' });
    expect(result).toMatchObject({ terminal: true,
      result: { moved: false, reason: 'strict-adopt-needs-fresh-smoke' } });
    expect(result.alerts.some(a => a.kind === 'ready-candidate-adopted')).toBe(true);
    expect(f.head()).toBe(before);
    expect(f.state().adopted).toEqual(adopted);
    expect(readReadyCandidate(f.root, f.env)).toBeNull();
  } finally { f.cleanup(); }
}, 60_000);

it.each(['false', 0, undefined])('malformed or missing ready strictAdopt cannot bypass the set-aside gate: %s', async strictAdopt => {
  const f = await createSetAsideFixture();
  try {
    const before = f.head();
    const job = await f.rebuild({ readyOnly: true });
    expect(job.reason).toBe('ready-recorded');
    expect(job.plan.decisions.some(d => d.setAside)).toBe(true);
    const ready = { ...readReadyCandidate(f.root, f.env), strictAdopt, freshSmoke: null };
    expect(writeReadyCandidate(f.root, ready, f.env)).toBe(true);
    expect(readReadyCandidateStrict(f.root, f.env)).toMatchObject({ strictAdopt: true, freshSmoke: null });
    // Main-only planning has no omission decisions to independently restore strict mode.
    const result = await prepareRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      prState: async () => 'OPEN', mainOnly: true });
    expect(result).toMatchObject({ terminal: true,
      result: { moved: false, reason: 'strict-adopt-needs-fresh-smoke' } });
    expect(f.head()).toBe(before);
  } finally { f.cleanup(); }
}, 60_000);

it.each([0, 'not-a-sha'])('malformed ready freshSmoke retains strict mode without smoke proof: %s', async freshSmoke => {
  const f = await createSetAsideFixture();
  try {
    expect(await f.rebuild({ readyOnly: true })).toMatchObject({ reason: 'ready-recorded' });
    const ready = { ...readReadyCandidate(f.root, f.env), strictAdopt: false, freshSmoke };
    expect(writeReadyCandidate(f.root, ready, f.env)).toBe(true);
    expect(readReadyCandidateStrict(f.root, f.env)).toMatchObject({ strictAdopt: true, freshSmoke: null });
  } finally { f.cleanup(); }
}, 60_000);

it.each([false, true])('mainOnly adoption preserves unknown omission history and later audit holds: readyOnly=%s', async readyOnly => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const state = f.state();
    delete state.setAside;
    writeFileSync(rebuildStatePath(f.root, f.env), JSON.stringify(state));
    const job = await f.rebuild({ mainOnly: true, readyOnly });
    if (readyOnly) {
      expect(job.reason).toBe('ready-recorded');
      const result = await prepareRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
        prState: async () => 'OPEN', mainOnly: true });
      expect(result.result).toMatchObject({ adopted: true });
    } else expect(job).toMatchObject({ adopted: true });
    expect(f.head()).toBe(f.main);
    expect(f.state().setAside).toBeUndefined();
    const result = await f.repair();
    expect(result.plan.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: f.ref, reason: 'unaudited-tip-held' }),
    ]));
    expect(f.head()).toBe(f.main);
    expect(f.state().setAside).toBeUndefined();
  } finally { f.cleanup(); }
}, 60_000);

it('strictAdopt rollback exemption restores last-good even for a set-aside plan without fresh smoke', async () => {
  const f = await createSetAsideFixture();
  try {
    const lastGood = f.head(), adopted = f.state().adopted;
    const job = await f.rebuild({ readyOnly: true });
    expect(job.reason).toBe('ready-recorded');
    expect(job.plan.decisions.some(d => d.setAside)).toBe(true);
    expect(f.git(['reset', '--hard', job.plan.finalSha]).status).toBe(0);
    const result = await finalizeRebuild({ root: f.root, env: f.env, run: gitRun, now: Date.now,
      plan: { ...job.plan, finalSha: lastGood, applied: adopted.applied },
      prevHead: job.plan.finalSha, lease: { token: 'force-adopt-rollback' } });
    expect(result).toMatchObject({ moved: true, adopted: true });
    expect(f.head()).toBe(lastGood);
  } finally { f.cleanup(); }
}, 60_000);
