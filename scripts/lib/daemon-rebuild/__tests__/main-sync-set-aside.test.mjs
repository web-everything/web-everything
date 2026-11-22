import { it, expect } from 'vitest';
import * as planner from '../plan.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { overlayFilePath } from '../../daemon-overlays.mjs';
import { readRebuildStateStrict, rebuildStatePath } from '../state.mjs';
import { createSetAsideFixture, probeRebuildSetAside } from '../../../conveyor/soak/fixtures/rebuild-set-aside-probe.mjs';

// Negative cases come first: the new policy must retain the old refusal/hold protections.
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
      overlays: f.overlays(), edgeResolve: false, mainSyncConflicts: { [f.ref]: f.tip } });
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

it('preserves the audit identity when an established overlay is set aside', async () => {
  const f = await createSetAsideFixture({ audited: true });
  try {
    const result = await f.rebuild();
    expect(result.adopted).toBe(true);
    expect(f.git(['merge-base', '--is-ancestor', f.main, f.head()]).status).toBe(0);
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
    await f.rebuild();
    expect(readRebuildStateStrict(f.root, f.env).setAside[f.ref].files).toEqual([f.file]);
    const broken = JSON.parse(readFileSync(path, 'utf8'));
    broken.setAside[f.ref].files = [];
    writeFileSync(path, JSON.stringify(broken));
    expect(() => readRebuildStateStrict(f.root, f.env)).toThrow('Invalid rebuild state setAside');
  } finally { f.cleanup(); }
}, 60_000);
