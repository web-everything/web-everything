import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planOverlayPrune, pruneOverlays, resolveOverlayPrune } from '../overlay-prune.mjs';
import { kickOverlayMainSync } from '../overlay-main-sync.mjs';
import { addOverlay, readOverlayState, overlayFilePath } from '../../daemon-overlays.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), main = 'c'.repeat(40);
const base = overrides => ({ overlays: [{ ref: 'old', pr: 0 }], mainSha: main, prState: () => null,
  openPrHeads: () => [], tipOf: () => a, isAncestor: () => false, conflictsWithMain: () => false, ...overrides });
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'overlay-prune-')); dirs.push(root);
  const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'no-prefs') };
  const state = { overlays: [{ ref: 'old', pr: 0, pinned: true }], corrupt: false };
  const events = [], removed = [];
  const deps = { resolveSetting: () => ({ enabled: true }), readOverlayState: () => state,
    mainSha: main, openPrHeads: () => [], tipOf: () => a, isAncestor: () => false,
    conflictsWithMain: () => true, prState: () => null, alert: vi.fn(),
    removeOverlay: (root, ref, options) => { removed.push({ ref, options }); state.overlays = state.overlays.filter(o => o.ref !== ref); return { removed: true }; },
    appendOverlayEvent: (root, event) => events.push(event), ...overrides };
  const run = (extra = {}) => pruneOverlays({ root, env, deps, ...extra });
  const file = `${overlayFilePath(root, env)}.prune-state`;
  return { root, env, state, deps, run, file, events, removed };
}

describe('overlay prune planner', () => {
  it.each([['CLOSED', 'pr-closed'], ['MERGED', 'pr-merged']])('prunes confirmed %s (including pinned)', (state, reason) => {
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old', pr: 7, pinned: true }], prState: () => state })))
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
  it('keeps an ancestor whose only successor is pruned for repeated conflicts', () => {
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
    expect(planOverlayPrune(base({ overlays: [{ ref: 'old' }, { ref: 'new', pr: 7 }], prState: () => 'CLOSED',
      tipOf: ref => ref === 'old' ? a : b, openPrHeads: () => [{ ref: 'live', number: 8, headSha: top }],
      isAncestor: (x, y) => order.indexOf(x) < order.indexOf(y) })))
      .toEqual([
        expect.objectContaining({ ref: 'old', reason: 'superseded', supersededBy: 'live', supersedingTip: top }),
        expect.objectContaining({ ref: 'new', reason: 'pr-closed' }),
      ]);
  });
  it('supersedes an ancestor with a different open PR head, including equal tips', () => {
    for (const headSha of [a, b]) expect(planOverlayPrune(base({ openPrHeads: () => [{ number: 8, ref: 'new', headSha }], isAncestor: () => true })))
      .toEqual([expect.objectContaining({ reason: 'superseded', supersededBy: 'new' })]);
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
  it('persists rebuild conflicts, then prunes on the third and emits reason and tip', () => {
    const f = fixture();
    expect(f.run()).toEqual([]); expect(f.run()).toEqual([]);
    expect(f.run()).toEqual([expect.objectContaining({ reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(f.events).toEqual([expect.objectContaining({ kind: 'overlay-pruned', reason: 'pr0-conflicting', tip: a })]);
    expect(f.removed[0].options.expectedOverlay.pinned).toBe(true);
  });
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('prototype-named ref %s preserves valid counters and unrelated pruning', ref => {
    const f = fixture({ tipOf: name => name === ref ? a : b });
    f.state.overlays = [{ ref, pr: 0 }];
    expect(f.run()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ [ref]: 1 });
    f.state.overlays.push({ ref: 'unrelated', pr: 0 });
    expect(f.run()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ [ref]: 2, unrelated: 1 });
    expect(f.run()).toEqual([expect.objectContaining({ ref, reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ unrelated: 2 });
    expect(f.run()).toEqual([expect.objectContaining({ ref: 'unrelated', reason: 'pr0-conflicting', conflictCount: 3 })]);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({});
    // A parsed empty sidecar must behave like the initially missing sidecar.
    f.state.overlays = [{ ref, pr: 0 }];
    expect(f.run()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ [ref]: 1 });
    expect(f.deps.alert).not.toHaveBeenCalled();
  });
  it('resets counts when clean or unregistered', () => {
    const f = fixture(); f.run(); f.run();
    f.deps.conflictsWithMain = () => false; f.run();
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ old: 0 });
    f.deps.conflictsWithMain = () => true; expect(f.run()).toEqual([]);
    f.state.overlays = []; f.run(); expect(fs.existsSync(f.file)).toBe(false);
    f.state.overlays = [{ ref: 'old' }]; expect(f.run()).toEqual([]);
  });
  it('does not advance counters during main sync', () => {
    const f = fixture({ countConflicts: false }); f.run(); f.run(); f.run();
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ old: 0 });
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
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ old: 0 });
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
    addOverlay(f.root, { ref: 'old', pr: 7, pinned: true }, { env: f.env });
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
