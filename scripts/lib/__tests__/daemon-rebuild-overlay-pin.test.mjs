/**
 * @file scripts/lib/__tests__/daemon-rebuild-overlay-pin.test.mjs
 * @description overlay-pin — live 2026-10-21 11:59 ET (review clone): PR #5793's fixer pushed a new head that
 *   conflicted with other overlays in skills-src/conveyor/review-daemon.mjs. The rebuild dropped the moving overlay,
 *   x9diisp turned that into `established-overlay-hold`, and the WHOLE clone froze on its last good build, so no
 *   unrelated overlay could load. Now a moving overlay whose new tip conflicts stays at the head this clone last
 *   adopted it at (`overlay-pinned`, logged once per new tip) and everything else keeps building and adopting.
 *   These tests drive the real rebuild path (rebuildClone) on real git repos.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';

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

const DAEMON = 'skills-src/conveyor/review-daemon.mjs';
const lines = (over = {}) => `${Array.from({ length: 9 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function fixture() {
  const base = mktemp('we-overlay-pin-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, DAEMON, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  /** Commit `files` on `ref` starting from `from` and (force-)push it — a fixer's push, a rewrite, or a brand-new branch. */
  const push = (ref, from, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', `${ref} ${Object.keys(files).join(',')}`]);
    gitOk(author, ['push', '-q', 'origin', `+HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-overlay-pin-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-overlay-pin-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-overlay-pin-overlay-'),
  };
  // Two live fixes in the review daemon, plus the moving PR (#5793) that starts on an unrelated file.
  const a = push('lane/fix-a', init, { [DAEMON]: lines({ 2: 'fix a' }) });
  const b = push('lane/fix-b', init, { [DAEMON]: lines({ 8: 'fix b' }) });
  const mOld = push('lane/moving', init, { 'moving.txt': 'v1\n' });
  const overlays = [{ ref: 'lane/moving', pr: 5793 }, { ref: 'lane/fix-a', pr: 5801 }, { ref: 'lane/fix-b', pr: 5802 }];
  for (const o of overlays) addOverlay(clone, o, { env });
  const logs = [];
  const smoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 10 }] } }));
  const tick = () => rebuildClone({
    root: clone, env, runSmoke: smoke, prState: async () => 'OPEN', log: { error: (m) => logs.push(m) },
  });
  const head = () => gitOk(clone, ['rev-parse', 'HEAD']).trim();
  const pinnedLogs = () => logs.filter((m) => m.startsWith('daemon-rebuild: overlay-pinned '));
  return { clone, env, init, a, b, mOld, push, tick, head, logs, pinnedLogs, smoke };
}

describe('overlay-pin — a moving overlay whose new tip conflicts stays at its adopted head', () => {
  it.each([
    { name: 'retryable pin first', order: ['lane/a', 'lane/b', 'lane/c'], joint: false },
    { name: 'blocked pin first', order: ['lane/b', 'lane/a', 'lane/c'], joint: false },
    { name: 'two tips must retry together', order: ['lane/a', 'lane/d', 'lane/b', 'lane/c'], joint: true },
    { name: 'all tips advance but still lose C', order: ['lane/b', 'lane/a', 'lane/d', 'lane/c'], joint: true, shadow: true },
  ])('retries moving overlays while retaining a blocked pin: $name (PR #5809)', async ({ order, joint, shadow }) => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
    f.env.WE_DAEMON_OVERLAY_STACK_MODE = 'tops';
    // The reported order is A, B, C, R; also cover reversed pins and a mutually dependent retry subgroup.
    const { removeOverlay } = await import('../daemon-overlays.mjs');
    for (const ref of ['lane/moving', 'lane/fix-a', 'lane/fix-b']) removeOverlay(f.clone, ref, { env: f.env });
    const base = f.push('main', f.init, { 'shared.txt': 'base\n', 'blocked.txt': 'base\n', 'c.txt': 'base\n', ...(joint ? { 'shared-d.txt': 'base\n' } : {}), ...(shadow ? { 'shared-c.txt': 'base\n' } : {}) });
    const a0 = f.push('lane/a', base, { 'a.txt': 'old-A\n' });
    const b0 = f.push('lane/b', base, { 'b.txt': 'B\n' });
    const c0 = f.push('lane/c', base, { 'c.txt': 'old-C\n' });
    const d0 = joint ? f.push('lane/d', base, { 'd.txt': 'old-D\n' }) : null;
    for (const [i, ref] of order.entries()) addOverlay(f.clone, { ref, pr: 5900 + i }, { env: f.env });
    expect(await f.tick()).toMatchObject({ adopted: true });
    for (const sha of [a0, b0, c0]) expect(isAncestor(f.clone, sha, f.head())).toBe(true);

    const main = f.push('main', base, { 'shared.txt': 'main\n', 'blocked.txt': 'main\n', 'c.txt': 'main-C\n', ...(joint ? { 'shared-d.txt': 'main\n' } : {}), ...(shadow ? { 'shared-c.txt': 'main\n' } : {}) });
    const a1 = f.push('lane/a', a0, { 'shared.txt': 'new-A\n', 'a.txt': 'new-A\n', ...(joint ? { 'd.txt': 'new-D\n' } : {}) });
    const b1 = f.push('lane/b', b0, { 'blocked.txt': 'new-B\n', ...(shadow ? { 'z.txt': 'bad\n' } : {}) });
    const d1 = joint ? f.push('lane/d', d0, { 'shared-d.txt': 'new-D\n', 'd.txt': 'new-D\n', 'a.txt': 'new-A\n' }) : null;
    const c1 = f.push('lane/c', c0, { 'c.txt': 'main-C\n', 'a.txt': 'new-A\n', 'c-extra.txt': 'C\n', ...(joint ? { 'd.txt': 'new-D\n' } : {}), ...(shadow ? { 'shared-c.txt': 'new-C\n', 'z.txt': 'good\n' } : {}) });
    const repair = f.push('lane/repair', main, { 'shared.txt': 'base\n', 'repair.txt': 'R\n', ...(joint ? { 'shared-d.txt': 'base\n' } : {}), ...(shadow ? { 'blocked.txt': 'base\n', 'shared-c.txt': 'base\n' } : {}) });
    addOverlay(f.clone, { ref: 'lane/repair', pr: 5910 }, { env: f.env });
    const result = await f.tick();
    expect(result, JSON.stringify(result.alerts)).toMatchObject({ adopted: true });
    expect(result.alerts.map(row => row.kind)).not.toContain('established-overlay-hold');
    for (const sha of [a1, b0, c1, repair]) expect(isAncestor(f.clone, sha, f.head())).toBe(true);
    if (joint) expect(isAncestor(f.clone, d1, f.head())).toBe(true);
    expect(isAncestor(f.clone, b1, f.head())).toBe(false);
    expect(readRebuildState(f.clone, f.env).adopted.applied.find(row => row.ref === 'lane/b')).toMatchObject({ sha: b0, pinnedFrom: b1 });
    expect(readFileSync(join(f.clone, 'a.txt'), 'utf8')).toBe('new-A\n');
    expect(f.smoke).toHaveBeenCalledTimes(2);
  }, 120_000);

  it('replays 11:59 ET: the conflicting new tip is pinned, an unrelated new overlay still adopts, the clone never holds', async () => {
    const f = fixture();
    expect(await f.tick()).toMatchObject({ adopted: true });
    expect(isAncestor(f.clone, f.mOld, f.head())).toBe(true);

    // The fixer's new head rewrites the block both live fixes touch; an unrelated fix is registered at the same time.
    const mNew = f.push('lane/moving', 'origin/lane/moving', { [DAEMON]: lines({ 2: 'm2', 5: 'm5', 8: 'm8' }) });
    const u = f.push('lane/unrelated', f.init, { 'unrelated.txt': 'u\n' });
    addOverlay(f.clone, { ref: 'lane/unrelated', pr: 5810 }, { env: f.env });

    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    const kinds = second.alerts.map((x) => x.kind);
    expect(kinds).not.toContain('established-overlay-hold');
    expect(kinds).not.toContain('established-overlay-dropped');
    expect(kinds).not.toContain('overlay-conflict-unresolved');
    expect(second.alerts.find((x) => x.kind === 'overlay-pinned')?.detail).toMatchObject({
      ref: 'lane/moving', pr: 5793, adopted: f.mOld, newTip: mNew, files: [DAEMON],
    });
    const h = f.head();
    for (const sha of [f.a, f.b, f.mOld, u]) expect(isAncestor(f.clone, sha, h)).toBe(true);
    expect(isAncestor(f.clone, mNew, h)).toBe(false);
    expect(readFileSync(join(f.clone, DAEMON), 'utf8')).toBe(lines({ 2: 'fix a', 8: 'fix b' }));
    expect(readFileSync(join(f.clone, 'moving.txt'), 'utf8')).toBe('v1\n');
    // the new build (pinned content included) was smoked like any other candidate, and the record names the pin
    expect(f.smoke).toHaveBeenCalledTimes(2);
    const st = readRebuildState(f.clone, f.env);
    expect(st.held ?? null).toBeNull();
    expect(st.adopted.applied.find((x) => x.ref === 'lane/moving')).toMatchObject({ sha: f.mOld, pinnedFrom: mNew });
    expect(st.pinnedNotified).toEqual({ 'lane/moving': mNew });
  });

  it('logs overlay-pinned once per new tip, not every tick; a clean new tip then advances and clears the pin', async () => {
    const f = fixture();
    await f.tick();
    const m2 = f.push('lane/moving', 'origin/lane/moving', { [DAEMON]: lines({ 2: 'm2' }) });
    await f.tick();
    const third = await f.tick();
    expect(third.reason).toBe('up-to-date');
    expect(third.alerts.map((x) => x.kind)).not.toContain('overlay-pinned');
    expect(f.pinnedLogs()).toHaveLength(1);

    // another conflicting head (a force-push this time): reported once more, still pinned at the SAME adopted head
    const m3 = f.push('lane/moving', f.init, { [DAEMON]: lines({ 8: 'm3' }), 'moving.txt': 'v3\n' });
    const fourth = await f.tick();
    expect(fourth.alerts.find((x) => x.kind === 'overlay-pinned')?.detail).toMatchObject({ adopted: f.mOld, newTip: m3 });
    await f.tick();
    expect(f.pinnedLogs()).toHaveLength(2);
    expect(f.pinnedLogs()[0]).toContain(m2);

    // the fixer merges the live fixes in: the clean new tip is adopted (after its smoke) and the pin record clears
    gitOk(dirname(f.clone) + '/author', ['fetch', '-q', 'origin']);
    const clean = f.push('lane/moving', f.init, { [DAEMON]: lines({ 2: 'fix a', 5: 'm5', 8: 'fix b' }), 'moving.txt': 'v4\n' });
    const smokesBefore = f.smoke.mock.calls.length;
    const fifth = await f.tick();
    expect(fifth, JSON.stringify(fifth.alerts)).toMatchObject({ adopted: true });
    expect(f.smoke.mock.calls.length).toBe(smokesBefore + 1);
    expect(isAncestor(f.clone, clean, f.head())).toBe(true);
    expect(fifth.alerts.map((x) => x.kind)).not.toContain('overlay-pinned');
    expect(readRebuildState(f.clone, f.env).pinnedNotified ?? null).toBeNull();
  });

  it('a stack base contained only in the NEW tip of a pinned top is brought back, never lost (Codex audit)', async () => {
    const f = fixture();
    const base = f.push('lane/base', f.init, { 'base.txt': 'LIVE\n' });
    addOverlay(f.clone, { ref: 'lane/base', pr: 5830 }, { env: f.env });
    expect(await f.tick()).toMatchObject({ adopted: true });
    expect(isAncestor(f.clone, base, f.head())).toBe(true);
    // the moving branch is rebuilt ON the base (so the base looks contained in it) and conflicts with the live fixes
    f.push('lane/moving', base, { [DAEMON]: lines({ 2: 'm2', 8: 'm8' }), 'moving.txt': 'v2\n' });
    const second = await f.tick();
    expect(second.alerts.find((x) => x.kind === 'overlay-pinned')?.detail).toMatchObject({ ref: 'lane/moving', adopted: f.mOld });
    expect(isAncestor(f.clone, base, f.head())).toBe(true);
    expect(readFileSync(join(f.clone, 'base.txt'), 'utf8')).toBe('LIVE\n');
  });

  it('a clean new tip of a moving overlay just advances (no pin)', async () => {
    const f = fixture();
    await f.tick();
    const m2 = f.push('lane/moving', 'origin/lane/moving', { 'moving.txt': 'v2\n' });
    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    expect(second.alerts.map((x) => x.kind)).not.toContain('overlay-pinned');
    expect(isAncestor(f.clone, m2, f.head())).toBe(true);
  });

  it('a brand-new overlay that conflicts has no adopted head: it is set aside and the clone keeps building', async () => {
    const f = fixture();
    await f.tick();
    const live = f.head();
    f.push('lane/brand-new', f.init, { [DAEMON]: lines({ 2: 'n2' }) });
    addOverlay(f.clone, { ref: 'lane/brand-new', pr: 5820 }, { env: f.env });
    const u = f.push('lane/unrelated', f.init, { 'unrelated.txt': 'u\n' });
    addOverlay(f.clone, { ref: 'lane/unrelated', pr: 5821 }, { env: f.env });
    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    const kinds = second.alerts.map((x) => x.kind);
    expect(kinds).toContain('overlay-conflict-dropped');
    expect(kinds).not.toContain('overlay-pinned');
    expect(kinds).not.toContain('established-overlay-hold');
    expect(isAncestor(f.clone, live, f.head())).toBe(true);
    expect(isAncestor(f.clone, u, f.head())).toBe(true);
    expect(readRebuildState(f.clone, f.env).held ?? null).toBeNull();
  });
});
