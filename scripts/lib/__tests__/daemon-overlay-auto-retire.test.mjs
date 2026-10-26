import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { autoRetireOverlays, classifyOverlays, resolveAutoRetireMode } from '../daemon-overlay-auto-retire.mjs';
import { overlayFilePath, readOverlayState, removeOverlay, writeOverlays } from '../daemon-overlays.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';

let root, env, base, initial;
const git = (args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
  cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
});
const ok = (...args) => {
  const r = git(args);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const commit = (file, text) => {
  writeFileSync(join(root, file), text);
  ok('add', file);
  ok('commit', '-qm', text);
  return ok('rev-parse', 'HEAD');
};
const track = (ref, sha = 'HEAD') => ok('update-ref', `refs/remotes/origin/${ref}`, sha);
const branch = (ref, from = initial) => ok('checkout', '-q', '-B', ref, from);
const register = (overlays) => writeOverlays(root, overlays, { env });
const classify = (overlays) => classifyOverlays({ overlays, git, mainSha: 'origin/main' });
const retire = (overlays, options = {}) => {
  register(overlays);
  return autoRetireOverlays({ root, env, overlays, git, mainSha: 'origin/main', ...options });
};
const audit = () => readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'we-auto-retire-'));
  root = base;
  env = {
    WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_EVENTS: join(base, 'daemon-events.jsonl'),
    WE_DAEMON_OVERLAY_AUTO_RETIRE: 'on', WE_PLATFORM_PREFERENCES_FILE: join(base, 'platform.json'),
  };
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
  ok('init', '-q', '-b', 'main');
  initial = commit('base', 'base');
  track('main');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('real Git retirement evidence', () => {
  it('preparation fetches a newer remote tip before retiring a cached landed tip', async () => {
    branch('feature');
    const newer = commit('feature', 'new unmerged work');
    const origin = join(base, 'origin.git');
    ok('clone', '--bare', '-q', root, origin);
    ok('remote', 'add', 'origin', origin);
    branch('main');
    track('feature', initial);
    const overlays = [{ ref: 'feature', sha: initial }];
    register(overlays);
    expect(classify(overlays)[0].class).toBe('landed');
    const preparationEnv = { ...env, WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_AUTO_REBASE: '0' };
    const prepared = await prepareRebuild({
      root, env: preparationEnv, run: git, now: Date.now, mainOnly: false,
      prState: async () => 'OPEN', prBaseChain: async () => [],
    });
    expect(prepared.terminal, JSON.stringify(prepared)).toBe(false);
    expect(ok('rev-parse', 'refs/remotes/origin/feature')).toBe(newer);
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expect(prepared.plan.decisions).toContainEqual(expect.objectContaining({ ref: 'feature', action: 'apply', sha: newer }));
  });

  it('failed main fetch preserves registrations even when cached tips look landed', async () => {
    ok('remote', 'add', 'origin', join(base, 'missing-origin.git'));
    track('feature', initial);
    const overlays = [{ ref: 'feature', sha: initial }];
    register(overlays);
    const prepared = await prepareRebuild({
      root, env: { ...env, WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_AUTO_REBASE: '0' },
      run: git, now: Date.now, mainOnly: false,
    });
    expect(prepared.result.reason).toBe('fetch-failed');
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
  });

  it('keeps unique merge-resolution content even when every cherry line is negative', async () => {
    branch('left');
    const left = commit('base', 'left');
    branch('right');
    const right = commit('base', 'right');
    branch('feature', right);
    expect(git(['merge', '--no-commit', left]).status).toBe(1);
    commit('base', 'unique feature resolution');
    const ordinary = commit('ordinary', 'equivalent ordinary patch');
    track('feature');
    branch('main', right);
    expect(git(['merge', '--no-commit', left]).status).toBe(1);
    commit('base', 'main resolution');
    ok('cherry-pick', ordinary);
    track('main');
    const cherry = ok('cherry', 'origin/main', 'origin/feature').split('\n');
    expect(cherry.length).toBeGreaterThan(0);
    expect(cherry.every((line) => line.startsWith('- '))).toBe(true);
    const result = await retire([{ ref: 'feature' }]);
    expect(result.retired).toEqual([]);
    expect(result.kept[0]).toMatchObject({ ref: 'feature', class: 'needed', reason: 'unmerged-content' });
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'feature' }]);
  });

  it('retires a contained overlay while its consolidated top remains, with both audit trails', async () => {
    branch('lower');
    const lower = commit('lower', 'lower');
    track('lower');
    branch('top', lower);
    commit('top', 'top');
    track('top');
    const result = await retire([{ ref: 'lower' }, { ref: 'top' }]);
    expect(result.retired).toEqual([expect.objectContaining({ ref: 'lower', class: 'contained', sha: lower })]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'top' }]);
    expect(audit()).toEqual([expect.objectContaining({ kind: 'removed', by: 'auto-retire', ref: 'lower', sha: lower })]);
    expect(JSON.parse(readFileSync(env.WE_DAEMON_EVENTS, 'utf8'))).toMatchObject({ kind: 'overlay-retired', daemon: root.split('/').pop(), detail: { ref: 'lower', reason: 'stack-contained' } });
  });

  it('retires squash-landed content with different SHAs (merge-tree equivalence)', async () => {
    branch('feature');
    commit('one', 'one');
    const tip = commit('two', 'two');
    track('feature');
    branch('main');
    ok('merge', '--squash', 'feature');
    ok('commit', '-qm', 'squashed');
    track('main');
    expect(ok('rev-parse', 'HEAD')).not.toBe(tip);
    expect((await retire([{ ref: 'feature' }])).retired[0]).toMatchObject({ class: 'landed', reason: 'main-tree-equivalent' });
  });

  it('recognizes patch-equivalent content through git cherry', async () => {
    branch('feature');
    const tip = commit('one', 'one');
    track('feature');
    branch('main');
    commit('extra', 'extra');
    ok('cherry-pick', tip);
    track('main');
    expect((await retire([{ ref: 'feature' }])).retired[0].reason).toBe('landed-by-content');
  });

  it('keeps an overlay whose equivalent main patch was reverted', async () => {
    branch('feature');
    const tip = commit('one', 'overlay content');
    track('feature');
    branch('main');
    commit('extra', 'independent main content');
    ok('cherry-pick', tip);
    ok('revert', '--no-edit', 'HEAD');
    track('main');
    expect(ok('cherry', 'origin/main', 'origin/feature')).toBe(`- ${tip}`);
    const overlays = [{ ref: 'feature' }];
    const result = await retire(overlays);
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire).toEqual([]);
    expect(result.kept[0]).toMatchObject({ ref: 'feature', class: 'needed', reason: 'unmerged-content' });
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
  });

  it('keeps still-needed and conflicting overlays', async () => {
    branch('feature');
    commit('base', 'feature');
    track('feature');
    branch('main');
    commit('base', 'main');
    track('main');
    const result = await retire([{ ref: 'feature' }]);
    expect(result.retired).toEqual([]);
    expect(result.kept[0]).toMatchObject({ class: 'needed' });
  });

  it.each(['sha', 'headSha', 'tipSha'])('retires a deleted branch with recorded %s on main', async (field) => {
    const sha = commit('landed', 'landed');
    track('main');
    expect((await retire([{ ref: 'deleted', [field]: sha }])).retired[0]).toMatchObject({ class: 'landed', sha });
  });

  it('prefers the live tip to an old recorded main SHA', () => {
    branch('feature');
    commit('feature', 'feature');
    track('feature');
    expect(classify([{ ref: 'feature', sha: initial }])[0].class).toBe('needed');
  });

  it('shadow retires nothing and reports would-retire audit entries', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    const overlays = [{ ref: 'gone', sha: initial }];
    const result = await retire(overlays, { now: () => Date.parse('2026-10-26T18:00:00Z') });
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire[0].ref).toBe('gone');
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expect(audit()[0]).toMatchObject({ kind: 'auto-retire-shadow', by: 'auto-retire' });
  });

  it('last-carrier guard keeps one equal tip and resolves containment chains to the surviving top', async () => {
    branch('lower');
    const lower = commit('lower', 'lower');
    track('lower');
    const top = commit('top', 'top');
    track('middle'); track('top');
    const result = await retire([{ ref: 'lower' }, { ref: 'middle' }, { ref: 'top' }]);
    expect(result.retired.map((r) => r.ref)).toEqual(['lower', 'middle']);
    expect(result.kept).toEqual([expect.objectContaining({ ref: 'top', class: 'needed', sha: top })]);
    expect(lower).not.toBe(top);
  });

  it('missing main, missing recorded objects and Git errors keep registrations', () => {
    track('feature');
    ok('update-ref', '-d', 'refs/remotes/origin/main');
    expect(classify([{ ref: 'feature' }])[0].reason).toBe('git-unverifiable');
    track('main');
    expect(classify([{ ref: 'deleted', sha: 'a'.repeat(40) }])[0].class).toBe('needed');
    rmSync(join(root, '.git'), { recursive: true });
    expect(classify([{ ref: 'feature' }])[0]).toMatchObject({ class: 'needed', reason: 'git-unverifiable' });
  });

  it('container withdrawal under the list mutex prevents contained removal', async () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    commit('top', 'top'); track('top');
    const result = await retire([{ ref: 'lower' }, { ref: 'top' }], {
      removeOverlay: (r, ref, opts) => {
        removeOverlay(r, 'top', { env });
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'lower' }]);
  });

  it('concurrent re-registration prevents removal', async () => {
    const result = await retire([{ ref: 'gone', sha: initial }], {
      removeOverlay: (r, ref, opts) => {
        register([{ ref: 'gone', sha: initial, addedAt: 'new' }]);
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired).toEqual([]);
    expect(result.kept[0].reason).toBe('retirement-unverifiable');
  });
});

