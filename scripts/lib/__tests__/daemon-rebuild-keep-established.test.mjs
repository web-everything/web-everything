/**
 * @file scripts/lib/__tests__/daemon-rebuild-keep-established.test.mjs
 * @description x5059uu — a rebuild keeps the overlays already in the running build ("established") and parks the
 *   newcomer that conflicts with them. Live 2026-10-09 19:54:32Z on wev-control: #4643 (registered FIRST) pushed a
 *   new commit that conflicted on skills-src/conveyor/build-dispatch-daemon.mjs with the live, proven overlays #4658
 *   and #4663; the rebuild applied #4643 first (list order) and conflict-dropped #4658/#4663, so prepares stopped
 *   until they were re-adopted at 20:19Z. These tests replay that sequence through the real rebuild path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild, rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { gitRun } from '../main-staleness.mjs';
import { readOverlayConflictWakes } from '../overlay-conflict-wake.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };
const isAncestor = (cwd, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;

const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
const lines = (over = {}) => `${Array.from({ length: 9 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function fixture() {
  const base = mktemp('we-keep-established-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, DAEMON, lines());
  write(clone, 'scripts/worker.mjs', 'old\n');
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(clone, ['fetch', '-q', 'origin']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const push = (ref, from, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-keep-est-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-keep-est-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-keep-est-overlay-'),
  };
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  // Registration order is the live order: #4643 first, then #4658, then #4663.
  const cOld = push('lane/c', init, { 'other.txt': 'c\n' });
  const p = push('lane/prepare-launch-stall', init, { [DAEMON]: lines({ 2: 'prepare launches' }) });
  const h = push('lane/ruled-hold-release', init, { [DAEMON]: lines({ 8: 'ruled hold release' }) });
  const overlays = [
    { ref: 'lane/c', pr: 4643 }, { ref: 'lane/prepare-launch-stall', pr: 4658 }, { ref: 'lane/ruled-hold-release', pr: 4663 },
  ];
  /** #4643's new commit rewrites the block both established overlays touch. */
  const pushNewcomer = () => push('lane/c', 'origin/lane/c', { [DAEMON]: lines({ 2: 'c2', 5: 'c5', 8: 'c8' }) });
  gitOk(clone, ['fetch', '-q', 'origin']);
  const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, env: { ...env, ...opts.env } });
  return { clone, env, init, cOld, p, h, overlays, pushNewcomer, runGit, push };
}

const passSmoke = () => vi.fn(async () => ({
  verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 148_000 }, { name: 'lane-acquire-release', ok: true, ms: 32_000 }] },
}));

