import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { autoRetireOverlays, classifyOverlays, resolveAutoRetireMode } from '../daemon-overlay-auto-retire.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, persistTipShas, readOverlayState, registrationIdentity, removeOverlay, writeOverlays } from '../daemon-overlays.mjs';
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
// These disposable local fixtures explicitly model the fetch outcome; production gets it from fetch.
const fixtureEvidence = (overlays) => new Map(overlays.map((o) => [o.ref,
  git(['show-ref', '--verify', `refs/remotes/origin/${o.ref}`]).status === 0 ? 'refreshed' : 'missing']));
const classify = (overlays) => classifyOverlays({ overlays, git, mainSha: 'origin/main', refEvidence: fixtureEvidence(overlays) });
const retire = (overlays, options = {}) => {
  register(overlays);
  return autoRetireOverlays({ root, env, overlays, git, mainSha: 'origin/main', refEvidence: fixtureEvidence(overlays), ...options });
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
  // A `retiring` intent line may precede a refused removal; only `removed` and shadow lines record retirement.
  expect(existsSync(file) ? audit().filter((e) => e.by === 'auto-retire' && e.kind !== 'retiring') : []).toEqual([]);
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
  it('re-registration between refresh and persistence rejects stale retirement evidence', async () => {
    const old = { ref: 'feature', sha: initial, tipSha: initial, registeredAt: 'old', registrationId: 'old-registration' };
    register([old]);
    track('feature', initial);
    let refreshedTips;
    await autoRetireOverlays({ root, env: { ...env, WE_DAEMON_OVERLAY_AUTO_RETIRE: 'shadow' },
      overlays: [old], git, refEvidence: new Map([['feature', 'refreshed']]),
      persistTipShas: (_root, tips) => { refreshedTips = tips; } });
    expect(refreshedTips.get('feature')).toEqual({ sha: initial, reg: registrationIdentity(old), registrationId: old.registrationId });
    branch('feature');
    const needed = commit('needed', 'unmerged replacement');
    register([{ ...old, sha: needed }]);
    addOverlay(root, { ref: 'feature' }, { env });
    const replacement = readOverlayState(root, { env }).overlays[0];
    expect(replacement.tipSha).toBeUndefined();
    expect(persistTipShas(root, refreshedTips, { env })).toEqual({ written: 0 });
    ok('update-ref', '-d', 'refs/remotes/origin/feature');
    const result = await autoRetireOverlays({ root, env, overlays: [replacement], git,
      refEvidence: new Map([['feature', 'missing']]) });
    expect(result.retired).toEqual([]);
    expect(result.kept).toEqual([expect.objectContaining({ ref: 'feature', sha: needed, reason: 'unmerged-content' })]);
    expect(readOverlayState(root, { env }).overlays).toEqual([replacement]);
  });

  it('an identical re-registration rejects earlier tips even with the same timestamp', () => {
    const entry = { ref: 'feature', now: '2026-10-27T12:00:00Z' };
    const [old] = addOverlay(root, entry, { env });
    const tips = new Map([['feature', { sha: initial, reg: registrationIdentity(old) }]]);
    const [replacement] = addOverlay(root, entry, { env });
    expect(registrationIdentity(replacement)).not.toEqual(registrationIdentity(old));
    expect(persistTipShas(root, tips, { env })).toEqual({ written: 0 });
    removeOverlay(root, 'feature', { env });
    addOverlay(root, entry, { env });
    expect(persistTipShas(root, tips, { env })).toEqual({ written: 0 });
  });

  it('persists matching registration tips and refuses unbound, replaced and vanished evidence', () => {
    const entry = { ref: 'feature', sha: initial, registeredAt: 'old', registrationId: 'feature-registration' };
    const tips = new Map([['feature', { sha: initial, reg: registrationIdentity(entry), registrationId: entry.registrationId }]]);
    register([entry]);
    expect(persistTipShas(root, tips, { env })).toEqual({ written: 1 });
    expect(persistTipShas(root, tips, { env })).toEqual({ written: 0 });
    for (const replacement of [{ ...entry, sha: 'f'.repeat(40) }, { ...entry, registeredAt: 'new' }]) {
      register([replacement]);
      expect(persistTipShas(root, tips, { env })).toEqual({ written: 0 });
      expect(persistTipShas(root, new Map([['feature', initial]]), { env })).toEqual({ written: 0 });
      expect(readOverlayState(root, { env }).overlays).toEqual([replacement]);
    }
    register([]);
    expect(persistTipShas(root, tips, { env })).toEqual({ written: 0 });
  });

  it('preparation preserves a same-ref replacement made after refresh before deferred tip persistence', async () => {
    branch('feature'); commit('feature', 'old content'); branch('main'); localOrigin();
    addOverlay(root, { ref: 'feature', pr: 1 }, { env });
    let replacement;
    const prepared = await prepare({ prState: async () => {
      if (!replacement) [replacement] = addOverlay(root, { ref: 'feature', pr: 1 }, { env });
      return 'OPEN';
    } });
    expect(prepared.terminal).toBe(true);
    expect(prepared.result.reason).toBe('overlay-registration-changed');
    expect(prepared.alerts.map(a => a.kind)).toContain('overlay-registration-changed');
    expect(replacement).toBeDefined();
    expect(readOverlayState(root, { env }).overlays).toEqual([replacement]);
    expect(replacement.tipSha).toBeUndefined();
  });

  it.each([true, false])('repeated source retirement preserves both archives and nested sources (retireInto=%s)', (retireInto) => {
    const old = { entry: { ref: 'source', sha: initial, retiredSources: [{ entry: { ref: 'nested' }, sha: initial }] }, sha: initial };
    const current = { entry: { ref: 'source', sha: 'b'.repeat(40) }, sha: 'b'.repeat(40) };
    register([{ ref: 'carrier', retiredSources: [old] }, retireInto ? current.entry : { ref: 'swap', retiredSources: [current] }]);
    removeOverlay(root, retireInto ? 'source' : 'swap', { env, requireRef: 'carrier', retireInto, retiredSha: current.sha });
    expect(readOverlayState(root, { env }).overlays[0].retiredSources).toEqual([old, current]);
    removeOverlay(root, 'carrier', { env });
    expect(readOverlayState(root, { env }).overlays.find((o) => o.ref === 'source')).toEqual({ ...current.entry, tipSha: current.sha });
    // The older nested registration survives withdrawal of both the carrier and the newest source.
    removeOverlay(root, 'source', { env });
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['nested']);
  });

  it.each(['on', 'shadow'])('%s preserves contained explicit, mechanism and unverifiable pins', async (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    branch('lower');
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    const lower = commit('scripts/lib/daemon-rebuild.mjs', 'live rebuild mechanism');
    track('lower');
    branch('top', lower);
    commit('top', 'contains the pinned source');
    track('top');
    branch('main');
    for (const kind of ['explicit', 'mechanism', 'merge-base-failed', 'diff-failed', 'diff-error']) {
      // Refreshed tips can only be persisted for registrations with explicit identities.
      const overlays = [
        { ref: 'lower', registrationId: 'lower-registration', ...(kind === 'explicit' ? { pinned: true } : {}) },
        { ref: 'top', registrationId: 'top-registration' },
      ];
      const result = await retire(overlays, { git: (args) => {
        if (kind === 'merge-base-failed' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') return { status: 128 };
        if (kind === 'diff-failed' && args[0] === 'diff') return { status: 128 };
        if (kind === 'diff-error' && args[0] === 'diff') return { status: 0, error: new Error('incomplete diff') };
        return git(args);
      } });
      expect(result.retired, kind).toEqual([]);
      expect(result.wouldRetire, kind).toEqual([]);
      expect(readOverlayState(root, { env }).overlays, kind).toEqual(overlays.map((o) => ({
        ...o, tipSha: ok('rev-parse', `refs/remotes/origin/${o.ref}`),
      })));
      expectNoRetirement();
    }
  });

  it.each(['complete', 'legacy', 'invalid-json', 'invalid-ref', 'unreadable'])(
    'preparation preserves pending swap registrations with %s evidence while auto-rebase is disabled', async (shape) => {
      branch('lower');
      const lower = commit('lower', 'unmerged source');
      branch('top', lower);
      const top = commit('top', 'registered repair');
      branch('main');
      localOrigin();
      register([{ ref: 'lower' }, { ref: 'top' }]);
      const pending = `${overlayFilePath(root, env)}.auto-rebase`;
      mkdirSync(pending);
      const file = join(pending, 'lower.json');
      if (shape === 'unreadable') mkdirSync(file);
      else writeFileSync(file, shape === 'invalid-json' ? '{' : JSON.stringify({
        old: shape === 'invalid-ref' ? '--unsafe' : 'lower', new: 'top', newSha: top,
        ...(shape === 'complete' ? { oldOverlay: { ref: 'lower' } } : {}),
      }));
      const prepared = await prepare();
      expect(prepared.terminal).toBe(false);
      expect(prepared.plan.applied.map((o) => o.ref)).toEqual(['top']);
      expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['lower', 'top']);
      expect(existsSync(file)).toBe(true);
      if (['invalid-json', 'invalid-ref', 'unreadable'].includes(shape)) {
        expect(prepared.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-auto-retire-failed' }));
      }
      expectNoRetirement();
    },
  );

  it('pending swap protection leaves unrelated landed registrations eligible for retirement', async () => {
    branch('lower');
    const lower = commit('lower', 'unmerged source');
    branch('top', lower);
    const top = commit('top', 'registered repair');
    branch('main');
    localOrigin();
    register([{ ref: 'lower' }, { ref: 'top' }, { ref: 'main' }]);
    const pending = `${overlayFilePath(root, env)}.auto-rebase`;
    mkdirSync(pending);
    writeFileSync(join(pending, 'lower.json'), JSON.stringify({ old: 'lower', new: 'top', newSha: top }));
    const prepared = await prepare();
    expect(prepared.terminal).toBe(false);
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['lower', 'top']);
    expect(audit().filter((e) => e.kind === 'removed').map((e) => e.ref)).toEqual(['main']);
    expect(prepared.alerts).toContainEqual({ kind: 'overlay-auto-dropped', detail: { ref: 'main', reason: 'in-main' } });
  });

  it.each(['missing-top', 'missing-equal', 'missing-above-live-top', 'refreshed-top'])(
    'preparation retains an available carrier of unmerged content (%s)', async (shape) => {
      branch('lower');
      const lower = commit('lower', 'lower content');
      branch('top', lower);
      const top = shape === 'missing-equal' ? lower : commit('top', 'top content');
      const overlays = [{ ref: 'lower', sha: lower }, { ref: 'top', sha: top }];
      if (shape === 'missing-above-live-top') {
        branch('missing', top);
        overlays.push({ ref: 'missing', sha: commit('missing', 'missing content') });
      }
      branch('main');
      localOrigin();
      const missing = shape === 'missing-above-live-top' ? 'missing'
        : shape.startsWith('missing-') ? 'top' : null;
      if (missing) ok('push', '-q', 'origin', '--delete', missing);
      // These cases exercise carrier selection with known non-mechanism tips, not missing pin evidence.
      register(overlays.map((o) => ({ ...o, tipSha: o.sha })));

      const prepared = await prepare();
      const carrier = ['missing-top', 'missing-equal'].includes(shape) ? 'lower' : 'top';
      expect(prepared.terminal).not.toBe(true);
      expect(prepared.plan.applied.map((o) => o.ref)).toEqual([carrier]);
      expect(readOverlayState(root, { env }).overlays.map((o) => o.ref))
        .toEqual({
          'missing-top': ['lower', 'top'],
          'missing-equal': ['lower'],
          'missing-above-live-top': ['top', 'missing'],
          'refreshed-top': ['top'],
        }[shape]);
      expect(prepared.plan.decisions.some((d) => d.ref === missing)).toBe(false);
    },
    30_000,
  );

  it.each(['missing', 'unverifiable', undefined])('does not elect a carrier with %s fetch evidence', (evidence) => {
    branch('lower');
    const lower = commit('lower', 'lower');
    track('lower');
    branch('top', lower);
    const top = commit('top', 'top');
    track('top');
    const rows = classifyOverlays({
      overlays: [{ ref: 'lower', sha: lower }, { ref: 'top', sha: top }], git,
      refEvidence: new Map([['lower', 'refreshed'], ['top', evidence]]),
    });
    expect(rows[0]).toMatchObject({ ref: 'lower', class: 'needed', reason: 'unmerged-content' });
  });

  it.each(['off', 'shadow', 'on'])('%s preparation preserves legacy SHA-only evidence until retirement or pin verification', async (mode) => {
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
    if (mode === 'on') {
      expect((result.plan ?? result.result.plan).decisions.some((d) => d.ref === 'deleted')).toBe(false);
    } else {
      // Legacy `sha` is retirement evidence, but is not the recorded `tipSha` pin fallback.
      expect(result).toMatchObject({ terminal: true, result: {
        moved: false, reason: 'pinned-overlay-unavailable', detail: { ref: 'deleted', pinnedBy: 'unknown' },
      } });
    }
  });

  it.each(['off', 'shadow', 'on'])('%s preparation refuses unavailable registrations without pin evidence beside a healthy overlay', async (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    branch('healthy');
    commit('healthy', 'healthy');
    track('healthy');
    ok('checkout', '-q', 'main');
    localOrigin();
    const overlays = [{ ref: 'deleted' }, { ref: 'unsafe@name' }, { ref: 'healthy' }];
    register(overlays);
    const result = await prepare();
    expect(result).toMatchObject({ terminal: true, result: {
      moved: false, reason: 'pinned-overlay-unavailable', detail: { ref: 'deleted', pinnedBy: 'unknown' },
    } });
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(overlays.map((o) => o.ref));
    expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'pinned-overlay-unavailable' }));
    expectNoRetirement();
  });

  it('deduplicates shadow audit entries across calls while reporting every observation', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    const overlays = [{ ref: 'deleted', sha: initial }];
    register(overlays);
    await autoRetireOverlays({ root, env, overlays, git, refEvidence: new Map([['deleted', 'missing']]) });
    const first = readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8');
    const second = await autoRetireOverlays({ root, env, overlays, git, refEvidence: new Map([['deleted', 'missing']]) });
    expect(second.wouldRetire).toHaveLength(1);
    expect(readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8')).toBe(first);
  });

  it('deduplicates exact shadow tuples across processes and retains distinct evidence and ordinary audit events', async () => {
    const event = { kind: 'auto-retire-shadow', ref: 'feature', sha: initial, reason: 'ancestor-of-main' };
    // Build a filesystem URL: Vite rewrites static new URL(relative, import.meta.url) as a web asset.
    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../daemon-overlays.mjs')).href;
    const code = `import { appendOverlayEvent } from ${JSON.stringify(moduleUrl)}; appendOverlayEvent(${JSON.stringify(root)}, ${JSON.stringify(event)}, { env: ${JSON.stringify(env)} });`;
    await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      child.once('error', reject);
      child.once('close', (status) => status === 0 ? resolve() : reject(new Error(`audit writer exited ${status}: ${stderr}`)));
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
  // Each concurrent native writer has a 10s hard limit; the test must allow that
  // bounded work to finish before teardown removes the shared fixture.
  }, 15_000);

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
    expect(audit().filter((e) => e.kind === 'removed').map((e) => e.ref)).toEqual(['deleted', 'main-overlay']);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toContain('overlay-retired');
  });

  it.each(['failure', 'throw', 'malformed', 'fetch-throw', 'fetch-error'])('failed overlay fetch refuses missing pin evidence and preserves cached landed registrations (%s)', async (kind) => {
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
    expect(prepared).toMatchObject({ terminal: true, result: {
      moved: false, reason: 'pinned-overlay-unavailable', detail: { ref: 'feature', pinnedBy: 'unknown' },
    } });
    expect(prepared.alerts).toContainEqual(expect.objectContaining({ kind: 'pinned-overlay-unavailable' }));
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays.map(o => ({ ...o, registrationId: expect.any(String) })));
    expectNoRetirement();
  });

  it('an unverifiable overlay does not block independently refreshed landed overlays', async () => {
    localOrigin();
    track('uncertain');
    register([{ ref: 'uncertain', sha: initial }, { ref: 'main' }]);
    await prepare({ run: (args) => args[0] === 'ls-remote'
      ? { status: 128, stderr: 'unavailable' } : git(args) });
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'uncertain', sha: initial, registrationId: expect.any(String) }]);
    expect(audit().filter((e) => e.kind === 'removed').map((e) => e.ref)).toEqual(['main']);
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
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays.map(o => ({ ...o, registrationId: expect.any(String) })));
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
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays.map(o => ({ ...o, registrationId: expect.any(String) })));
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

  it.each([null, {}, { ref: 42 }, { ref: '' }, 'main', []].map((invalid) => [invalid]))('invalid registry entry %j holds preparation without overwriting the registry', async (invalid) => {
    localOrigin();
    const overlays = [invalid, { ref: '--invalid' }, { ref: 'main' }];
    register(overlays);
    const stored = readFileSync(overlayFilePath(root, env), 'utf8');
    const fetches = [];
    const prepared = await prepare({ run: (args) => {
      if (args[0] === 'fetch') fetches.push(args);
      return git(args);
    } });
    expect(prepared.result).toMatchObject({ moved: false, reason: 'overlay-state-malformed' });
    expect(fetches).toEqual([['fetch', '--quiet', '--prune', 'origin',
      '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/main:refs/remotes/origin/main']]);
    expect(prepared.alerts).toContainEqual(expect.objectContaining({
      kind: 'overlay-state-malformed', detail: expect.objectContaining({ malformed: [0] }),
    }));
    expect(readFileSync(overlayFilePath(root, env), 'utf8')).toBe(stored);
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
    // The refreshed tip is recorded as later deleted-branch evidence; the registration itself is unchanged.
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ...overlays[0], tipSha: newer, registrationId: expect.any(String) }]);
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
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays.map(o => ({ ...o, registrationId: expect.any(String) })));
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
    const result = await retire([{ ref: 'feature', registrationId: 'feature-registration' }]);
    expect(result.retired).toEqual([]);
    expect(result.kept[0]).toMatchObject({ ref: 'feature', class: 'needed', reason: 'unmerged-content' });
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'feature', registrationId: 'feature-registration', tipSha: ok('rev-parse', 'origin/feature') }]);
  });

  it('retires a contained overlay while its consolidated top remains, with both audit trails', async () => {
    branch('lower');
    const lower = commit('lower', 'lower');
    track('lower');
    branch('top', lower);
    commit('top', 'top');
    track('top');
    const result = await retire([{ ref: 'lower' }, { ref: 'top', registrationId: 'top-registration' }]);
    expect(result.retired).toEqual([expect.objectContaining({ ref: 'lower', class: 'contained', sha: lower })]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'top', registrationId: 'top-registration', tipSha: ok('rev-parse', 'origin/top'),
      retiredSources: [{ entry: { ref: 'lower' }, sha: lower }] }]);
    expect(audit()).toEqual([
      expect.objectContaining({ kind: 'retiring', by: 'auto-retire', ref: 'lower', sha: lower, container: 'top' }),
      expect.objectContaining({ kind: 'removed', by: 'auto-retire', ref: 'lower', sha: lower }),
    ]);
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
    const overlays = [{ ref: 'feature', registrationId: 'feature-registration' }];
    const result = await retire(overlays);
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire).toEqual([]);
    expect(result.kept[0]).toMatchObject({ ref: 'feature', class: 'needed', reason: 'unmerged-content' });
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'feature', registrationId: 'feature-registration', tipSha: tip }]);
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

  it('retires three independent unmerged registrations into their merged top and reinstates them on withdrawal', async () => {
    const refs = ['hw-top-1022c', 'hw-top-1022e', 'bundle-repair-retry'];
    const sources = refs.map((ref) => {
      branch(ref, initial);
      commit(`${ref}-base`, `${ref} base content`);
      const sha = commit(ref, `${ref} unmerged content`);
      track(ref);
      return { entry: { ref }, sha };
    });
    const topRef = 'hw-unfreeze-deadline';
    branch(topRef, initial);
    commit(topRef, 'top unmerged content');
    for (const ref of refs) ok('merge', '--no-ff', '-m', `merge ${ref}`, ref);
    const top = ok('rev-parse', 'HEAD');
    track(topRef);
    const overlays = [...sources.map(({ entry }) => entry), { ref: topRef, registrationId: 'top-registration' }];
    for (const overlay of overlays) {
      expect(classify([overlay])[0]).toMatchObject({ ref: overlay.ref, class: 'needed', reason: 'unmerged-content' });
    }

    const moved = [];
    const result = await retire(overlays, {
      removeOverlay: (r, ref, opts) => {
        // The registered carrier exists before each source is removed; the same write preserves the source.
        const before = readOverlayState(r, { env }).overlays;
        expect(before).toContainEqual({ ref });
        expect(before).toContainEqual({ ref: topRef, registrationId: 'top-registration', ...(moved.length ? { retiredSources: [...moved] } : {}) });
        const removed = removeOverlay(r, ref, opts);
        moved.push(sources.find(({ entry }) => entry.ref === ref));
        const after = readOverlayState(r, { env }).overlays;
        expect(after.some((entry) => entry.ref === ref)).toBe(false);
        expect(after).toContainEqual({ ref: topRef, registrationId: 'top-registration', retiredSources: [...moved] });
        return removed;
      },
    });
    expect(result.retired).toEqual(sources.map(({ entry, sha }) => expect.objectContaining({
      ref: entry.ref, sha, class: 'contained', container: topRef,
    })));
    expect(result.kept).toEqual([expect.objectContaining({ ref: topRef, sha: top, class: 'needed', reason: 'unmerged-content' })]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: topRef, registrationId: 'top-registration', tipSha: top, retiredSources: sources }]);

    expect(removeOverlay(root, topRef, { env, why: 'pr-closed' }).reinstated).toEqual(refs);
    expect(readOverlayState(root, { env }).overlays).toEqual(sources.map(({ entry, sha }) => ({ ...entry, tipSha: sha })));
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
    const result = await retire([{ ref: 'lower', registrationId: 'lower-registration' }, { ref: 'top' }], {
      removeOverlay: (r, ref, opts) => {
        removeOverlay(r, 'top', { env });
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'lower', registrationId: 'lower-registration', tipSha: ok('rev-parse', 'origin/lower') }]);
  });

  it('container re-registration with unrelated content preserves the contained source', async () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    const top = commit('top', 'top'); track('top');
    const original = [{ ref: 'lower', registrationId: 'lower-registration' }, { ref: 'top', sha: top, addedAt: 'original' }];
    const replacement = { ref: 'top', sha: initial, addedAt: 'replacement' };
    const result = await retire(original, {
      removeOverlay: (r, ref, opts) => {
        register([original[0], replacement]);
        return removeOverlay(r, ref, opts);
      },
    });
    expect(result.retired).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([
      { ...original[0], tipSha: ok('rev-parse', 'origin/lower') }, replacement,
    ]);
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
    const rows = classifyOverlays({ overlays: [{ ref: 'lower' }, { ref: 'top' }, { ref: 'deleted', sha: initial }, { ref: 'unknown' }],
      refEvidence: new Map([['lower', 'refreshed'], ['top', 'refreshed'], ['deleted', 'missing'], ['unknown', 'missing']]), git: (args) => {
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

describe('PR #5964 advisory round: evidence, containment recovery and audit order', () => {
  it('an addOverlay registration retires after its squash-landed branch is deleted', async () => {
    branch('feature');
    commit('feature', 'feature content');
    branch('main');
    localOrigin();
    addOverlay(root, { ref: 'feature', pr: 7 }, { env });
    await prepare();
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['feature']);
    commit('feature', 'feature content');
    ok('push', '-q', 'origin', 'main');
    ok('push', '-q', 'origin', '--delete', 'feature');
    await prepare();
    expect(readOverlayState(root, { env }).overlays).toEqual([]);
    expect(audit().filter((e) => e.kind === 'removed').map((e) => e.ref)).toEqual(['feature']);
  }, 30_000); // two full preparations

  it('classification falls back to a supplied adopted SHA for a confirmed-missing branch', () => {
    const overlays = [{ ref: 'feature' }];
    const refEvidence = new Map([['feature', 'missing']]);
    expect(classifyOverlays({ overlays, git, refEvidence })[0]).toMatchObject({ class: 'needed' });
    expect(classifyOverlays({ overlays, git, refEvidence, recordedShas: new Map([['feature', initial]]) })[0])
      .toMatchObject({ class: 'landed', sha: initial });
  });

  it('re-registered missing branches cannot borrow a previous adopted registration SHA', async () => {
    addOverlay(root, { ref: 'feature' }, { env });
    const overlays = addOverlay(root, { ref: 'feature' }, { env });
    const result = await autoRetireOverlays({ root, env, overlays, git,
      refEvidence: new Map([['feature', 'missing']]), recordedShas: new Map([['feature', initial]]) });
    expect(result.retired).toEqual([]);
    expect(result.kept).toEqual([expect.objectContaining({ ref: 'feature', reason: 'git-unverifiable' })]);
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
  });

  it('removing a container reinstates the overlays retired into it', async () => {
    branch('lower'); const lower = commit('lower', 'lower'); track('lower');
    commit('top', 'top'); track('top');
    await retire([{ ref: 'lower', pr: 1 }, { ref: 'top', pr: 2 }]);
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['top']);
    const removed = removeOverlay(root, 'top', { env, why: 'pr-closed' });
    expect(removed.reinstated).toEqual(['lower']);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'lower', pr: 1, tipSha: lower }]);
    expect(audit()).toContainEqual(expect.objectContaining({ kind: 'reinstated', ref: 'lower', from: 'top', sha: lower }));
  });

  it('a failed reinstatement audit leaves the container and its retired sources registered', async () => {
    branch('lower'); commit('lower', 'lower'); track('lower');
    commit('top', 'top'); track('top');
    await retire([{ ref: 'lower' }, { ref: 'top' }]);
    const before = readOverlayState(root, { env }).overlays;
    const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
    rmSync(file);
    mkdirSync(file);
    expect(() => removeOverlay(root, 'top', { env, why: 'pr-closed' })).toThrow();
    expect(readOverlayState(root, { env }).overlays).toEqual(before);
  });

  it('a plain replacement swap moves the retired sources onto the replacement instead of reinstating them', () => {
    register([{ ref: 'old', retiredSources: [{ entry: { ref: 'src' }, sha: initial }] }, { ref: 'new' }]);
    expect(removeOverlay(root, 'old', { env, requireRef: 'new' }).reinstated).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'new', retiredSources: [{ entry: { ref: 'src' }, sha: initial }] }]);
  });

  it('a source registered again keeps its registration while its own nested sources come back', () => {
    const nested = { entry: { ref: 's', retiredSources: [{ entry: { ref: 'r' }, sha: initial }] }, sha: initial };
    register([{ ref: 's', addedAt: 'again' }, { ref: 'c', retiredSources: [nested] }]);
    expect(removeOverlay(root, 'c', { env }).reinstated).toEqual(['r']);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 's', addedAt: 'again' }, { ref: 'r', tipSha: initial }]);
    expect(audit()).toContainEqual(expect.objectContaining({ kind: 'reinstate-skipped', refs: ['s'], from: 'c' }));
  });

  it('sources reinstated by a landed container retirement wait for the next fetch without alerts or a pinned hold', async () => {
    localOrigin();
    register([{ ref: 'main', retiredSources: [{ entry: { ref: 'gone-src', pinned: true }, sha: initial }] }]);
    const prepared = await prepare();
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'gone-src', pinned: true, tipSha: initial }]);
    expect(prepared.result?.reason).not.toBe('pinned-overlay-unavailable');
    expect(prepared.alerts.filter((a) => a.kind === 'overlay-fetch-unverifiable')).toEqual([]);
  });

  it('a container retired into a later container keeps its own retired sources nested', async () => {
    branch('a'); commit('a', 'a'); track('a');
    commit('b', 'b'); track('b');
    await retire([{ ref: 'a' }, { ref: 'b' }]);
    commit('c', 'c'); track('c');
    const second = [...readOverlayState(root, { env }).overlays, { ref: 'c' }];
    await retire(second);
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['c']);
    expect(removeOverlay(root, 'c', { env }).reinstated).toEqual(['b']);
    expect(removeOverlay(root, 'b', { env }).reinstated).toEqual(['a']);
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['a']);
  });

  it('the planner closing a container on a later tick leaves the retired source registered', async () => {
    branch('lower'); const lower = commit('lower', 'lower');
    branch('top', lower); commit('top', 'top');
    branch('main');
    localOrigin();
    register([{ ref: 'lower', pr: 1 }, { ref: 'top', pr: 2 }]);
    await prepare();
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['top']);
    await prepare({ prState: async (pr) => (pr === 2 ? 'CLOSED' : 'OPEN') });
    expect(readOverlayState(root, { env }).overlays.map((o) => o.ref)).toEqual(['lower']);
  }, 30_000); // two full preparations

  it('on mode writes the audit line before removal and keeps the registration when it cannot', async () => {
    const overlays = [{ ref: 'gone', sha: initial }];
    const result = await retire(overlays, { appendOverlayEvent: () => { throw new Error('disk full'); } });
    expect(result.retired).toEqual([]);
    expect(result.kept).toEqual([expect.objectContaining({ ref: 'gone', reason: 'retirement-unverifiable' })]);
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
  });

  it('on mode reports a post-removal audit failure instead of swallowing it', async () => {
    const result = await retire([{ ref: 'gone', sha: initial }], {
      appendOverlayEvent: (r, event, o) => {
        if (event.kind === 'removed') throw new Error('disk full');
        return appendOverlayEvent(r, event, o);
      },
    });
    expect(result.retired.map((r) => r.ref)).toEqual(['gone']);
    expect(result.auditFailures).toEqual([expect.objectContaining({ ref: 'gone', error: 'disk full' })]);
    expect(audit()).toEqual([expect.objectContaining({ kind: 'retiring', ref: 'gone', sha: initial })]);
  });

  it('reports an overlay-retired daemon event failure in auditFailures after removal', async () => {
    const events = [];
    const result = await retire([{ ref: 'gone', sha: initial }], {
      appendDaemonEvent: async (event) => { events.push(event); throw new Error('daemon event disk full'); },
    });
    expect(events).toEqual([expect.objectContaining({ kind: 'overlay-retired', detail: { ref: 'gone', reason: 'ancestor-of-main' } })]);
    expect(result.retired.map((r) => r.ref)).toEqual(['gone']);
    expect(result.kept).toEqual([]);
    expect(result.auditFailures).toEqual([{ ref: 'gone', kind: 'overlay-retired', error: 'daemon event disk full' }]);
    expect(readOverlayState(root, { env }).overlays).toEqual([]);
    expect(audit().map((e) => e.kind)).toEqual(['retiring', 'removed']);
  });

  it('reports a refreshed tip persistence failure in auditFailures', async () => {
    branch('feature'); commit('feature', 'needed'); track('feature');
    const result = await retire([{ ref: 'feature' }], { refEvidence: new Map([['feature', 'refreshed']]),
      persistTipShas: () => { throw new Error('tip disk full'); } });
    expect(result.retired).toEqual([]);
    expect(result.auditFailures).toEqual([{ ref: null, kind: 'tip-sha', error: 'tip disk full' }]);
  });
});

