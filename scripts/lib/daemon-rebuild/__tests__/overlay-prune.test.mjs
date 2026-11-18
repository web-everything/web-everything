import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planOverlayPrune, pruneOverlays, resolveOverlayPrune } from '../overlay-prune.mjs';
import { readPendingDrops, settlePendingDrops, restoreRegistration, withAddGuardLock } from '../../overlay-registration.mjs';
import { planRebuild, pinnedStatus, REBUILD_MECHANISM_PATHS } from '../plan.mjs';
import { writeRebuildState } from '../state.mjs';
import { kickOverlayMainSync } from '../overlay-main-sync.mjs';
import { addOverlay, removeOverlay, readOverlayState, overlayFilePath, writeOverlays } from '../../daemon-overlays.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), main = 'c'.repeat(40);
const unpinnedGit = args => ({ status: 0, stdout: args[0] === 'diff' ? '' : main });
const base = overrides => ({ overlays: [{ ref: 'old', pr: 0 }], mainSha: main, prState: () => null,
  pinStatus: (entry, tip) => pinnedStatus(unpinnedGit, entry, main, tip),
  openPrHeads: () => [], tipOf: () => a, fetchedTipOf: ref => (overrides?.tipOf ?? (() => a))(ref),
  isAncestor: () => false, conflictsWithMain: () => false, ...overrides });
const counterValues = file => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).map(([ref, value]) => [ref, value.count]));
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'overlay-prune-')); dirs.push(root);
  const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'no-prefs'), WE_DAEMON_STATE_DIR: join(root, 'state') };
  const state = { overlays: [{ ref: 'old', pr: 0 }], corrupt: false };
  const events = [], removed = [];
  const deps = { resolveSetting: () => ({ enabled: true }), readOverlayState: () => state,
    git: unpinnedGit, mainSha: main, openPrHeads: () => [], tipOf: () => a, isAncestor: () => false,
    fetchedTipOf: ref => deps.tipOf(ref),
    conflictsWithMain: () => true, prState: () => null, alert: vi.fn(), publishAttention: vi.fn(),
    removeOverlay: (root, ref, options) => { removed.push({ ref, options }); state.overlays = state.overlays.filter(o => o.ref !== ref); return { removed: true }; },
    appendOverlayEvent: (root, event) => events.push(event), ...overrides };
  const run = (extra = {}) => pruneOverlays({ root, env, deps, ...extra });
  const file = `${overlayFilePath(root, env)}.prune-state`;
  return { root, env, state, deps, run, file, events, removed };
}

