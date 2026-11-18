import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBareOrigin } from '../../operations/__tests__/helpers/real-repo.mjs';
import { supersededOverlays } from '../daemon-rebuild/plan.mjs';
import { previewOverlayConflict } from '../daemon-rebuild/preview.mjs';
import { addOverlay, readOverlays, cloneKey } from '../daemon-overlays.mjs';
import { supersessionTipsCurrent, registerSuperseding, settlePendingDrops, readPendingDrops } from '../../daemon-overlay.mjs';

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
    addOverlay(f.clone, { ref: 'lane/old' }, { env });
    await fn({ ...f, repoGit: f.git, env, git, sha, main, candidate, entries: readOverlays(f.clone, { env }) });
  });
}

describe('strict containment supersession', () => {
  it('atomically supersedes a strict ancestor and records both verified tips', async () => fixture(async f => {
    const proof = supersededOverlays(f.git, f.entries, f.main, f.candidate);
    expect(proof).toEqual([{ entry: f.entries[0], oldTip: f.sha('lane/old'), newTip: f.candidate }]);
    addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: proof });
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
    expect(() => addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: proof })).toThrow('supersession evidence changed');
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
      register() { const list = addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: check.superseded }); written = true; return list; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'supersession-raced-restored' });
    expect(readOverlays(f.clone, { env: f.env }).map(o => o.ref).sort()).toEqual(['lane/new', 'lane/old']);
    expect(readPendingDrops(f.clone, f.env)).toEqual([]);
  }));

  it('recovers an interrupted supersession using the existing durable drop intent', async () => fixture(async f => {
    const check = { candSha: f.candidate, superseded: supersededOverlays(f.git, f.entries, f.main, f.candidate) };
    await expect(registerSuperseding({ root: f.clone, ref: 'lane/new', check, env: f.env,
      tip: ({ ref }) => ref === 'lane/new' ? f.candidate : f.sha('lane/old'),
      register() { addOverlay(f.clone, { ref: 'lane/new' }, { env: f.env, superseded: check.superseded }); throw new Error('interrupted'); },
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

  it('excludes conflicting ancestor registrations before folding the candidate', async () => fixture(async f => {
    f.seedOriginBranch('lane/conflicting', { 'fix.txt': 'conflicting work\n' });
    f.seedOriginBranch('lane/resolved', { 'fix.txt': 'resolved work\n' }, 'lane/new');
    const tree = f.repoGit(['rev-parse', 'lane/resolved^{tree}'], { cwd: f.origin }).trim();
    const candidate = f.repoGit(['commit-tree', tree, '-p', 'lane/new', '-p', 'lane/conflicting', '-m', 'resolved superset'], { cwd: f.origin }).trim();
    f.repoGit(['update-ref', 'refs/heads/lane/resolved', candidate], { cwd: f.origin });
    addOverlay(f.clone, { ref: 'lane/conflicting' }, { env: f.env });
    const entries = readOverlays(f.clone, { env: f.env });
    const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/resolved', existingOverlays: entries, env: f.env });
    expect(result).toMatchObject({ ok: true, clean: true, candSha: candidate });
    expect(result.superseded.map(s => s.entry.ref)).toEqual(['lane/old', 'lane/conflicting']);
  }));

  it('uses the ledger union in the loader conflict preview', async () => fixture(async f => {
    f.seedOriginBranch('main', { 'docs/agent/testing.md': '# Tests\n' });
    f.seedOriginBranch('lane/notes-a', { 'docs/agent/testing.md': '# Tests\nA\nshared\n' });
    f.seedOriginBranch('lane/notes-b', { 'docs/agent/testing.md': '# Tests\nB\nshared\n' });
    const result = await previewOverlayConflict({ root: f.clone, ref: 'lane/notes-b', existingOverlays: [{ ref: 'lane/notes-a' }], env: f.env });
    expect(result).toMatchObject({ ok: true, clean: true });
  }));
});
