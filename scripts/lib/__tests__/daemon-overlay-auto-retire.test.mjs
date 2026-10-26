import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { autoRetireOverlays, classifyOverlays, resolveAutoRetireMode } from '../daemon-overlay-auto-retire.mjs';
import { appendOverlayEvent, overlayFilePath, readOverlayState, removeOverlay, writeOverlays } from '../daemon-overlays.mjs';
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
const prepare = (options = {}) => prepareRebuild({
  root, env: { ...env, WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_AUTO_REBASE: '0' },
  run: git, now: Date.now, mainOnly: false,
  prState: async () => 'OPEN', prBaseChain: async () => [], ...options,
});
const localOrigin = () => {
  const origin = join(base, 'origin.git');
  ok('clone', '--bare', '-q', root, origin);
  ok('remote', 'add', 'origin', origin);
  return origin;
};
const expectNoRetirement = () => {
  const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
  expect(existsSync(file) ? audit().filter((e) => e.by === 'auto-retire') : []).toEqual([]);
  expect(existsSync(env.WE_DAEMON_EVENTS) ? readFileSync(env.WE_DAEMON_EVENTS, 'utf8') : '').not.toContain('overlay-retired');
};

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
  it.each(['off', 'shadow', 'on'])('%s preparation proceeds past a squash-landed deleted branch', async (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    branch('deleted');
    const sha = commit('landed', 'overlay content');
    branch('main');
    commit('unrelated', 'unrelated main content');
    commit('landed', 'overlay content');
    track('main');
    localOrigin();
    ok('push', '-q', 'origin', '--delete', 'deleted');
    register([{ ref: 'deleted', sha }]);
    const result = await prepare();
    expect(result.result?.reason).not.toBe('fetch-failed');
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(mode === 'on' ? [] : ['deleted']);
    expect((result.plan ?? result.result.plan).decisions.some((d) => d.ref === 'deleted')).toBe(false);
  });

  it.each(['off', 'shadow', 'on'])('%s preparation isolates unavailable registrations from a healthy overlay', async (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    branch('healthy');
    commit('healthy', 'healthy');
    track('healthy');
    ok('checkout', '-q', 'main');
    localOrigin();
    const overlays = [{ ref: 'deleted' }, { ref: 'unsafe@name' }, { ref: 'healthy' }];
    register(overlays);
    const result = await prepare();
    expect(result.terminal).not.toBe(true);
    expect(result.plan.decisions.map((d) => d.ref)).toEqual(['healthy']);
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(overlays.map((o) => o.ref));
    expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-fetch-unverifiable' }));
  });

  it('deduplicates shadow audit entries across calls while reporting every observation', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    const overlays = [{ ref: 'deleted', sha: initial }];
    register(overlays);
    await autoRetireOverlays({ root, env, overlays, git });
    const first = readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8');
    const second = await autoRetireOverlays({ root, env, overlays, git });
    expect(second.wouldRetire).toHaveLength(1);
    expect(readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8')).toBe(first);
  });

  it('deduplicates exact shadow tuples across processes and retains distinct evidence and ordinary audit events', async () => {
    const event = { kind: 'auto-retire-shadow', ref: 'feature', sha: initial, reason: 'ancestor-of-main' };
    const moduleUrl = new URL('../daemon-overlays.mjs', import.meta.url).href;
    const code = `import { appendOverlayEvent } from ${JSON.stringify(moduleUrl)}; appendOverlayEvent(${JSON.stringify(root)}, ${JSON.stringify(event)}, { env: ${JSON.stringify(env)} });`;
    await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL' });
      child.once('error', reject);
      child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(`audit writer exited ${status}`)));
    })));
    expect(audit()).toHaveLength(1);
    for (const change of [{ ref: 'other' }, { sha: 'a'.repeat(40) }, { reason: 'contained' }]) {
      appendOverlayEvent(root, { ...event, ...change }, { env });
    }
    appendOverlayEvent(root, event, { env });
    expect(audit()).toHaveLength(4);
    appendOverlayEvent(root, { ...event, kind: 'removed' }, { env });
    appendOverlayEvent(root, { ...event, kind: 'removed' }, { env });
    expect(audit()).toHaveLength(6);
  });

  it('retries a shadow observation after audit append failure', () => {
    const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
    mkdirSync(file, { recursive: true });
    const event = { kind: 'auto-retire-shadow', ref: 'feature', sha: initial, reason: 'ancestor-of-main' };
    expect(() => appendOverlayEvent(root, event, { env })).toThrow();
    rmSync(file, { recursive: true });
    appendOverlayEvent(root, event, { env });
    expect(audit()).toEqual([expect.objectContaining(event)]);
  });

  it.each(['sha', 'headSha', 'tipSha'])('preparation retires a deleted remote branch using recorded %s and independently refreshed overlays', async (field) => {
    localOrigin();
    track('deleted');
    track('main-overlay');
    ok('push', '-q', 'origin', 'main:refs/heads/main-overlay');
    register([{ ref: 'deleted', [field]: initial }, { ref: 'main-overlay' }]);
    await prepare();
    expect(readOverlayState(root, { env }).overlays).toEqual([]);
    expect(audit().filter((e) => e.by === 'auto-retire').map((e) => e.ref)).toEqual(['deleted', 'main-overlay']);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toContain('overlay-retired');
  });

  it.each(['failure', 'throw', 'malformed', 'fetch-throw', 'fetch-error'])('failed overlay fetch preserves cached landed registrations after successful main fetch (%s)', async (kind) => {
    branch('feature');
    commit('feature', 'live unmerged content');
    localOrigin();
    branch('main');
    track('feature', initial);
    const overlays = [{ ref: 'feature', sha: initial }];
    register(overlays);
    let mainFetched = false;
    const prepared = await prepare({ run: (args) => {
      if (args[0] === 'fetch' && args.some((arg) => arg.includes('refs/heads/feature:'))) {
        if (kind === 'fetch-throw') throw new Error('fetch unavailable');
        if (kind === 'fetch-error') return { status: 0, error: new Error('incomplete fetch') };
        return { status: 1, stderr: 'transient failure' };
      }
      if (args[0] === 'ls-remote' && ['throw', 'malformed'].includes(kind)) {
        if (kind === 'throw') throw new Error('remote unavailable');
        return { status: 2, stdout: 'incomplete remote response' };
      }
      const result = git(args);
      if (args[0] === 'fetch' && result.status === 0) mainFetched = true;
      return result;
    } });
    expect(mainFetched).toBe(true);
    expect(prepared.result.reason).toBe('up-to-date');
    expect(prepared.result.plan.decisions).toEqual([]);
    expect(prepared.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-fetch-unverifiable' }));
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expectNoRetirement();
  });

  it('an unverifiable overlay does not block independently refreshed landed overlays', async () => {
    localOrigin();
    track('uncertain');
    register([{ ref: 'uncertain', sha: initial }, { ref: 'main' }]);
    await prepare({ run: (args) => args[0] === 'ls-remote'
      ? { status: 128, stderr: 'unavailable' } : git(args) });
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'uncertain', sha: initial }]);
    expect(audit().filter((e) => e.by === 'auto-retire').map((e) => e.ref)).toEqual(['main']);
  });

  it('mainOnly preserves landed registrations without retirement events', async () => {
    localOrigin();
    const overlays = [{ ref: 'deleted', sha: initial }];
    register(overlays);
    await prepare({ mainOnly: true });
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expectNoRetirement();
  });

  it('corrupt overlay state refuses preparation without retirement events', async () => {
    localOrigin();
    register([{ ref: 'main' }]);
    writeFileSync(overlayFilePath(root, env), '{broken');
    const prepared = await prepare();
    expect(prepared.result.reason).toBe('overlay-state-corrupt');
    expect(readFileSync(overlayFilePath(root, env), 'utf8')).toBe('{broken');
    expectNoRetirement();
  });

  it.each(['feat/a+b', 'feat#1'])('preparation and classification preserve unsafe ref %s with a stale landed tip', async (ref) => {
    branch(ref);
    commit('feature', 'live unmerged content');
    localOrigin();
    branch('main');
    track(ref, initial);
    const overlays = [{ ref, sha: initial }];
    register(overlays);
    expect(classify(overlays)[0]).toMatchObject({ class: 'needed', reason: 'git-unverifiable' });
    await prepare();
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expectNoRetirement();
  });

  it('confirmed missing refs ignore cached tips and preserve unmerged recorded content', async () => {
    branch('deleted');
    const sha = commit('feature', 'unmerged recorded content');
    branch('main');
    localOrigin();
    ok('push', '-q', 'origin', '--delete', 'deleted');
    track('deleted', initial);
    const overlays = [{ ref: 'deleted', sha }];
    register(overlays);
    await prepare({ run: (args) => args[0] === 'update-ref' && args[1] === '-d' && args[2] === 'refs/remotes/origin/deleted'
      ? { status: 1 } : git(args) });
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expectNoRetirement();
  });

  it('classification requires per-ref confirmation and never falls back after a successful refresh loses its tracking ref', () => {
    branch('feature');
    const sha = commit('feature', 'needed content');
    track('feature', initial);
    const overlays = [{ ref: 'feature', sha }];
    for (const evidence of ['unverifiable', undefined]) {
      expect(classifyOverlays({ overlays, git, refEvidence: new Map([['feature', evidence]]) })[0])
        .toMatchObject({ class: 'needed', reason: 'git-unverifiable' });
    }
    expect(classifyOverlays({ overlays, git, refEvidence: new Map([['feature', 'missing']]) })[0])
      .toMatchObject({ class: 'needed', reason: 'unmerged-content', sha });
    ok('update-ref', '-d', 'refs/remotes/origin/feature');
    expect(classifyOverlays({ overlays: [{ ref: 'feature', sha: initial }], git, refEvidence: new Map([['feature', 'refreshed']]) })[0])
      .toMatchObject({ class: 'needed', reason: 'git-unverifiable' });
  });

  it('invalid registry entries hold preparation without overwriting the registry', async () => {
    localOrigin();
    const overlays = [null, { ref: '--invalid' }];
    register(overlays);
    const prepared = await prepare();
    expect(prepared.result.reason).toBe('fetch-failed');
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expectNoRetirement();
  });

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

  it('container re-registration with unrelated content preserves the contained source', async () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    const top = commit('top', 'top'); track('top');
    const original = [{ ref: 'lower' }, { ref: 'top', sha: top, addedAt: 'original' }];
    const replacement = { ref: 'top', sha: initial, addedAt: 'replacement' };
    const result = await retire(original, {
      removeOverlay: (r, ref, opts) => {
        register([original[0], replacement]);
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([original[0], replacement]);
    expectNoRetirement();
  });

  it('container stack-base cache updates preserve its registration identity', async () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    commit('top', 'top'); track('top');
    const result = await retire([{ ref: 'lower' }, { ref: 'top' }], {
      removeOverlay: (r, ref, opts) => {
        register([{ ref: 'lower' }, { ref: 'top', stackBases: ['lower'] }]);
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired.map((row) => row.ref)).toEqual(['lower']);
  });

  it('classification issues only permitted local Git commands across evidence paths', () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    commit('top', 'top'); track('top');
    const commands = new Set();
    const forbidden = [];
    const rows = classifyOverlays({ overlays: [{ ref: 'lower' }, { ref: 'top' }, { ref: 'deleted', sha: initial }, { ref: 'unknown' }], git: (args) => {
      const [command, ...options] = args;
      const oid = '[0-9a-f]{40,64}';
      const permitted = {
        'rev-parse': /^(?:--verify --end-of-options [^ ]+\^\{commit\}|--verify [0-9a-f]{40,64}\^\{tree\})$/,
        'for-each-ref': /^--format=%\(refname\) %\(objectname\) refs\/remotes\/origin\/[a-z]+$/,
        'merge-base': new RegExp(`^--is-ancestor ${oid} ${oid}$`),
        cherry: new RegExp(`^${oid} ${oid}$`),
        'merge-tree': new RegExp(`^--write-tree --no-messages ${oid} ${oid}$`),
      };
      if (!permitted[command]?.test(options.join(' '))) {
        forbidden.push(args);
        throw new Error(`forbidden command: ${args.join(' ')}`);
      }
      commands.add(command);
      return git(args);
    } });
    expect(rows.map((row) => row.class)).toEqual(['contained', 'needed', 'landed', 'needed']);
    expect(forbidden).toEqual([]);
    expect([...commands].sort()).toEqual(['cherry', 'for-each-ref', 'merge-base', 'merge-tree', 'rev-parse']);
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
  it.each(['off', 'on'])('explicit environment %s remains unchanged after the tool cutoff', (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    expect(resolveAutoRetireMode(env, { now: '2026-10-29T12:00:00Z' })).toMatchObject({ mode, source: 'env' });
  });
  it.each(['standard', 'platform', 'tool', 'env'])('%s shadow honors mode provenance before, at and after graduation', (source) => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    const settingsPath = join(base, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoRetire: {
      shadowSince: '2026-10-26T12:00:00Z', ...(['tool', 'env'].includes(source) ? { mode: 'shadow' } : {}),
    } }));
    if (source === 'platform') writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ autoRetire: { mode: 'shadow' } }));
    if (source === 'env') env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    for (const now of ['2026-10-27T11:59:59Z', '2026-10-27T12:00:00Z', '2026-10-29T12:00:00Z']) {
      const graduated = source === 'tool' && now !== '2026-10-27T11:59:59Z';
      expect(resolveAutoRetireMode(env, { settingsPath, now })).toMatchObject({
        mode: graduated ? 'on' : 'shadow', source: `${source}${graduated ? ' (shadow elapsed)' : ''}`,
      });
    }
  });

  it('explicit environment shadow remains observe-only after graduation', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    const overlays = [{ ref: 'deleted', sha: initial }];
    const result = await retire(overlays, { now: () => Date.parse('2026-10-29T12:00:00Z') });
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire.map((row) => row.ref)).toEqual(['deleted']);
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
  });

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