describe('overlay prune planner', () => {
  it.each(['CLOSED', 'MERGED', null])('never prunes pinned entries under any rule (%s)', state => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: state ? 7 : 0, pinned: true }, { ref: 'new', pinned: true }],
      prState: () => state, tipOf: ref => ref === 'old' ? a : b, isAncestor: () => true,
      conflictsWithMain: () => true, conflictCounts: { old: 3 } }))).toEqual([]);
  });

  it.each([['CLOSED', 'pr-closed'], ['MERGED', 'pr-merged']])('prunes confirmed %s', (state, reason) => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: 7 }], prState: () => state })))
      .toEqual([expect.objectContaining({ ref: 'old', reason, prState: state })]);
  });
  it('supersedes an ancestor with another registered overlay', () => {
    const plan = planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'new' }],
      tipOf: ref => ref === 'old' ? a : b, isAncestor: (x, y) => x === a && y === b }));
    expect(plan).toEqual([expect.objectContaining({ ref: 'old', reason: 'superseded', supersededBy: 'new' })]);
  });
  it.each(['CLOSED', 'MERGED'])('keeps an ancestor whose only successor is also pruned (%s)', state => {
    for (const overlays of [[{ ref: 'old' }, { ref: 'new', pr: 7 }], [{ ref: 'new', pr: 7 }, { ref: 'old' }]]) {
      expect(planOverlayPrune(base({ overlays, prState: () => state,
        tipOf: ref => ref === 'old' ? a : b, isAncestor: (x, y) => x === a && y === b })))
        .toEqual([expect.objectContaining({ ref: 'new', reason: state === 'CLOSED' ? 'pr-closed' : 'pr-merged' })]);
    }
  });
  it('keeps an ancestor whose only successor is quarantined for repeated conflicts', () => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'new' }],
      tipOf: ref => ref === 'old' ? a : b, isAncestor: (x, y) => x === a && y === b,
      conflictsWithMain: () => true, conflictCounts: { new: 3 } })))
      .toEqual([expect.objectContaining({ ref: 'new', reason: 'pr0-conflicting' })]);
  });
  it('anchors every supersession chain directly to a retained overlay', () => {
    const top = 'd'.repeat(40), order = [a, b, top];
    const plan = planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'middle' }, { ref: 'top' }],
      tipOf: ref => ({ old: a, middle: b, top })[ref], isAncestor: (x, y) => order.indexOf(x) < order.indexOf(y) }));
    expect(plan).toEqual([
      expect.objectContaining({ ref: 'old', reason: 'superseded', supersededBy: 'top', supersedingTip: top }),
      expect.objectContaining({ ref: 'middle', reason: 'superseded', supersededBy: 'top', supersedingTip: top }),
    ]);
    expect(plan.every(item => !plan.some(other => other.ref === item.supersededBy))).toBe(true);
  });
  it('can anchor supersession to a live PR when the registered successor is pruned', () => {
    const top = 'd'.repeat(40), order = [a, b, top];
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'new', pr: 7 }, { ref: 'live', pr: 8 }], prState: pr => pr === 7 ? 'CLOSED' : 'OPEN',
      tipOf: ref => ({ old: a, new: b, live: top })[ref], openPrHeads: () => [{ ref: 'live', number: 8, headSha: top }],
      isAncestor: (x, y) => order.indexOf(x) < order.indexOf(y) })))
      .toEqual([
        expect.objectContaining({ ref: 'old', reason: 'superseded', supersededBy: 'live', supersedingTip: top }),
        expect.objectContaining({ ref: 'new', reason: 'pr-closed' }),
      ]);
  });
  it('keeps a carrier when an unregistered open PR contains its tip, including equal tips', () => {
    for (const headSha of [a, b]) expect(planOverlayPrune(base({ openPrHeads: () => [{ number: 8, ref: 'new', headSha }], isAncestor: () => true,
      conflictsWithMain: () => true, conflictCounts: { old: 3 } })))
      .toEqual([]);
  });
  it('keeps exactly the lower ref for identical overlay tips', () => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'z' }, { ref: 'a' }] })))
      .toEqual([expect.objectContaining({ ref: 'z', reason: 'superseded' })]);
  });
  it('prefers the identical-tip overlay with an open PR over the lower ref', () => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'a' }, { ref: 'z', pr: 8 }],
      prState: () => 'OPEN', openPrHeads: () => [{ number: 8, ref: 'z', headSha: a }] })))
      .toEqual([expect.objectContaining({ ref: 'a', reason: 'superseded' })]);
  });
  it('keeps a live PR even when conflicting and ancestor of another overlay', () => {
    for (const openPrHeads of [() => [], () => [{ number: 9, ref: 'old', headSha: a }]]) {
      expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: 7 }, { ref: 'new', pr: 8 }],
        prState: () => 'OPEN', openPrHeads, tipOf: ref => ref === 'old' ? a : b,
        isAncestor: () => true, conflictsWithMain: () => true, conflictCounts: { old: 9 } }))).toEqual([]);
    }
  });
  it('keeps a branch with a live open PR even with a stale CLOSED registration', () => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: 7 }], prState: () => 'CLOSED',
      openPrHeads: () => [{ number: 9, ref: 'old', headSha: a }] }))).toEqual([]);
  });
  it('keeps unknown PR states despite ancestry and conflict evidence', () => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: 7 }], isAncestor: () => true,
      openPrHeads: () => [{ number: 8, ref: 'new', headSha: b }], conflictsWithMain: () => true, conflictCounts: { old: 9 } }))).toEqual([]);
  });
  it('requires strictly more than two conflicting rebuilds', () => {
    for (const n of [0, 1, 2, 3]) expect(planOverlayPrune(base({ conflictsWithMain: () => true, conflictCounts: { old: n } })).length).toBe(n > 2 ? 1 : 0);
  });
});