describe('x5059uu — rebuild keeps established overlays and parks the conflicting newcomer', () => {
  it('replays 19:54:32Z: #4658/#4663 stay in HEAD, #4643\'s new head is parked with the conflicting file named', async () => {
    const f = fixture();
    for (const o of f.overlays) addOverlay(f.clone, o, { env: f.env });
    const logs = [];
    const first = await rebuildClone({
      root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN', log: { error: (m) => logs.push(m) },
    });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
    const liveHead = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    for (const sha of [f.cOld, f.p, f.h]) expect(isAncestor(f.clone, sha, liveHead)).toBe(true);

    const cNew = f.pushNewcomer();
    const smoke = passSmoke();
    const second = await rebuildClone({
      root: f.clone, env: f.env, runSmoke: smoke, prState: async () => 'OPEN', log: { error: (m) => logs.push(m) },
    });
    const head = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    expect(isAncestor(f.clone, f.p, head)).toBe(true);
    expect(isAncestor(f.clone, f.h, head)).toBe(true);
    expect(isAncestor(f.clone, cNew, head)).toBe(false);
    const kinds = second.alerts.map((a) => a.kind);
    // overlay-pin (2026-10-21): c's new head conflicts, so c is PINNED at the head this clone adopted it at (its
    // already-live other.txt change is kept) and the build still advances — no established-overlay-hold.
    expect(kinds).not.toContain('established-overlay-dropped');
    expect(kinds).not.toContain('established-overlay-hold');
    expect(second.alerts.find((a) => a.kind === 'overlay-pinned')?.detail).toMatchObject({
      ref: 'lane/c', pr: 4643, adopted: f.cOld, newTip: cNew, files: [DAEMON],
    });
    expect(isAncestor(f.clone, f.cOld, head)).toBe(true);
    expect(readFileSync(join(f.clone, 'other.txt'), 'utf8')).toBe('c\n');
    // the newcomer's PR is woken so its author resolves the conflict (merge the established branches in)
    expect(readOverlayConflictWakes(f.env, { maxAgeMs: Infinity }).get(4643)).toMatchObject({ ref: 'lane/c', files: [DAEMON] });
    // The first build still smoked: per-step timings are logged on every smoke, fast or slow.
    expect(logs.some((m) => m.includes('smoke-timings') && m.includes('reconcile-dry-run:148000ms'))).toBe(true);
  });

  it('planRebuild: an overlay already in the running HEAD applies before a changed one, whatever the list order', async () => {
    const f = fixture();
    const established = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: f.overlays });
    expect(established.applied.map((a) => a.ref)).toEqual(f.overlays.map((o) => o.ref));
    f.pushNewcomer();
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({ git: f.runGit, headSha: established.finalSha, mainRef: 'origin/main', overlays: f.overlays });
    expect(plan.ok).toBe(true);
    // the changed lane/c goes last and, its new head conflicting, is pinned at the head the running build adopted
    expect(plan.applied.map((a) => [a.ref, a.sha])).toEqual([['lane/prepare-launch-stall', f.p], ['lane/ruled-hold-release', f.h], ['lane/c', f.cOld]]);
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'apply', reason: 'applied-pinned', sha: f.cOld });
    expect(plan.establishedLost).toEqual([]);
  });

  it('dropping an ESTABLISHED overlay is never silent: it raises established-overlay-dropped', async () => {
    const f = fixture();
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: f.overlays.slice(1) });
    // main itself moves onto the block #4658 edits — nobody to park, so the established overlay must drop loudly
    const author = join(dirname(f.clone), 'author');
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(author, DAEMON, lines({ 2: 'main moved' }));
    gitOk(author, ['commit', '-q', '-am', 'main']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({ git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: f.overlays.slice(1) });
    const loud = plan.alerts.find((a) => a.kind === 'established-overlay-dropped');
    expect(loud?.detail).toMatchObject({ ref: 'lane/prepare-launch-stall', pr: 4658, files: [DAEMON] });
    expect(plan.applied.map((a) => a.ref)).toEqual(['lane/ruled-hold-release']);
    expect(plan.establishedLost).toEqual([expect.objectContaining({ ref: 'lane/prepare-launch-stall', pr: 4658, reason: 'conflict', files: [DAEMON] })]);
  });

  // x9diisp — live 2026-10-20T11:51Z (review clone): main graduated hotfixes the running build carried as overlays,
  // every stacked overlay then conflicted with main, and the rebuild built + adopted plain main (all hotfixes lost).
  it('main moving onto a LIVE overlay HOLDS the clone on its last-good build instead of building without it', async () => {
    const f = fixture();
    for (const o of f.overlays.slice(1)) addOverlay(f.clone, o, { env: f.env });
    const first = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
    const liveHead = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();

    const author = join(dirname(f.clone), 'author');
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(author, DAEMON, lines({ 2: 'main graduated it differently' }));
    gitOk(author, ['commit', '-q', '-am', 'graduate']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);

    const { dryRunRebuild } = await import('../daemon-rebuild.mjs');
    const dry = await dryRunRebuild({ root: f.clone, env: f.env, prState: async () => 'OPEN' });
    expect(dry.wouldDo).toBe('hold (established-overlay-conflict)');
    const smoke = passSmoke();
    const second = await rebuildClone({ root: f.clone, env: f.env, runSmoke: smoke, prState: async () => 'OPEN' });
    expect(second.moved).toBe(false);
    expect(second.reason).toBe('established-overlay-conflict');
    expect(smoke).not.toHaveBeenCalled();
    expect(gitOk(f.clone, ['rev-parse', 'HEAD']).trim()).toBe(liveHead);
    const hold = second.alerts.find((a) => a.kind === 'established-overlay-hold');
    expect(hold?.detail.refs).toEqual(['lane/prepare-launch-stall']);
    const { readRebuildState } = await import('../daemon-rebuild/state.mjs');
    expect(readRebuildState(f.clone, f.env).held).toMatchObject({ reason: 'established-overlay-conflict', lastGood: liveHead });
    const { readOverlays } = await import('../daemon-overlays.mjs');
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/prepare-launch-stall', 'lane/ruled-hold-release']);

    // The overlay's author resolves its conflict with main: the next rebuild builds, adopts, clears the hold.
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'lane/prepare-launch-stall', 'origin/lane/prepare-launch-stall']);
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'origin/main'], { cwd: author });
    write(author, DAEMON, lines({ 2: 'prepare launches + main' }));
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', 'merge main']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/lane/prepare-launch-stall']);
    const third = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(third, JSON.stringify(third.alerts)).toMatchObject({ adopted: true });
    expect(readRebuildState(f.clone, f.env).held ?? null).toBeNull();
  });

  it.each([
    { tip: 'fast-forward', pr: null, release: 'reconciled' },
    { tip: 'rewritten', pr: 5004, release: 'reconciled' },
    { tip: 'fast-forward', pr: 5005, release: 'retired' },
  ])('keeps the hold after a $tip docs-only push until the hotfix is $release', async ({ tip, pr, release }) => {
    const f = fixture();
    const ref = 'lane/live';
    const worker = 'scripts/worker.mjs';
    // An ordinary, unpinned overlay: the mechanism pin must not be what saves it.
    f.push(ref, f.init, { [worker]: 'hotfix\n' });
    addOverlay(f.clone, { ref, pr }, { env: f.env });
    const first = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
    const liveHead = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    f.push('main', f.init, { [worker]: 'main rewrite\n' });
    const held = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(held.reason).toBe('established-overlay-conflict');

    const author = join(dirname(f.clone), 'author');
    if (tip === 'fast-forward') {
      f.push(ref, `origin/${ref}`, { 'README.md': 'documentation only\n' });
    } else {
      // A force-pushed replacement has the same live hotfix but no ancestry link to its old tip.
      gitOk(author, ['checkout', '-q', '-B', ref, f.init]);
      write(author, worker, 'hotfix\n');
      write(author, 'README.md', 'documentation only\n');
      gitOk(author, ['add', '-A']);
      gitOk(author, ['commit', '-q', '-m', 'rewritten hotfix plus docs']);
      gitOk(author, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
    }
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    expect(isAncestor(f.clone, `origin/${ref}`, liveHead)).toBe(false);
    const plan = await planRebuild({ git: f.runGit, headSha: liveHead, mainRef: 'origin/main', overlays: [{ ref, pr }] });
    expect(plan.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(plan.establishedLost).toEqual([expect.objectContaining({ ref, pr, files: [worker] })]);
    const { dryRunRebuild } = await import('../daemon-rebuild.mjs');
    const dry = await dryRunRebuild({ root: f.clone, env: f.env, prState: async () => 'OPEN' });
    expect(dry.unsafe.safe).toBe(true);
    expect(dry.plan.establishedLost).toEqual([expect.objectContaining({ ref, pr, files: [worker] })]);
    expect(dry.wouldDo).toBe('hold (established-overlay-conflict)');
    const smoke = passSmoke();
    const second = await rebuildClone({ root: f.clone, env: f.env, runSmoke: smoke, prState: async () => 'OPEN' });
    expect(second).toMatchObject({ moved: false, reason: 'established-overlay-conflict' });
    expect(smoke).not.toHaveBeenCalled();
    expect(gitOk(f.clone, ['rev-parse', 'HEAD']).trim()).toBe(liveHead);
    expect(readFileSync(join(f.clone, worker), 'utf8')).toBe('hotfix\n');
    const { readRebuildState } = await import('../daemon-rebuild/state.mjs');
    expect(readRebuildState(f.clone, f.env).held).toMatchObject({ reason: 'established-overlay-conflict', lastGood: liveHead });

    if (release === 'retired') {
      const { removeOverlay } = await import('../daemon-overlays.mjs');
      removeOverlay(f.clone, ref, { env: f.env, why: 'operator retired the hotfix' });
      const retired = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
      expect(retired, JSON.stringify(retired.alerts)).toMatchObject({ adopted: true });
      expect(readFileSync(join(f.clone, worker), 'utf8')).toBe('main rewrite\n');
      expect(readRebuildState(f.clone, f.env).held ?? null).toBeNull();
      return;
    }

    // Reconcile the hotfix with main: advancing the tip is insufficient, a clean merge is sufficient.
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, `origin/${ref}`]);
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'origin/main'], { cwd: author });
    write(author, worker, 'hotfix + main rewrite\n');
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', 'reconcile main']);
    gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
    const released = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(released, JSON.stringify(released.alerts)).toMatchObject({ adopted: true });
    expect(readFileSync(join(f.clone, worker), 'utf8')).toBe('hotfix + main rewrite\n');
    expect(readRebuildState(f.clone, f.env).held ?? null).toBeNull();
  });

  it('dry run still refuses unpublished local work above a recorded adopted build', async () => {
    const f = fixture();
    addOverlay(f.clone, f.overlays[1], { env: f.env });
    const first = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
    write(f.clone, 'local.txt', 'unpublished work\n');
    gitOk(f.clone, ['add', 'local.txt']);
    gitOk(f.clone, ['commit', '-q', '-m', 'local work']);
    const localHead = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();

    const { dryRunRebuild } = await import('../daemon-rebuild.mjs');
    const dry = await dryRunRebuild({ root: f.clone, env: f.env, prState: async () => 'OPEN' });
    expect(dry.unsafe).toMatchObject({ safe: false, reason: 'local-commits', detail: [localHead] });
    expect(dry.wouldDo).toBe('refuse');
    expect(gitOk(f.clone, ['rev-parse', 'HEAD']).trim()).toBe(localHead);
  });

  it('protects only the current build and overlay identity, and permits graduation and explicit retirement', async () => {
    const f = fixture();
    const ref = 'lane/live';
    const worker = 'scripts/worker.mjs';
    const original = f.push(ref, f.init, { [worker]: 'hotfix\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref, pr: 5004 }] });
    f.push(ref, `origin/${ref}`, { 'README.md': 'docs only\n' });
    f.push('main', f.init, { [worker]: 'main rewrite\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const options = { git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: [{ ref, pr: 5004 }] };
    const conflicting = await planRebuild(options);
    expect(conflicting.establishedLost.map((o) => o.ref)).toEqual([ref]);
    const unreadable = await planRebuild({ ...options, git: (args, opts) => args[0] === 'log'
      ? { status: 1, stdout: '', stderr: 'history unavailable' } : f.runGit(args, opts) });
    expect(unreadable.establishedLost.map((o) => o.ref)).toEqual([ref]);

    // Branch reuse by a new PR and a fresh current build must not inherit a previous build's protection.
    const reused = await planRebuild({ ...options, overlays: [{ ref, pr: 5006 }] });
    expect(reused.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(reused.establishedLost).toEqual([]);
    gitOk(f.clone, ['update-ref', 'HEAD', live.finalSha]);
    gitOk(f.clone, ['update-ref', 'HEAD', f.init]);
    const pastBuild = await planRebuild({ ...options, headSha: f.init });
    expect(pastBuild.establishedLost).toEqual([]);
    for (const state of ['MERGED', 'CLOSED']) {
      const retired = await planRebuild({ ...options, prState: async () => state });
      expect(retired.decisions).toContainEqual(expect.objectContaining({ ref, action: 'remove' }));
      expect(retired.establishedLost).toEqual([]);
    }
    expect((await planRebuild({ ...options, mainOnly: true })).establishedLost).toEqual([]);

    // Main graduates the old tip, but a later overlay change still conflicts. Only the new change is lost.
    const graduatedMain = f.push('lane/graduated-main', original, { [worker]: 'main follow-up\n' });
    const author = join(dirname(f.clone), 'author');
    gitOk(author, ['checkout', '-q', '-B', ref, `origin/${ref}`]);
    write(author, worker, 'new unproven hotfix\n');
    gitOk(author, ['commit', '-q', '-am', 'new conflicting change']);
    gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const graduated = await planRebuild({ ...options, mainRef: graduatedMain });
    expect(graduated.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(graduated.establishedLost).toEqual([]);
  });

  it('protects a docs-advanced stack base carried only through a retired top, but permits a surviving carrier', async () => {
    const f = fixture();
    const ref = 'lane/base';
    const worker = 'scripts/worker.mjs';
    const oldBase = f.push(ref, f.init, { [worker]: 'hotfix\n' });
    f.push('lane/top', oldBase, { 'top.txt': 'top\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref }, { ref: 'lane/top' }] });
    expect(live.decisions).toContainEqual(expect.objectContaining({ ref, action: 'skip', reason: 'stack-contained' }));
    expect(live.applied.map((o) => o.ref)).toEqual(['lane/top']);
    f.push(ref, `origin/${ref}`, { 'README.md': 'docs only\n' });
    const movedMain = f.push('main', f.init, { [worker]: 'main rewrite\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const options = { git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: [{ ref }] };
    // The operator retires the top, leaving the base registered. The base's carried hotfix must survive.
    const lost = await planRebuild(options);
    expect(lost.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(lost.establishedLost.map((o) => o.ref)).toEqual([ref]);

    // A sibling can preserve the old base while disagreeing with the base's newer change.
    f.push('lane/carrier', oldBase, { [worker]: 'carrier hotfix\n' });
    f.push(ref, `origin/${ref}`, { [worker]: 'new base hotfix\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const survives = await planRebuild({ ...options, mainRef: f.init, overlays: [{ ref: 'lane/carrier' }, { ref }], stackMode: 'independent' });
    expect(survives.applied.map((o) => o.ref)).toEqual(['lane/carrier']);
    expect(survives.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(survives.establishedLost).toEqual([]);
    expect(isAncestor(f.clone, oldBase, survives.finalSha)).toBe(true);
    expect(isAncestor(f.clone, movedMain, survives.finalSha)).toBe(false);
  });

  // x9diisp (Codex finding on #5757) — an ESTABLISHED current tip entered the build through a stack top that was then
  // retired. Another carrier preserves only the OLDER recorded tip of the same overlay. That must not clear the hold:
  // the newer tip's live changes would be dropped.
  it('keeps the hold for an established newer tip carried through a retired top when a carrier keeps only the older tip', async () => {
    const f = fixture();
    const ref = 'lane/base';
    const worker = 'scripts/worker.mjs';
    const oldBase = f.push(ref, f.init, { 'a.txt': 'older hotfix\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    // The running build recorded the base at its OLDER tip.
    const recorded = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref, pr: 5004 }] });
    expect(recorded.applied.map((o) => o.ref)).toEqual([ref]);
    // The base's NEWER tip then entered the build only through a top (since retired).
    const newBase = f.push(ref, `origin/${ref}`, { [worker]: 'newer live hotfix\n' });
    const top = f.push('lane/top', newBase, { 'top.txt': 'top\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const tree = gitOk(f.clone, ['merge-tree', '--write-tree', recorded.finalSha, top]).split('\n')[0].trim();
    const head = gitOk(f.clone, ['commit-tree', tree, '-p', recorded.finalSha, '-p', top, '-m', 'merge top']).trim();
    expect(isAncestor(f.clone, newBase, head)).toBe(true);
    // Another carrier keeps the older tip only; main now rewrites the file the newer tip changed.
    f.push('lane/carrier', oldBase, { 'c.txt': 'carrier\n' });
    f.push('main', f.init, { [worker]: 'main rewrite\n' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: head, mainRef: 'origin/main', overlays: [{ ref: 'lane/carrier' }, { ref, pr: 5004 }],
    });
    expect(plan.applied.map((o) => o.ref)).toEqual(['lane/carrier']);
    expect(plan.decisions).toContainEqual(expect.objectContaining({ ref, action: 'drop', reason: 'conflict' }));
    expect(isAncestor(f.clone, oldBase, plan.finalSha)).toBe(true);
    expect(isAncestor(f.clone, newBase, plan.finalSha)).toBe(false);
    expect(plan.establishedLost).toEqual([expect.objectContaining({ ref, pr: 5004, reason: 'conflict' })]);
  });

  // x9diisp — the attributed smoke fallback (set the culprit aside, keep the rest) replans without the culprit. Here the
  // culprit's change is what let the LIVE overlay apply (main moved onto the overlay's block; the culprit carries the
  // resolution), so replanning without it would drop that live overlay, smoke clean and adopt the tree without it.
  it('attributed smoke fallback is refused when setting the culprit aside would lose an established overlay', async () => {
    const f = fixture();
    const BAD = 'scripts/conveyor/bad.mjs';
    f.push('lane/live-y', f.init, { [DAEMON]: lines({ 2: 'Y2', 5: 'Y5' }) });
    f.push('lane/good', f.init, { 'good.txt': 'good\n' });
    for (const ref of ['lane/live-y', 'lane/good']) addOverlay(f.clone, { ref, pr: ref === 'lane/live-y' ? 5001 : 5002 }, { env: f.env });
    const first = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });

    // main moves onto the live overlay's block; the culprit (registered after) carries the resolution of line 2
    const author = join(dirname(f.clone), 'author');
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(author, DAEMON, lines({ 2: 'M2' }));
    gitOk(author, ['commit', '-q', '-am', 'main moved']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    f.push('lane/culprit', 'origin/main', { [DAEMON]: lines({ 2: 'Y2' }), [BAD]: 'bad\n' });
    addOverlay(f.clone, { ref: 'lane/culprit', pr: 5003 }, { env: f.env });

    const runSmoke = vi.fn(async ({ root }) => (existsSync(join(root, BAD))
      ? { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', mayBeTransient: false, detail: `exited 1: file://${root}/${BAD}:20` }] } }
      : { verdict: 'pass', attempts: 1, smoke: { results: [] } }));
    const second = await rebuildClone({ root: f.clone, env: f.env, runSmoke, prState: async () => 'OPEN' });

    expect(second.reason).not.toBe('overlay-set-aside');
    const kinds = second.alerts.map((a) => a.kind);
    expect(kinds).not.toContain('overlay-set-aside-attributed');
    const refused = second.alerts.find((a) => a.kind === 'overlay-set-aside-failed');
    expect(refused?.detail.failed).toBe('established-overlay-conflict: lane/live-y');
    expect(refused.detail.culprits.map((c) => c.ref)).toEqual(['lane/culprit']);
    // only the failed candidate (A) and the later plain-main comparison were smoked — never the culprit-less tree
    expect(runSmoke).toHaveBeenCalledTimes(2);
  });
});
