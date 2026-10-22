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
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });
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
  const push = (ref, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, 'origin/main']);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
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
  return { clone, env, rebuild, load };
}

describe('daemon-load-overlay runs daemon-overlay add\'s conflict guard before registering', () => {
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

  it('a check that cannot run (ref missing on origin) refuses — fail closed', async () => {
    const f = fixture();
    const r = await f.load({ ref: 'lane/does-not-exist' });
    expect(r).toMatchObject({ registered: false, refused: true, reason: 'conflict-check-failed' });
    expect(readOverlays(f.clone, { env: f.env }).map((o) => o.ref)).toEqual(['lane/fix-procedure']);
  });
});