describe('overlay prune IO', () => {
  it('quarantines after three conflicts, stays registered, emits attention once and skips the fourth rebuild', async () => {
    const f = fixture();
    expect(f.run()).toEqual([]); expect(f.run()).toEqual([]);
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(f.events).toEqual([expect.objectContaining({ kind: 'overlay-quarantined', ref: 'old', tip: a, count: 3 })]);
    expect(f.removed).toEqual([]);
    expect(f.state.overlays).toEqual([{ ref: 'old', pr: 0 }]);
    expect(readPendingDrops(f.root, f.env)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(`${overlayFilePath(f.root, f.env)}.quarantine`, 'utf8')))
      .toEqual([expect.objectContaining({ ref: 'old', tip: a, identity: expect.any(Object), since: expect.any(String), count: 3 })]);
    const actions = f.run();
    expect(actions).toEqual([expect.objectContaining({ action: 'quarantine', ref: 'old' })]);
    expect(f.events).toHaveLength(1);
    expect(f.deps.publishAttention).toHaveBeenCalledTimes(1);
    expect(f.deps.publishAttention).toHaveBeenCalledWith(expect.objectContaining({ kind: 'overlay-quarantined', pr: 0 }), expect.any(Object));
    const plan = await planRebuild({ git: args => args[0] === 'merge-tree'
      ? { status: 1, stdout: main } : unpinnedGit(args), headSha: b, mainRef: 'origin/main',
      overlays: f.state.overlays, quarantined: actions });
    expect(plan.ok).toBe(true);
    expect(plan.decisions).toEqual([expect.objectContaining({ action: 'skip', reason: 'overlay-quarantined' })]);
    expect(plan.establishedLost).toEqual([]);
    expect(plan.applied).toEqual([]);
  });
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('prototype-named ref %s preserves valid counters and unrelated pruning', ref => {
    const f = fixture({ tipOf: name => name === ref ? a : b });
    f.state.overlays = [{ ref, pr: 0 }];
    expect(f.run()).toEqual([]);
    expect(counterValues(f.file)).toEqual({ [ref]: 1 });
    f.state.overlays.push({ ref: 'unrelated', pr: 0 });
    expect(f.run()).toEqual([]);
    expect(counterValues(f.file)).toEqual({ [ref]: 2, unrelated: 1 });
    expect(f.run()).toEqual([expect.objectContaining({ ref, reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(counterValues(f.file)).toEqual({ [ref]: 3, unrelated: 2 });
    expect(f.run()).toEqual([expect.objectContaining({ ref, action: 'quarantine' }), expect.objectContaining({ ref: 'unrelated', reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(counterValues(f.file)).toEqual({ [ref]: 3, unrelated: 3 });
    f.state.overlays = []; f.run();
    f.state.overlays = [{ ref, pr: 0 }];
    expect(f.run()).toEqual([]);
    expect(counterValues(f.file)).toEqual({ [ref]: 1 });
    expect(f.deps.alert).not.toHaveBeenCalled();
  });
  it('resets counts when clean or unregistered', () => {
    const f = fixture(); f.run(); f.run();
    f.deps.conflictsWithMain = () => false; f.run();
    expect(counterValues(f.file)).toEqual({ old: 0 });
    f.deps.conflictsWithMain = () => true; expect(f.run()).toEqual([]);
    f.state.overlays = []; f.run(); expect(fs.existsSync(f.file)).toBe(false);
    f.state.overlays = [{ ref: 'old' }]; expect(f.run()).toEqual([]);
  });
  it('does not advance counters during main sync', () => {
    const f = fixture({ countConflicts: false }); f.run(); f.run(); f.run();
    expect(counterValues(f.file)).toEqual({ old: 0 });
  });
  it('dry-run lists only and writes nothing, including counters and locks', () => {
    const f = fixture({ prState: () => 'CLOSED' }); f.state.overlays[0].pr = 7;
    const write = vi.fn(() => { throw new Error('unexpected write'); });
    f.deps.io = { ...fs, mkdirSync: write, writeFileSync: write, renameSync: write, rmSync: write };
    expect(f.run({ dryRun: true })).toEqual([expect.objectContaining({ reason: 'pr-closed' })]);
    expect(write).not.toHaveBeenCalled(); expect(f.events).toEqual([]); expect(f.removed).toEqual([]);
  });
  it('failed open PR discovery disables ancestry and conflicts, but allows confirmed closed', () => {
    const f = fixture({ openPrHeads: () => { throw new Error('offline'); }, isAncestor: () => true });
    expect(f.run()).toEqual([]); expect(f.deps.alert).toHaveBeenCalled();
    f.state.overlays[0].pr = 7; f.deps.prState = () => 'CLOSED';
    expect(f.run()[0].reason).toBe('pr-closed');
  });
  it('oversized open inventory fails closed with an operator-visible fallback', () => {
    const f = fixture({ openPrHeads: () => Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, ref: `p${i}`, headSha: b })), isAncestor: () => true });
    expect(f.run()).toEqual([]); expect(f.deps.alert).toHaveBeenCalledWith(expect.stringContaining('inspect registrations manually'));
  });
  it('keeps overlays on corrupt sidecar or unknown merge evidence', () => {
    const f = fixture({ conflictsWithMain: () => null }); f.run();
    expect(counterValues(f.file)).toEqual({ old: 0 });
    fs.writeFileSync(f.file, 'broken'); expect(f.run()).toEqual([]); expect(f.deps.alert).toHaveBeenCalled();
  });
  it('does not bypass an add guard or pending drops', () => {
    const f = fixture({ prState: () => 'CLOSED' }); f.state.overlays[0].pr = 7;
    const guard = `${overlayFilePath(f.root, f.env)}.add-guard.lock`;
    fs.mkdirSync(guard, { recursive: true }); expect(f.run()).toEqual([]); expect(fs.existsSync(guard)).toBe(true);
    fs.rmSync(guard, { recursive: true });
    fs.writeFileSync(`${overlayFilePath(f.root, f.env)}.drop-pending`, JSON.stringify({ pending: [{ ref: 'old' }] }));
    expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
  });
  it('swallows removal errors and emits no success event', () => {
    const f = fixture({ prState: () => 'CLOSED', removeOverlay: () => { throw new Error('registration changed'); } }); f.state.overlays[0].pr = 7;
    expect(f.run()).toEqual([]); expect(f.events).toEqual([]); expect(f.deps.alert).toHaveBeenCalled();
  });
  it('defaults on and respects the environment disable with provenance', () => {
    const f = fixture(); const options = { settingsPath: join(f.root, 'missing-settings') };
    expect(resolveOverlayPrune(f.env, options)).toEqual({ enabled: true });
    expect(resolveOverlayPrune({ ...f.env, WE_OVERLAY_PRUNE: '0' }, options)).toEqual({ enabled: false });
    f.env.WE_OVERLAY_PRUNE = '0'; delete f.deps.resolveSetting;
    expect(f.run()).toEqual([]); expect(fs.existsSync(f.file)).toBe(false);
  });
});


describe('additional closed-path guarantees', () => {
  it('pr0 live branch is kept despite conflicts and ancestry', () => {
    expect(planOverlayPrune(base({ openPrHeads: () => [{ number: 8, ref: 'old', headSha: a }],
      conflictsWithMain: () => true, conflictCounts: { old: 3 }, isAncestor: () => true }))).toEqual([]);
  });
  it('bounds per-tick GitHub reads and names the operator fallback', () => {
    const f = fixture(); f.deps.openPrHeads = vi.fn();
    f.state.overlays = Array.from({ length: 101 }, (_, i) => ({ ref: `ref${i}`, pr: i + 1 }));
    expect(f.run()).toEqual([]); expect(f.deps.openPrHeads).not.toHaveBeenCalled();
    expect(f.deps.alert).toHaveBeenCalledWith(expect.stringContaining('inspect registrations manually'));
  });
  it('conflicting dry-run preserves existing counters byte for byte', () => {
    const f = fixture(); f.run(); f.run(); const before = fs.readFileSync(f.file, 'utf8');
    expect(f.run({ dryRun: true })).toEqual([]);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before); expect(f.removed).toEqual([]);
  });
  it('real removal updates the registered list and appends a reasoned audit event', () => {
    const f = fixture({ prState: () => 'MERGED' });
    addOverlay(f.root, { ref: 'old', pr: 7 }, { env: f.env });
    delete f.deps.readOverlayState; delete f.deps.removeOverlay; delete f.deps.appendOverlayEvent;
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr-merged' })]);
    expect(readOverlayState(f.root, { env: f.env }).overlays).toEqual([]);
    const eventFile = overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl');
    expect(JSON.parse(fs.readFileSync(eventFile, 'utf8').trim())).toMatchObject({ kind: 'overlay-pruned', reason: 'pr-merged', tip: a, pr: 7 });
  });
});


it('main-sync prunes before reading registrations, and off mode never invokes it', () => {
  const f = fixture();
  addOverlay(f.root, { ref: 'old', pr: 7 }, { env: f.env });
  const prune = vi.fn(() => {
    fs.writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify({ overlays: [] }));
  });
  const spawnFn = vi.fn();
  kickOverlayMainSync({ root: f.root, env: f.env, mode: 'off', spawnFn, deps: { pruneOverlays: prune } });
  expect(prune).not.toHaveBeenCalled();
  kickOverlayMainSync({ root: f.root, env: f.env, mode: 'on', spawnFn, deps: { pruneOverlays: prune } });
  expect(prune).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, deps: { countConflicts: false } }));
  expect(spawnFn).not.toHaveBeenCalled();
});