describe('policy cascade and explicit shadow promotion', () => {
  it.each(['off', 'on'])('explicit environment %s remains unchanged after the tool cutoff', (mode) => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    expect(resolveAutoRetireMode(env, { now: '2026-10-29T12:00:00Z' })).toMatchObject({ mode, source: 'env' });
  });
  it.each(['standard', 'platform', 'tool', 'env'])('%s shadow stays observe-only regardless of a legacy graduation date', (source) => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    const settingsPath = join(base, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoRetire: {
      shadowSince: '2026-10-26T12:00:00Z', ...(['tool', 'env'].includes(source) ? { mode: 'shadow' } : {}),
    } }));
    if (source === 'platform') writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ autoRetire: { mode: 'shadow' } }));
    if (source === 'env') env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    for (const now of ['2026-10-27T11:59:59Z', '2026-10-27T12:00:00Z', '2026-10-29T12:00:00Z']) {
      expect(resolveAutoRetireMode(env, { settingsPath, now })).toMatchObject({
        mode: 'shadow', source,
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

  it('defaults and shipped settings remain shadow until explicitly promoted, even years after deployment', () => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    expect(resolveAutoRetireMode(env, { settingsPath: join(base, 'missing') }).mode).toBe('shadow');
    for (const now of ['2026-10-27T11:59:59Z', '2026-10-27T12:00:00Z', '2036-10-28T12:00:00Z']) {
      expect(resolveAutoRetireMode(env, { now })).toMatchObject({ mode: 'shadow', source: 'tool' });
    }
  });

  it('shipped shadow preserves registrations on the first tick long after the former cutoff', async () => {
    delete env.WE_DAEMON_OVERLAY_AUTO_RETIRE;
    const overlays = [{ ref: 'deleted', sha: initial }];
    const result = await retire(overlays, { now: () => Date.parse('2036-10-28T12:00:00Z') });
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire.map(row => row.ref)).toEqual(['deleted']);
    expect(readOverlayState(root, { env }).overlays).toEqual(overlays);
    expect(audit()).toContainEqual(expect.objectContaining({ kind: 'auto-retire-shadow', mode: 'shadow', source: 'tool' }));
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

  it('off keeps even landed overlays without Git, audit, removal or persistence calls', async () => {
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    const calls = [];
    const forbidden = (kind) => () => { calls.push(kind); throw new Error(`off invoked ${kind}`); };
    const result = await retire([{ ref: 'gone', sha: initial }], {
      git: forbidden('git'), appendOverlayEvent: forbidden('audit'), appendDaemonEvent: forbidden('event'),
      removeOverlay: forbidden('remove'), persistTipShas: forbidden('tips'),
      refEvidence: new Map([['gone', 'refreshed']]),
    });
    expect(result.retired).toEqual([]);
    expect(result.wouldRetire).toEqual([]);
    expect(result.kept).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(result.auditFailures).toEqual([]);
    expect(readOverlayState(root, { env }).overlays).toEqual([{ ref: 'gone', sha: initial }]);
  });
});