describe('policy cascade and shadow graduation', () => {
  it('defaults to shadow, and the shipped setting graduates at exactly one day', () => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    expect(resolveAutoRetireMode(env, { settingsPath: join(base, 'missing') }).mode).toBe('shadow');
    expect(resolveAutoRetireMode(env, { now: '2026-10-27T11:59:59Z' }).mode).toBe('shadow');
    expect(resolveAutoRetireMode(env, { now: '2026-10-27T12:00:00Z' })).toMatchObject({ mode: 'on', source: 'tool (shadow elapsed)' });
  });

  it('resolves platform, tool and env, ignoring invalid overrides and invalid dates', () => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    const settingsPath = join(base, 'settings.json');
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ autoRetire: { mode: 'off' } }));
    expect(resolveAutoRetireMode(env, { settingsPath }).source).toBe('platform');
    writeFileSync(settingsPath, JSON.stringify({ autoRetire: { mode: 'shadow', shadowSince: 'bad' } }));
    expect(resolveAutoRetireMode(env, { settingsPath })).toMatchObject({ mode: 'shadow', source: 'tool' });
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    expect(resolveAutoRetireMode(env, { settingsPath }).source).toBe('env');
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'invalid';
    expect(resolveAutoRetireMode(env, { settingsPath }).source).toBe('tool');
  });

  it('off keeps even landed overlays', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    const result = await retire([{ ref: 'gone', sha: initial }]);
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });
});