it('equal-tip preference also honors OPEN state when the head list disagrees', () => {
  expect(planOverlayPrune(base({ overlays: [{ ref: 'a' }, { ref: 'z', pr: 8 }], prState: () => 'OPEN' })))
    .toEqual([expect.objectContaining({ ref: 'a', reason: 'superseded' })]);
});


it.each([b, undefined])('restores a registration if the post-drop remote tip moved or is unreadable (%s), without a prune event', after => {
  const f = fixture({ prState: () => 'CLOSED' });
  const entry = { ref: 'old', pr: 7, addedAt: '2026-11-01', addedBy: 'operator', reason: 'repair',
    pinned: false, stackBases: ['lane/base'], edgeResolution: { sha: b, by: 'operator' },
    conflictOverride: { by: 'operator', reason: 'approved' }, futureField: { keep: true } };
  writeOverlays(f.root, [entry], { env: f.env });
  delete f.deps.readOverlayState; delete f.deps.removeOverlay;
  f.deps.remoteTip = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(a).mockReturnValueOnce(after);
  f.deps.afterDrop = () => {
    expect(fs.existsSync(`${overlayFilePath(f.root, f.env)}.add-guard.lock`)).toBe(true);
    const intent = JSON.parse(fs.readFileSync(`${overlayFilePath(f.root, f.env)}.drop-pending`, 'utf8'));
    expect(intent.pending[0]).toMatchObject({ ref: 'old', tip: a, kind: 'prune' });
  };
  expect(f.run()).toEqual([]);
  expect(readOverlayState(f.root, { env: f.env }).overlays).toEqual([entry]);
  expect(f.events).toEqual([]);
  expect(fs.existsSync(`${overlayFilePath(f.root, f.env)}.drop-pending`)).toBe(false);
});

it('keeps a registration when the remote tip changes before removal', () => {
  const f = fixture({ prState: () => 'CLOSED', remoteTip: vi.fn().mockReturnValueOnce(a).mockReturnValue(b) });
  f.state.overlays[0].pr = 7;
  expect(f.run()).toEqual([]); expect(f.removed).toEqual([]); expect(f.events).toEqual([]);
});

it.each([b, undefined])('uses the current remote tip instead of a stale tracking ref for main-sync pruning (%s)', tip => {
  const f = fixture();
  delete f.deps.tipOf;
  f.state.overlays = [{ ref: 'old' }, { ref: 'carrier', pinned: true }];
  f.deps.git = vi.fn(args => {
    if (args.includes('remote')) return { status: 0, stdout: 'fixture-origin' };
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1);
      if (ref.endsWith('/old') && tip === undefined) return { status: 1 };
      return { status: 0, stdout: `${ref.endsWith('/old') ? tip : a}\t${ref}\n` };
    }
    // Pin evidence is separate from stale tracking refs.
    return { status: 0, stdout: args[0] === 'diff' ? '' : a };
  });
  f.deps.isAncestor = (x, y) => x === a && y === a;
  f.deps.conflictsWithMain = () => false;
  expect(f.run({ deps: { ...f.deps, countConflicts: false } })).toEqual([]);
  expect(f.deps.git).toHaveBeenCalledWith(expect.arrayContaining(['ls-remote']));
  expect(f.removed).toEqual([]);
});


it('retains a previously adopted different tip despite repeated conflicts', () => {
  const alertAdopted = vi.fn();
  const f = fixture({ adopted: [{ ref: 'old', sha: b }], alertAdopted });
  f.run(); f.run(); f.run();
  expect(f.events).toEqual([]);
  expect(f.removed).toEqual([]);
  expect(alertAdopted).not.toHaveBeenCalled();
});

