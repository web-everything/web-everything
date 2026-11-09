import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { withWriteLock } from '../../lib/daemon-clone-lock.mjs';
import { writeReadyCandidate, readReadyCandidate, readRebuildState, writeRebuildState, rebuildStatePath } from '../../lib/daemon-rebuild/state.mjs';
import { writeOverlays } from '../../lib/daemon-overlays.mjs';
import { createRebuildAdoptOverrideSinks } from '../rebuild-adopt-override-io.mjs';
import { REBUILD_ADOPT_OVERRIDE_EFFECT } from '../rebuild-adopt-override.mjs';

describe('rebuild-adopt-override real IO', () => {
  it('rejects invalid main ancestry without adopting or consuming readiness', async () => {
    await withRealRepo(async ({ root, tmp, head, git, commit }) => {
      const prevHead = head();
      git(['update-ref', 'refs/remotes/origin/main', prevHead]);
      const sha = commit({ 'candidate.txt': 'not on origin/main\n' });
      git(['reset', '--hard', prevHead]);
      await expectRealVerificationRefusal({ root, tmp, head, sha,
        ready: { passedAt: new Date().toISOString(), prevHead, adopt: { finalSha: sha, mainSha: sha, applied: [] } },
      });
    });
  });

  it('rejects an unapproved overlay edge without adopting or consuming readiness', async () => {
    await withRealRepo(async ({ root, tmp, head, git, commit }) => {
      const prevHead = head();
      git(['update-ref', 'refs/remotes/origin/main', prevHead]);
      const overlaySha = commit({ 'overlay.txt': 'overlay\n' });
      const edgeSha = commit({ 'edge.txt': 'unapproved resolution\n' });
      const ref = 'ops/fixture-overlay';
      git(['update-ref', `refs/remotes/origin/${ref}`, overlaySha]);
      const tree = head(`${edgeSha}^{tree}`);
      const sha = git(['commit-tree', tree, '-p', prevHead, '-p', overlaySha, '-p', edgeSha,
        '-m', 'fixture: candidate with unapproved edge']).trim();
      git(['reset', '--hard', prevHead]);
      await expectRealVerificationRefusal({ root, tmp, head, sha,
        ready: { passedAt: new Date().toISOString(), prevHead, adopt: { finalSha: sha, mainSha: prevHead,
          applied: [{ ref, sha: overlaySha, resolvedVia: 'edge-ref', edgeSha }] } },
      });
    });
  });

  it('rejects an unverified ready build without finalizing or consuming readiness', async () => {
    await withRealRepo(async ({ root, tmp, head, git }) => {
      const sha = head();
      git(['update-ref', 'refs/remotes/origin/main', sha]);
      const env = { ...process.env, WE_DAEMON_STATE_DIR: join(tmp, 'state'), WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') };
      const ready = { passedAt: new Date().toISOString(), prevHead: sha, adopt: { finalSha: sha, mainSha: sha, applied: [], inputsKey: 'fixture' } };
      writeRebuildState(root, { rejected: null }, env);
      expect(writeReadyCandidate(root, ready, env)).toBe(true);
      const verifyBuilt = vi.fn(() => false);
      const finalizeRebuild = vi.fn();
      const appendOverlayEvent = vi.fn();
      const invoke = createRebuildAdoptOverrideSinks({ env, resolveRoot: () => root,
        withWriteLock: (path, fn) => withWriteLock(path, fn, { lockRoot: join(tmp, 'locks') }),
        verifyBuilt, finalizeRebuild, appendOverlayEvent,
      })[REBUILD_ADOPT_OVERRIDE_EFFECT];

      await expect(invoke({ sha })).rejects.toThrow(/not verified/);
      expect(verifyBuilt).toHaveBeenCalledTimes(1);
      expect(finalizeRebuild).not.toHaveBeenCalled();
      expect(appendOverlayEvent).not.toHaveBeenCalled();
      expect(readReadyCandidate(root, env)).toEqual(ready);
      expect(readRebuildState(root, env).adopted).toBeNull();
      expect(head()).toBe(sha);
    });
  });

  it.each(['missing', 'corrupt', 'null', 'array'])('refuses %s persisted rebuild state without writes', async stateKind => {
    await withRealRepo(async ({ root, tmp, head, git }) => {
      const sha = head();
      git(['update-ref', 'refs/remotes/origin/main', sha]);
      const env = { ...process.env, WE_DAEMON_STATE_DIR: join(tmp, 'state'), WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') };
      const ready = { passedAt: new Date().toISOString(), prevHead: sha,
        adopt: { finalSha: sha, mainSha: sha, applied: [], inputsKey: 'fixture' } };
      expect(writeReadyCandidate(root, ready, env)).toBe(true);
      if (stateKind !== 'missing') {
        mkdirSync(env.WE_DAEMON_STATE_DIR, { recursive: true });
        writeFileSync(rebuildStatePath(root, env), { corrupt: '{bad', null: 'null', array: '[]' }[stateKind]);
      }
      const finalizeRebuild = vi.fn(), appendOverlayEvent = vi.fn();
      const invoke = createRebuildAdoptOverrideSinks({ env, resolveRoot: () => root,
        withWriteLock: (path, fn) => withWriteLock(path, fn, { lockRoot: join(tmp, 'locks') }),
        finalizeRebuild, appendOverlayEvent,
      })[REBUILD_ADOPT_OVERRIDE_EFFECT];
      await expect(invoke({ sha })).rejects.toThrow(/unreadable rebuild state/);
      expect(finalizeRebuild).not.toHaveBeenCalled();
      expect(appendOverlayEvent).not.toHaveBeenCalled();
      expect(readReadyCandidate(root, env)).toEqual(ready);
      expect(head()).toBe(sha);
    });
  });

  it('verifies real git ancestry and persists adoption while consuming the ready record exactly once', async () => {
    await withRealRepo(async ({ root, tmp, head, git }) => {
      const sha = head();
      git(['update-ref', 'refs/remotes/origin/main', sha]);
      const env = { ...process.env, WE_DAEMON_STATE_DIR: join(tmp, 'state'), WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') };
      writeRebuildState(root, { rejected: null }, env);
      writeReadyCandidate(root, { passedAt: new Date().toISOString(), prevHead: sha, adopt: { finalSha: sha, mainSha: sha, applied: [], inputsKey: 'fixture' } }, env);
      const invoke = createRebuildAdoptOverrideSinks({ env, resolveRoot: () => root,
        withWriteLock: (path, fn) => withWriteLock(path, fn, { lockRoot: join(tmp, 'locks') }),
      })[REBUILD_ADOPT_OVERRIDE_EFFECT];

      await expect(invoke({ sha })).resolves.toMatchObject({ adopted: true });
      expect(readRebuildState(root, env).adopted).toMatchObject({ head: sha, inputsKey: 'fixture' });
      expect(readReadyCandidate(root, env)).toBeNull();
      await expect(invoke({ sha })).rejects.toThrow(/no ready record/);
    });
  });
});

/** Keep the real reader, git runner and verifier; spy only on effects that must remain unreachable. */
async function expectRealVerificationRefusal({ root, tmp, head, sha, ready }) {
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(tmp, 'state'), WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') };
  writeRebuildState(root, { rejected: null }, env);
  writeOverlays(root, ready.adopt.applied.map(({ ref }) => ({ ref })), { env });
  expect(writeReadyCandidate(root, ready, env)).toBe(true);
  const finalizeRebuild = vi.fn();
  const appendOverlayEvent = vi.fn();
  const invoke = createRebuildAdoptOverrideSinks({ env, resolveRoot: () => root,
    withWriteLock: (path, fn) => withWriteLock(path, fn, { lockRoot: join(tmp, 'locks') }),
    finalizeRebuild, appendOverlayEvent,
  })[REBUILD_ADOPT_OVERRIDE_EFFECT];

  await expect(invoke({ sha })).rejects.toThrow(/not verified/);
  expect(finalizeRebuild).not.toHaveBeenCalled();
  expect(appendOverlayEvent).not.toHaveBeenCalled();
  expect(readReadyCandidate(root, env)).toEqual(ready);
  expect(readRebuildState(root, env).adopted).toBeNull();
  expect(head()).toBe(ready.prevHead);
}
