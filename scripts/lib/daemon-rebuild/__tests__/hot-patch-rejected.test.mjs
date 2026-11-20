/** R3.9: a rolled-back patch must never return through main-sync. */
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { finalizeRebuild } from '../adopt.mjs';
import { rollbackToGood } from '../rebuild.mjs';
import { writeRebuildState, readRebuildState } from '../state.mjs';
import { runHotPatchTick, hotPatchLedgerPath, HOT_PATCH_ALLOWLIST, HOT_PATCH_OVERLAY_REASON } from '../../hot-patch.mjs';

it.each(['merge', 'squash', 'unreadable'])('R3.9 after rollback, %s rejection evidence refuses adoption with HEAD unchanged and needs-you event', async mode => {
  const home = mkdtempSync(join(tmpdir(), 'hot-patch-rejected-'));
  const root = join(home, 'clone');
  mkdirSync(root);
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(home, 'state'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(home, 'locks'), WE_DAEMON_OVERLAY_DIR: join(home, 'overlays'),
    WE_DAEMON_EVENTS: join(home, 'events.jsonl') };
  const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { ...opts, cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  const git = args => { const r = run(args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  try {
    git(['init', '-q', '-b', 'main']);
    const path = join(root, HOT_PATCH_ALLOWLIST[0]);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '// base\n');
    git(['add', '.']); git(['commit', '-qm', 'base']);
    const good = git(['rev-parse', 'HEAD']);
    git(['checkout', '-qb', 'lane/repair']);
    writeFileSync(path, '// patch\n'); git(['commit', '-qam', 'patch']);
    const sha = git(['rev-parse', 'HEAD']);
    git(['checkout', 'main']); git(['merge', '--no-ff', 'lane/repair', '-m', 'merge rejected patch']);
    let merged = git(['rev-parse', 'HEAD']);
    if (mode === 'squash') {
      git(['reset', '--hard', good]);
      git(['cherry-pick', '--no-commit', sha]);
      git(['commit', '-qm', 'equivalent squash on main']);
      merged = git(['rev-parse', 'HEAD']);
      expect(merged).not.toBe(sha);
    }
    git(['reset', '--hard', sha]);
    const preGood = { head: good, mainSha: good, inputsKey: 'c'.repeat(40), applied: [] };
    writeRebuildState(root, { adopted: { head: sha, mainSha: good, inputsKey: 'd'.repeat(40), applied: [] } }, env);
    mkdirSync(env.WE_DAEMON_STATE_DIR, { recursive: true });
    const overlay = { ref: `hotpatch/${sha}`, pr: 42, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
      addedAt: new Date().toISOString(), addedBy: null };
    writeFileSync(hotPatchLedgerPath(env), JSON.stringify({ sha, pr: 42, branch: overlay.ref, prBranch: 'lane/repair', root,
      requestPid: process.pid, requestStart: 1, loadedAt: overlay.addedAt, overlay, preGood }));
    let overlays = [overlay];
    await runHotPatchTick({ root, env, startTimeOf: () => 2,
      // The real rollback finalizer owns the clone lock; the tick still takes its global ledger lock.
      lock: async (_root, fn) => fn(() => true),
      ciVerdict: async () => ({ state: 'red', reason: 'daemon-soak failed' }),
      prState: async () => { throw Error('red needs no PR read'); },
      readOverlays: () => overlays, removeOverlay: async () => { overlays = []; },
      rollbackToGood: (good, context) => rollbackToGood({ root, env, run, good, expectHead: context.expectHead }),
    });
    expect(git(['rev-parse', 'HEAD'])).toBe(good);
    if (mode === 'unreadable') writeFileSync(join(env.WE_DAEMON_STATE_DIR, 'hot-patch-rejected.json'), '{bad');
    git(['update-ref', 'refs/remotes/origin/main', merged]);
    const result = await finalizeRebuild({ root, env, run, now: Date.now,
      prevHead: good, lease: { token: 'main-sync-after-rollback' },
      plan: { ok: true, finalSha: merged, mainSha: merged, inputsKey: 'e'.repeat(40), applied: [] } });
    expect(result.reason).toBe('hot-patch-rejected');
    expect(result.moved).toBe(false);
    expect(result.adopted).not.toBe(true);
    expect(git(['rev-parse', 'HEAD'])).toBe(good);
    expect(readRebuildState(root, env).adopted.head).toBe(good);
    expect(existsSync(env.WE_DAEMON_EVENTS)).toBe(true);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/"kind":"hot-patch-needs-you"/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