it('retains an adopted ancestor when the registered carrier does not contain the adopted tip', () => {
  const f = fixture({ adopted: [{ ref: 'old', sha: main }], isAncestor: (x, y) => x === a && y === b });
  f.state.overlays.push({ ref: 'carrier', pinned: true });
  f.deps.tipOf = ref => ref === 'old' ? a : b;
  expect(f.run()).toEqual([]); expect(f.events).toEqual([]);
});


it('keeps a closed registration with an unknown remote tip', () => {
  const f = fixture({ prState: () => 'CLOSED', tipOf: () => undefined });
  f.state.overlays[0].pr = 7;
  expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
});

it.each([a, b])('settles an interrupted prune using the durable drop protocol (%s)', recoveredTip => {
  const f = fixture({ prState: () => 'CLOSED', afterDrop: () => { throw new Error('interrupted'); } });
  addOverlay(f.root, { ref: 'old', pr: 7 }, { env: f.env });
  delete f.deps.readOverlayState; delete f.deps.removeOverlay;
  expect(f.run()).toEqual([]);
  expect(readOverlayState(f.root, { env: f.env }).overlays).toEqual([]);
  expect(readPendingDrops(f.root, f.env)).toEqual([expect.objectContaining({ kind: 'prune', tip: a })]);
  expect(f.events).toEqual([]);
  const result = withAddGuardLock(f.root, f.env, () => settlePendingDrops({ root: f.root, env: f.env,
    deps: { tip: () => recoveredTip } }), { noWait: true });
  expect(result).toEqual([{ ref: 'old', outcome: recoveredTip === a ? 'drop-confirmed' : 'restored' }]);
  expect(readPendingDrops(f.root, f.env)).toEqual([]);
  expect(readOverlayState(f.root, { env: f.env }).overlays.length).toBe(recoveredTip === a ? 0 : 1);
  const events = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(events.some(e => e.kind === 'overlay-pruned')).toBe(recoveredTip === a);
});


it('restores the pruned tip when its registered carrier moves after removal', () => {
  const f = fixture({ isAncestor: (x, y) => x === a && y === b, conflictsWithMain: () => false });
  addOverlay(f.root, { ref: 'old', pr: 0 }, { env: f.env });
  addOverlay(f.root, { ref: 'carrier', pr: 0, pinned: true }, { env: f.env });
  delete f.deps.readOverlayState; delete f.deps.removeOverlay;
  let moved = false;
  f.deps.remoteTip = ref => ref === 'old' ? a : moved ? main : b;
  f.deps.fetchedTipOf = ref => ref === 'old' ? a : b;
  f.deps.afterDrop = () => { moved = true; };
  expect(f.run()).toEqual([]);
  expect(readOverlayState(f.root, { env: f.env }).overlays.map(o => o.ref).sort()).toEqual(['carrier', 'old']);
  expect(f.events).toEqual([]);
});

it('retains adopted supersession even when a registered survivor contains the adopted tip', () => {
  const f = fixture({ adopted: [{ ref: 'old', sha: a }], isAncestor: (x, y) => x === a && y === b });
  f.state.overlays.push({ ref: 'carrier', pinned: true });
  f.deps.tipOf = ref => ref === 'old' ? a : b;
  expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
});


