import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBareOrigin } from '../../operations/__tests__/helpers/real-repo.mjs';
import { supersededOverlays } from '../daemon-rebuild/plan.mjs';
import { REBUILD_IDENTITY_ENV } from '../daemon-rebuild/shared.mjs';
import { previewOverlayConflict } from '../daemon-rebuild/preview.mjs';
import { addOverlay, readOverlays, cloneKey, overlayFilePath } from '../daemon-overlays.mjs';
import { supersessionTipsCurrent, registerSuperseding, settlePendingDrops, readPendingDrops, remoteTip } from '../../daemon-overlay.mjs';

async function fixture(fn) {
  return withBareOrigin(async f => {
    const env = { ...process.env, TMPDIR: f.tmp, WE_DAEMON_OVERLAY_DIR: join(f.tmp, 'overlays'),
      WE_DAEMON_OVERLAY_STACK_BASES: '{}', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    f.seedOriginBranch('lane/old', { 'fix.txt': 'old work\n' });
    f.seedOriginBranch('lane/new', { 'new.txt': 'new work\n' }, 'lane/old');
    f.seedOriginBranch('lane/peer', { 'peer.txt': 'other work\n' });
    f.seedOriginBranch('lane/mechanism', { 'scripts/lib/daemon-overlays.mjs': 'mechanism\n' });
    f.seedOriginBranch('lane/mechanism-new', { 'new.txt': 'new\n' }, 'lane/mechanism');
    f.git(['fetch', 'origin']);
    const git = args => spawnSync('git', args, { cwd: f.clone, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    const sha = ref => f.git(['rev-parse', `origin/${ref}`]).trim();
    const main = sha('main'), candidate = sha('lane/new');
    env.WE_FIX_READY_PATH = join(f.tmp, 'ready.jsonl');
    writeFileSync(env.WE_FIX_READY_PATH, JSON.stringify({ ref: 'lane/old', sha: sha('lane/old'), tests: 'green', audit: 'NOT WEAKENED' }) + '\n');
    addOverlay(f.clone, { ref: 'lane/old' }, { env });
    await fn({ ...f, repoGit: f.git, env, git, sha, main, candidate, entries: readOverlays(f.clone, { env }) });
  });
}

describe('strict containment supersession', () => {
  function adopt(f, sha, ref = 'lane/old', pr = null, extraParents = []) {
    const head = f.repoGit(['rev-parse', 'HEAD']).trim();
    const tree = f.repoGit(['rev-parse', `${sha}^{tree}`]).trim();
    const build = f.repoGit(['commit-tree', tree, '-p', head, '-p', sha,
      ...extraParents.flatMap(parent => ['-p', parent]),
      '-m', `daemon-rebuild: merge overlay ${ref} ${pr === null ? '' : `(PR #${pr}) `}onto main`],
    { env: { ...f.env, ...REBUILD_IDENTITY_ENV } }).trim();
    f.repoGit(['update-ref', 'HEAD', build]);
    return build;
  }

  it.each(['running build', 'earlier applied head', 'previous build', 'graduated head', 'edge carried head'])(
    'retains a force-pushed registration when the candidate lacks its %s', async source => fixture(async f => {
      const old = f.sha('lane/old');
      adopt(f, old);
      if (source === 'previous build') f.repoGit(['update-ref', 'HEAD', f.main]);
      if (source === 'graduated head') f.seedOriginBranch('main', {}, 'lane/old');
      // Force the existing planner's adopted-head pin: the new tip conflicts with main,
      // while the previously adopted work still merges cleanly. Preserve that refusal.
      if (source === 'running build') f.seedOriginBranch('main', { 'guard.txt': 'live main\n' });
      f.seedOriginBranch('lane/old', { 'fix.txt': 'rewritten work\n',
        ...(source === 'running build' ? { 'guard.txt': 'candidate guard\n' } : {}) }, f.main);
      // A graduated head must still be contained even if the new tip is based on older main.
      if (source === 'graduated head') f.seedOriginBranch('lane/old', { 'fix.txt': 'rewritten work\n' }, f.main);
      f.seedOriginBranch('lane/new', { 'new.txt': 'new work\n' }, 'lane/old');
      f.repoGit(['fetch', 'origin']);
      if (source === 'running build') {
        expect(f.git(['merge-tree', '--write-tree', f.sha('main'), f.sha('lane/old')]).status).toBe(1);
        expect(f.git(['merge-tree', '--write-tree', f.sha('main'), old]).status).toBe(0);
      }
      if (source === 'earlier applied head') adopt(f, f.sha('lane/old'));
      if (source === 'edge carried head') {
        f.repoGit(['update-ref', 'HEAD', f.main]);
        adopt(f, f.sha('lane/old'), 'lane/old', null, [old]);
      }
      expect(supersededOverlays(f.git, f.entries, f.sha('main'), f.sha('lane/new'))).toEqual([]);
      const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/new', existingOverlays: f.entries, env: f.env });
      expect(result.superseded ?? []).toEqual([]);
      if (source === 'running build') expect(result).not.toMatchObject({ ok: true, clean: true });
      expect(readOverlays(f.clone, { env: f.env })).toEqual(f.entries);
    }),
  );

  it('supersedes when the candidate contains every adopted head', async () => fixture(async f => {
    adopt(f, f.sha('lane/old'));
    adopt(f, f.candidate);
    expect(supersededOverlays(f.git, f.entries, f.main, f.candidate)).toHaveLength(1);
  }));

  it.each(['log', 'reflog', 'adopted object', 'carried ancestry', 'empty history', 'malformed history', 'malformed reflog'])(
    'retains the registration when %s evidence cannot be resolved', async probe => fixture(async f => {
      const old = f.sha('lane/old');
      adopt(f, old);
      // The missing adopted object is distinct from the current registration tip.
      f.repoGit(['update-ref', 'refs/remotes/origin/lane/old', f.candidate]);
      f.seedOriginBranch('lane/top', { 'top.txt': 'top\n' }, 'lane/new');
      f.repoGit(['fetch', 'origin']);
      f.repoGit(['update-ref', 'refs/remotes/origin/lane/old', f.candidate]);
      const git = args => {
        if (args[0] === 'log' && probe === 'empty history') return { status: 0, stdout: '' };
        if (args[0] === 'log' && probe === 'malformed history') return { status: 0, stdout: 'unreadable record\n' };
        if (args[0] === 'reflog' && probe === 'malformed reflog') return { status: 0, stdout: 'missing-head\n' };
        return (args[0] === probe
          || (probe === 'adopted object' && args[0] === 'rev-parse' && args.at(-1) === `${old}^{commit}`)
          || (probe === 'carried ancestry' && args[0] === 'merge-base' && args[1] === '--all'))
          ? { status: 128 } : f.git(args);
      };
      expect(supersededOverlays(f.git, f.entries, f.main, f.sha('lane/top'))).toHaveLength(1);
      expect(supersededOverlays(git, f.entries, f.main, f.sha('lane/top'))).toEqual([]);
    }),
  );

  it.each(['advanced adopted tip', 'graduated tip', 'no adopted history', 'follow mode'])(
    'round 3: refuses supersession of an unaudited %s', async kind => fixture(async f => {
      const old = f.sha('lane/old');
      if (kind !== 'no adopted history') adopt(f, old);
      if (kind === 'graduated tip') f.seedOriginBranch('main', {}, 'lane/old');
      if (kind === 'follow mode') f.env.WE_DAEMON_OVERLAY_FOLLOW_TIP = 'follow';
      if (kind !== 'no adopted history') {
        f.seedOriginBranch('lane/old', { 'advance.txt': 'unaudited work\n' }, 'lane/old');
        f.seedOriginBranch('lane/new', { 'next.txt': 'candidate\n' }, 'lane/old');
      }
      f.env.WE_FIX_READY_PATH = join(f.tmp, 'missing-audits');
      const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/new', existingOverlays: f.entries, env: f.env });
      expect(result).toMatchObject({ ok: false, reason: 'supersession-unaudited-tip', detail: { ref: 'lane/old' } });
      expect(readOverlays(f.clone, { env: f.env })).toEqual(f.entries);
    }),
  );

  it.each(['moved tip', 'moved candidate', 'unknown tip', 'changed entry', 'changed recorded tip', 'replaced lock', 'missing probe'])(
    'round 3: rechecks %s under the registry lock before supersession', async kind => fixture(async f => {
      const proof = supersededOverlays(f.git, f.entries, f.main, f.candidate);
      let probed = false;
      const supersessionTip = ({ ref }) => {
        expect(existsSync(`${overlayFilePath(f.clone, f.env)}.lock`)).toBe(true);
        probed = true;
        if (kind === 'replaced lock') {
          rmdirSync(`${overlayFilePath(f.clone, f.env)}.lock`);
          mkdirSync(`${overlayFilePath(f.clone, f.env)}.lock`);
        }
        if (kind === 'changed entry' || kind === 'changed recorded tip') {
          const file = overlayFilePath(f.clone, f.env);
          const state = JSON.parse(readFileSync(file, 'utf8'));
          if (kind === 'changed recorded tip') state.overlays[0].tip = f.main;
          else state.overlays[0].reason = 'new registration';
          writeFileSync(file, JSON.stringify(state));
        }
        return ref === 'lane/new' ? (kind === 'moved candidate' ? f.main : f.candidate) : kind === 'unknown tip' ? undefined
          : kind === 'moved tip' ? f.main : f.sha('lane/old');
      };
      expect(() => addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: proof,
        ...(kind === 'missing probe' ? {} : { supersessionTip }) })).toThrow(/supersession/);
      expect(probed).toBe(kind !== 'missing probe');
      if (kind === 'replaced lock') expect(existsSync(`${overlayFilePath(f.clone, f.env)}.lock`)).toBe(true);
      expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref)).toEqual(['lane/old']);
    }),
  );

  it('atomically supersedes a strict ancestor and records both verified tips', async () => fixture(async f => {
    const proof = supersededOverlays(f.git, f.entries, f.main, f.candidate);
    expect(proof).toEqual([{ entry: f.entries[0], oldTip: f.sha('lane/old'), newTip: f.candidate }]);
    addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: proof, supersessionTip: remoteTip });
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref)).toEqual(['lane/new']);
    const events = readFileSync(join(f.env.WE_DAEMON_OVERLAY_DIR, `${cloneKey(f.clone)}.events.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'overlay-superseded', ref: 'lane/old', replacedBy: 'lane/new', oldTip: f.sha('lane/old'), newTip: f.candidate }));
  }));

  it.each(['equal tip', 'non-ancestor', 'explicit pin', 'mechanism pin', 'missing object', 'short sha', 'git error', 'thrown git error', 'pin probe error', 'ancestry probe error', 'unresolved registered tip', 'edge resolution'])(
    'does not supersede on %s', async kind => fixture(async f => {
      let candidate = f.candidate, entries = f.entries, git = f.git;
      if (kind === 'equal tip') candidate = f.sha('lane/old');
      if (kind === 'non-ancestor') candidate = f.sha('lane/peer');
      if (kind === 'explicit pin') entries = entries.map(o => ({ ...o, pinned: true }));
      if (kind === 'edge resolution') entries = entries.map(o => ({ ...o, edgeResolution: { sha: f.sha('lane/peer') } }));
      if (kind === 'mechanism pin') { entries = [{ ref: 'lane/mechanism' }]; candidate = f.sha('lane/mechanism-new'); }
      if (kind === 'missing object') candidate = 'f'.repeat(40);
      if (kind === 'short sha') candidate = candidate.slice(0, 10);
      if (kind === 'git error') git = () => ({ status: 128 });
      if (kind === 'thrown git error') git = () => { throw new Error('unreadable'); };
      if (kind === 'pin probe error') git = args => args[0] === 'diff' ? { status: 128 } : f.git(args);
      if (kind === 'ancestry probe error') git = args => args[0] === 'merge-base' && args[1] === '--is-ancestor' ? { status: 128 } : f.git(args);
      if (kind === 'unresolved registered tip') entries = [{ ref: 'lane/missing' }];
      expect(supersededOverlays(git, entries, f.main, candidate)).toEqual([]);
      expect(readOverlays(f.clone, { env: f.env })).toEqual(f.entries);
    }),
  );

  it('refuses changed registry evidence without writing the candidate', async () => fixture(async f => {
    const proof = supersededOverlays(f.git, f.entries, f.main, f.candidate);
    addOverlay(f.clone, { ref: 'lane/old', pinned: true }, { env: f.env });
    expect(() => addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: proof, supersessionTip: remoteTip })).toThrow('supersession evidence changed');
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref)).toEqual(['lane/old']);
  }));

  it.each(['moved old tip', 'moved candidate', 'unreadable old tip'])('refuses %s after preview', async kind => fixture(async f => {
    const check = { candSha: f.candidate, superseded: supersededOverlays(f.git, f.entries, f.main, f.candidate) };
    const tip = ({ ref }) => ref === 'lane/new'
      ? (kind === 'moved candidate' ? f.main : f.candidate)
      : (kind === 'unreadable old tip' ? undefined : f.main);
    expect(supersessionTipsCurrent({ root: f.clone, ref: 'lane/new', check, env: f.env, tip })).toBe(false);
    expect(readOverlays(f.clone, { env: f.env })).toEqual(f.entries);
  }));

  it('round 3: a loader add refuses supersession discovered by its live guard', async () => fixture(async f => {
    const result = spawnSync(process.execPath, ['scripts/daemon-overlay.mjs', 'add', `--clone=${f.clone}`, '--ref=lane/new',
      '--pr=7118', `--expected-sha=${f.candidate}`, '--refuse-supersede', '--json'],
    { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1))).toMatchObject({
      conflictCheck: { ok: false, reason: 'mutable-registration' },
    });
    expect(readOverlays(f.clone, { env: f.env })).toEqual(f.entries);
  }));

  it('the real add CLI supersedes and reports the old registration without a retirement ruling', async () => fixture(async f => {
    const result = spawnSync(process.execPath, ['scripts/daemon-overlay.mjs', 'add', `--clone=${f.clone}`, '--ref=lane/new',
      '--pr=7118', `--expected-sha=${f.candidate}`, '--json'], { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    expect(output.conflictCheck.superseded).toHaveLength(1);
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref)).toEqual(['lane/new']);
  }));

  it.each(['moved', 'unreadable'])('restores a superseded registration if its tip is %s after writing', async kind => fixture(async f => {
    const check = { candSha: f.candidate, superseded: supersededOverlays(f.git, f.entries, f.main, f.candidate) };
    let written = false;
    const result = await registerSuperseding({ root: f.clone, ref: 'lane/new', check, env: f.env,
      tip: ({ ref }) => ref === 'lane/new' ? f.candidate : written ? (kind === 'moved' ? f.main : undefined) : f.sha('lane/old'),
      register() { const list = addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: check.superseded, supersessionTip: remoteTip }); written = true; return list; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'supersession-raced-restored' });
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref).sort()).toEqual(['lane/new', 'lane/old']);
    expect(readPendingDrops(f.clone, f.env)).toEqual([]);
  }));

  it('recovers an interrupted supersession using the existing durable drop intent', async () => fixture(async f => {
    const check = { candSha: f.candidate, superseded: supersededOverlays(f.git, f.entries, f.main, f.candidate) };
    await expect(registerSuperseding({ root: f.clone, ref: 'lane/new', check, env: f.env,
      tip: ({ ref }) => ref === 'lane/new' ? f.candidate : f.sha('lane/old'),
      register() { addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: check.superseded, supersessionTip: remoteTip }); throw new Error('interrupted'); },
    })).rejects.toThrow('interrupted');
    expect(readPendingDrops(f.clone, f.env)).toHaveLength(1);
    expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => undefined } })).toEqual([{ ref: 'lane/old', outcome: 'restored' }]);
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref).sort()).toEqual(['lane/new', 'lane/old']);
  }));

  it('previews a contained registration as superseded', async () => fixture(async f => {
    const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/new', existingOverlays: f.entries, env: f.env });
    expect(result).toMatchObject({ ok: true, clean: true, candSha: f.candidate,
      superseded: [{ entry: f.entries[0], oldTip: f.sha('lane/old'), newTip: f.candidate }] });
  }));

  it('keeps a contained overlay in the fold on re-registration but supersedes it for a new candidate', async () => fixture(async f => {
    const fresh = await previewOverlayConflict({ root: f.clone, ref: 'lane/new', existingOverlays: f.entries, env: f.env });
    expect(fresh).toMatchObject({ ok: true, clean: true, cur: f.main, candSha: f.candidate,
      setAside: [], superseded: [{ entry: f.entries[0], oldTip: f.sha('lane/old'), newTip: f.candidate }] });

    addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env });
    const entries = readOverlays(f.clone, { env: f.env });
    const registered = await previewOverlayConflict({ root: f.clone, ref: 'lane/new', existingOverlays: entries, env: f.env });
    expect(registered).toMatchObject({ ok: true, clean: true, candSha: f.candidate, setAside: [], superseded: [] });
    expect(registered.cur).not.toBe(f.main);
    expect(readOverlays(f.clone, { env: f.env })).toEqual(entries);
  }));

  it('excludes conflicting ancestor registrations before folding the candidate', async () => fixture(async f => {
    f.seedOriginBranch('lane/conflicting', { 'fix.txt': 'conflicting work\n' });
    f.seedOriginBranch('lane/resolved', { 'fix.txt': 'resolved work\n' }, 'lane/new');
    const tree = f.repoGit(['rev-parse', 'lane/resolved^{tree}'], { cwd: f.origin }).trim();
    const candidate = f.repoGit(['commit-tree', tree, '-p', 'lane/new', '-p', 'lane/conflicting', '-m', 'resolved superset'], { cwd: f.origin }).trim();
    f.repoGit(['update-ref', 'refs/heads/lane/resolved', candidate], { cwd: f.origin });
    addOverlay(f.clone, { ref: 'lane/conflicting' }, { env: f.env });
    writeFileSync(f.env.WE_FIX_READY_PATH, ['lane/old', 'lane/conflicting'].map(ref => JSON.stringify({ ref, sha: f.repoGit(['rev-parse', ref], { cwd: f.origin }).trim(), tests: 'green', audit: 'NOT WEAKENED' })).join('\n'));
    const entries = readOverlays(f.clone, { env: f.env });
    const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/resolved', existingOverlays: entries, env: f.env });
    expect(result).toMatchObject({ ok: true, clean: true, candSha: candidate });
    expect(result.superseded.map(s => s.entry.ref)).toEqual(['lane/old', 'lane/conflicting']);
  }));

  it('uses the ledger union in the loader conflict preview', async () => fixture(async f => {
    f.seedOriginBranch('main', { 'docs/agent/testing.md': '# Tests\n' });
    f.seedOriginBranch('lane/notes-a', { 'docs/agent/testing.md': '# Tests\n- A\n- shared\n' });
    f.seedOriginBranch('lane/notes-b', { 'docs/agent/testing.md': '# Tests\n- B\n- shared\n' });
    const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/notes-b', existingOverlays: [{ ref: 'lane/notes-a' }], env: f.env });
    expect(result).toMatchObject({ ok: true, clean: true });
  }));
});