describe('audit retention guarantees', () => {
  it.each(['CLOSED', 'MERGED', null])('retains mechanism-derived pins for every rule (%s)', state => {
    const f = fixture({ prState: () => state, isAncestor: () => true,
      git: args => ({ status: 0, stdout: args[0] === 'diff' ? 'scripts/lib/overlay-registration.mjs\n' : main }) });
    f.state.overlays = [{ ref: 'old', pr: state ? 7 : 0 }, { ref: 'carrier', pinned: true }];
    fs.mkdirSync(join(f.root, 'overlays'), { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ old: 3 }));
    expect(f.run()).toEqual([]);
    expect(f.removed).toEqual([]); expect(f.events).toEqual([]);
  });
  it.each(['merge-base', 'diff'])('retains unknown pin evidence when %s fails', command => {
    const f = fixture({ prState: () => 'CLOSED',
      git: args => args[0] === command ? { status: 128 } : unpinnedGit(args) });
    f.state.overlays[0].pr = 7;
    expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
  });
  it('retains overlays when the planner has no pin evidence', () => {
    expect(planOverlayPrune(base({ prState: () => 'CLOSED', overlays: [{ ref: 'old', pr: 7 }], pinStatus: undefined }))).toEqual([]);
  });
  it('protects the moved registration guards as rebuild mechanism', () => {
    expect(REBUILD_MECHANISM_PATHS).toContain('scripts/lib/overlay-registration.mjs');
    const git = vi.fn(args => ({ status: 0, stdout: args[0] === 'diff' && args.includes('scripts/lib/overlay-registration.mjs')
      ? 'scripts/lib/overlay-registration.mjs\n' : args[0] === 'diff' ? '' : main }));
    expect(pinnedStatus(git, { ref: 'old' }, main, a)).toEqual({ pinned: true, why: 'mechanism' });
  });
  it.each(['edgeResolution', 'conflictOverride'])('retains approved %s during supersession even when tips have ancestry', field => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', [field]: { sha: main } }, { ref: 'carrier', pinned: true }],
      tipOf: ref => ref === 'old' ? a : b, isAncestor: () => true,
      conflictsWithMain: () => true, conflictCounts: { old: 3 } }))).toEqual([]);
  });
  it.each(['pr-closed', 'superseded', 'pr0-conflicting'])('retains a tip carried by the running adopted head for %s, including dry-run', rule => {
    const f = fixture({ adoptedHead: main, prState: () => 'CLOSED',
      isAncestor: (x, y) => x === a && [b, main].includes(y), tipOf: ref => ref === 'old' ? a : b });
    f.state.overlays[0].pr = rule === 'pr-closed' ? 7 : 0;
    if (rule === 'superseded') f.state.overlays.push({ ref: 'carrier', pinned: true });
    fs.mkdirSync(join(f.root, 'overlays'), { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ old: 3 }));
    expect(f.run({ dryRun: true })).toEqual([]);
    expect(f.run()).toEqual([]);
    expect(f.removed).toEqual([]); expect(f.events).toEqual([]);
  });
  it('retains an adopted tip on unreadable containment evidence', () => {
    const f = fixture({ adoptedHead: main, prState: () => 'CLOSED', isAncestor: () => null });
    f.state.overlays[0].pr = 7;
    expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
  });
  it('allows pr-merged retirement even when the running adopted head contains the tip', () => {
    const f = fixture({ adoptedHead: main, prState: () => 'MERGED', isAncestor: () => true });
    f.state.overlays[0].pr = 7;
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr-merged' })]);
  });
  it.each([true, false])('standalone pruning reads adopted state and verifies it is running (%s)', running => {
    const f = fixture({ prState: () => 'CLOSED', isAncestor: () => true,
      git: args => args[0] === 'rev-parse' ? { status: 0, stdout: running ? main : b } : unpinnedGit(args) });
    f.state.overlays[0].pr = 7;
    writeRebuildState(f.root, { adopted: { head: main, applied: [] } }, f.env);
    expect(f.run().length).toBe(running ? 0 : 1);
    expect(f.removed.length).toBe(running ? 0 : 1);
  });
  it('full-entry restoration preserves pins and unknown fields without replacing a fresh registration', () => {
    const f = fixture();
    const entry = { ref: 'old', pr: 0, pinned: true, edgeResolution: { sha: b }, stackBases: ['base'],
      conflictOverride: { by: 'operator' }, futureField: ['preserved'] };
    withAddGuardLock(f.root, f.env, () => {
      expect(restoreRegistration(f.root, entry, f.env)).toBe('restored');
      expect(readOverlayState(f.root, { env: f.env }).overlays).toEqual([entry]);
      expect(restoreRegistration(f.root, { ...entry, pr: 7 }, f.env)).toBe('skipped-reregistered');
      expect(readOverlayState(f.root, { env: f.env }).overlays).toEqual([entry]);
    }, { noWait: true });
  });
});


describe('third audit regression guarantees', () => {
  it.each(['tip', 'registration'])('resets conflict count to zero when %s changes after two conflicts', changed => {
    const f = fixture(); f.state.overlays[0].addedAt = 'first';
    f.run(); f.run();
    if (changed === 'tip') f.deps.tipOf = () => b;
    else f.state.overlays[0].addedAt = 'second';
    expect(f.run()).toEqual([]);
    expect(counterValues(f.file)).toEqual({ old: 0 });
    expect(f.run()).toEqual([]); expect(f.run()).toEqual([]);
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr0-conflicting', conflictCount: 3 })]);
  });
  it('resets historical ref-only sidecars rather than inheriting their count', () => {
    const f = fixture();
    fs.mkdirSync(join(f.root, 'overlays'), { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ old: 3 }));
    expect(f.run()).toEqual([]); expect(counterValues(f.file)).toEqual({ old: 0 });
  });
  it('preserves counters when only the mutable stack-base cache changes', () => {
    const f = fixture(); f.run(); f.run();
    f.state.overlays[0].stackBases = ['base'];
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr0-conflicting' })]);
  });
  it.each(['missing', 're-registered'])('keeps the ancestor if the survivor is %s at removal under the add guard', change => {
    const f = fixture({ isAncestor: (x, y) => x === a && y === b, conflictsWithMain: () => false });
    const old = { ref: 'old', pr: 0 }, carrier = { ref: 'carrier', pinned: true, addedAt: 'first' };
    writeOverlays(f.root, [old, carrier], { env: f.env });
    delete f.deps.readOverlayState;
    f.deps.tipOf = ref => ref === 'old' ? a : b;
    f.deps.removeOverlay = (root, ref, options) => {
      expect(fs.existsSync(`${overlayFilePath(root, f.env)}.add-guard.lock`)).toBe(true);
      expect(options).toMatchObject({ requireRef: 'carrier', expectedRequiredOverlay: carrier });
      writeOverlays(root, change === 'missing' ? [old] : [old, { ...carrier, addedAt: 'second' }], { env: f.env });
      return removeOverlay(root, ref, options);
    };
    expect(f.run()).toEqual([]);
    expect(readOverlayState(f.root, { env: f.env }).overlays).toContainEqual(old);
    expect(f.events).toEqual([]);
  });
  it.each(['history', 'state'])('protects an older adopted sha from %s after the ref moves, except pr-merged', source => {
    const f = fixture({ prState: () => 'CLOSED', isAncestor: () => false,
      git: args => args[0] === 'log' ? { status: 0, stdout: source === 'history'
        ? `${main} ${b}\tdaemon-rebuild@localhost\tdaemon-rebuild: merge overlay old (PR #7) onto ${main}\n` : '' }
        : unpinnedGit(args) });
    f.state.overlays[0].pr = 7;
    writeRebuildState(f.root, { adopted: { head: main, applied: source === 'state' ? [{ ref: 'old', sha: b }] : [] } }, f.env);
    expect(f.run({ dryRun: true })).toEqual([]); expect(f.run()).toEqual([]);
    f.deps.prState = () => 'MERGED';
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr-merged' })]);
  });
  it.each(['registered', 'open-pr'])('unknown ancestry against a %s carrier blocks every removal rule', carrier => {
    for (const state of ['CLOSED', 'MERGED', null]) {
      const f = fixture({ prState: () => state, isAncestor: () => null,
        tipOf: ref => ref === 'old' ? a : b,
        openPrHeads: () => carrier === 'open-pr' ? [{ number: 9, ref: 'live', headSha: b }] : [] });
      f.state.overlays[0].pr = state ? 7 : 0;
      if (carrier === 'registered') f.state.overlays.push({ ref: 'carrier', pinned: true });
      f.run(); f.run(); expect(f.run()).toEqual([]);
      expect(f.removed).toEqual([]); expect(f.events).toEqual([]);
    }
  });
  it('keeps overlays if reading adopted merge history fails', () => {
    const f = fixture({ adoptedHead: main, prState: () => 'CLOSED',
      git: args => args[0] === 'log' ? { status: 128 } : unpinnedGit(args) });
    f.state.overlays[0].pr = 7;
    expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
  });
});


it.each([2, 128])('failed carrier ancestry status %s blocks closed, merged, and conflicting pruning', status => {
  for (const state of ['CLOSED', 'MERGED', null]) {
    const f = fixture({ prState: () => state,
      tipOf: ref => ref === 'old' ? a : b,
      openPrHeads: () => [{ number: 9, ref: 'live', headSha: b }],
      git: args => args[0] === 'merge-base' && args[1] === '--is-ancestor' ? { status } : unpinnedGit(args) });
    delete f.deps.isAncestor;
    f.state.overlays[0].pr = state ? 7 : 0;
    f.run(); f.run(); expect(f.run()).toEqual([]);
    expect(f.removed).toEqual([]);
  }
});

it('unknown carrier evidence overrides a known superseding overlay', () => {
  expect(planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'carrier', pinned: true }],
    tipOf: ref => ref === 'old' ? a : b,
    openPrHeads: () => [{ number: 9, ref: 'live', headSha: main }],
    isAncestor: (x, y) => y === main ? null : true }))).toEqual([]);
});

it('protects an older adopted tip from running-build records even without cached adopted state', () => {
  const f = fixture({ prState: () => 'CLOSED', isAncestor: () => false,
    git: args => args[0] === 'log' ? { status: 0,
      stdout: `${main} ${b}\tdaemon-rebuild@localhost\tdaemon-rebuild: merge overlay old onto ${main}\n` } : unpinnedGit(args) });
  f.state.overlays[0].pr = 7;
  expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
});


describe('quarantine recovery and clean supersession', () => {
  it('proves supersession ancestry and clean apply using fetched tracking SHAs', () => {
    const fetchedMain = 'd'.repeat(40);
    const git = vi.fn(args => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: {
        'origin/main^{commit}': fetchedMain, 'refs/remotes/origin/old^{commit}': a,
        'refs/remotes/origin/carrier^{commit}': b,
      }[args.at(-1)] ?? '' };
      return unpinnedGit(args);
    });
    const isAncestor = vi.fn((x, y) => x === a && y === b);
    const f = fixture({ git, tipOf: ref => ref === 'old' ? a : b, isAncestor });
    delete f.deps.fetchedTipOf; delete f.deps.conflictsWithMain;
    f.state.overlays.push({ ref: 'carrier', pinned: true });
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'superseded', tip: a, supersedingTip: b })]);
    expect(isAncestor).toHaveBeenCalledWith(a, b);
    expect(git).toHaveBeenCalledWith(['merge-tree', '--write-tree', fetchedMain, b]);
    expect(f.removed.map(o => o.ref)).toEqual(['old']);
  });

  it.each(['old', 'carrier'])('keeps the ancestor when %s moved after fetch or its fetched tip is unknown', ref => {
    for (const fetched of [main, null]) {
      const f = fixture({ tipOf: name => name === 'old' ? a : b,
        isAncestor: (x, y) => x === a && y === b, conflictsWithMain: () => false,
        git: args => args[0] === 'rev-parse' ? { status: 0, stdout:
          args.at(-1) === `refs/remotes/origin/${ref}^{commit}` ? fetched ?? ''
            : args.at(-1) === 'refs/remotes/origin/old^{commit}' ? a : b } : unpinnedGit(args) });
      delete f.deps.fetchedTipOf; // Exercise the actual tracking-ref reader.
      f.state.overlays.push({ ref: 'carrier', pinned: true });
      expect(f.run()).toEqual([]);
      expect(f.removed).toEqual([]);
      expect(f.events).toEqual([]);
    }
  });

  it.each(['old', 'carrier'])('keeps the ancestor when the live %s tip is unknown at removal', ref => {
    const f = fixture({ tipOf: name => name === 'old' ? a : b,
      isAncestor: (x, y) => x === a && y === b, conflictsWithMain: () => false });
    f.state.overlays.push({ ref: 'carrier', pinned: true });
    const reads = new Map();
    f.deps.remoteTip = name => {
      const count = (reads.get(name) ?? 0) + 1; reads.set(name, count);
      return name === ref && count > 1 ? null : name === 'old' ? a : b;
    };
    expect(f.run()).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.events).toEqual([]);
    expect(readPendingDrops(f.root, f.env)).toEqual([]);
  });

  it.each(['clean', 'tip', 'registration'])('lifts quarantine on %s and emits once', change => {
    const f = fixture(); f.run(); f.run(); f.run();
    if (change === 'clean') f.deps.conflictsWithMain = () => false;
    if (change === 'tip') f.deps.tipOf = () => b;
    if (change === 'registration') f.state.overlays[0].addedAt = 'new-registration';
    expect(f.run()).toEqual([]);
    expect(fs.existsSync(`${overlayFilePath(f.root, f.env)}.quarantine`)).toBe(false);
    expect(f.events.map(e => e.kind)).toEqual(['overlay-quarantined', 'overlay-quarantine-lifted']);
    f.run();
    expect(f.events).toHaveLength(2);
    expect(f.removed).toEqual([]);
  });
  it.each(['open-pr', 'pinned', 'edgeResolution', 'adopted'])('does not quarantine protected %s', protection => {
    const f = fixture();
    if (protection === 'open-pr') f.deps.openPrHeads = () => [{ ref: 'old', number: 8, headSha: a }];
    if (protection === 'pinned') f.state.overlays[0].pinned = true;
    if (protection === 'edgeResolution') f.state.overlays[0].edgeResolution = { sha: b };
    if (protection === 'adopted') f.deps.adopted = [{ ref: 'old', sha: a }];
    f.run(); f.run(); expect(f.run()).toEqual([]);
    expect(f.events).toEqual([]); expect(f.removed).toEqual([]);
    expect(fs.existsSync(`${overlayFilePath(f.root, f.env)}.quarantine`)).toBe(false);
  });
  it.each([true, null, false])('supersession requires a proven clean survivor (%s)', conflict => {
    const f = fixture({ tipOf: ref => ref === 'old' ? a : b, isAncestor: (x, y) => x === a && y === b,
      conflictsWithMain: () => conflict });
    f.state.overlays.push({ ref: 'carrier', pinned: true });
    expect(f.run()).toEqual(conflict === false ? [expect.objectContaining({ action: 'prune', reason: 'superseded' })] : []);
    expect(f.removed.length).toBe(conflict === false ? 1 : 0);
  });
  it('dry-run lists prune and quarantine actions without writing', () => {
    const f = fixture({ prState: () => 'CLOSED' }); f.run(); f.run(); f.run();
    f.state.overlays.push({ ref: 'closed', pr: 7 });
    const before = fs.readFileSync(f.file, 'utf8'), events = f.events.length;
    expect(f.run({ dryRun: true })).toEqual([
      expect.objectContaining({ ref: 'old', action: 'quarantine' }),
      expect.objectContaining({ ref: 'closed', action: 'prune' }),
    ]);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect(f.events).toHaveLength(events); expect(f.removed).toEqual([]);
  });
  it('corrupt quarantine evidence retains registrations with an operator fallback', () => {
    const f = fixture(); f.run();
    fs.writeFileSync(`${overlayFilePath(f.root, f.env)}.quarantine`, '[{}]');
    expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
    expect(f.deps.alert).toHaveBeenCalledWith(expect.stringContaining('inspect registrations manually'));
  });
});


it('unknown applicability preserves an existing quarantine skip without repeat events', () => {
  const f = fixture(); f.run(); f.run(); f.run();
  const path = `${overlayFilePath(f.root, f.env)}.quarantine`;
  const before = fs.readFileSync(path, 'utf8');
  f.deps.conflictsWithMain = () => null;
  expect(f.run()).toEqual([expect.objectContaining({ action: 'quarantine' })]);
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
  f.deps.conflictsWithMain = () => true;
  expect(f.run()).toEqual([expect.objectContaining({ action: 'quarantine' })]);
  expect(f.events).toHaveLength(1);
  expect(f.deps.publishAttention).toHaveBeenCalledTimes(1);
});

it('oversized quarantine state refuses actions and names the manual fallback', () => {
  const f = fixture(); f.run(); f.run(); f.run();
  const path = `${overlayFilePath(f.root, f.env)}.quarantine`;
  const [record] = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(path, JSON.stringify(Array.from({ length: 101 }, () => record)));
  expect(f.run()).toEqual([]); expect(f.removed).toEqual([]);
  expect(f.deps.alert).toHaveBeenCalledWith(expect.stringContaining('inspect registrations manually'));
});


it('separate quarantines at the same tip receive distinct needs-you identities', () => {
  const f = fixture(); f.run(); f.run(); f.run();
  f.state.overlays[0].addedAt = 're-registered';
  f.run(); f.run(); f.run(); f.run();
  expect(f.deps.publishAttention).toHaveBeenCalledTimes(2);
  const [first, second] = f.deps.publishAttention.mock.calls.map(([item]) => item.head);
  expect(first).not.toBe(second);
  expect(f.events.map(e => e.kind)).toEqual(['overlay-quarantined', 'overlay-quarantine-lifted', 'overlay-quarantined']);
});
