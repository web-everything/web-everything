/** Refresh stale overlay tips exclusively in disposable checkouts; only clean two-parent merges may be registered. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../policy-cascade.mjs';
import { gitRun } from '../main-staleness.mjs';
import { replaceOverlayRef } from '../daemon-overlays.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { makeGit, verifyRev, rebuildCommitEnv } from './shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export function resolveOverlayRefreshSettings(env = process.env, { settingsPath = join(HERE, '../daemon-rebuild-settings.json') } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8'))?.overlay; } catch { /* unset */ }
  const raw = env.WE_DAEMON_OVERLAY_AUTO_REFRESH?.trim();
  const boolean = ['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : undefined;
  const r = cascadePolicy('overlay', tool, {
    env, standard: { autoRefresh: true },
    envValues: { autoRefresh: boolean },
    valid: { autoRefresh: (v) => typeof v === 'boolean' },
  });
  return { autoRefresh: r.value.autoRefresh,
    sources: { autoRefresh: r.sources.autoRefresh } };
}

// Scratch processes ignore host configuration, hooks, filters and repository attributes.
const SCRATCH_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgSign=false'];
function scratchEnv(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1' };
}

/** One lazy isolated checkout per tick; callers own cleanup even if setup or a probe throws. */
export function createOverlayScratch({ root, env = process.env, run = gitRun, createScratch } = {}) {
  let scratch, setupError;
  const isolatedEnv = scratchEnv(env);
  const scratchRun = (args, opts) => run([...SCRATCH_FLAGS, ...args], { ...opts, env: { ...isolatedEnv, ...opts?.env } });
  return {
    async git() {
      if (setupError) throw setupError;
      try {
        if (!scratch) {
          if (createScratch) scratch = await createScratch({ root });
          else {
            const dir = mkdtempSync(join(tmpdir(), 'we-overlay-refresh-'));
            scratch = { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
            const clone = scratchRun(['clone', '--shared', '--no-checkout', '--template=/dev/null', root, dir], { cwd: tmpdir() });
            if (clone.status !== 0) throw new Error('Scratch clone failed');
            const url = makeGit({ run, cwd: root, env })(['remote', 'get-url', 'origin']);
            if (url.status !== 0) throw new Error('Origin unresolved');
            const configured = scratchRun(['remote', 'set-url', 'origin', String(url.stdout).trim()], { cwd: dir });
            if (configured.status !== 0) throw new Error('Scratch origin setup failed');
          }
          mkdirSync(join(scratch.root, '.git', 'info'), { recursive: true });
          writeFileSync(join(scratch.root, '.git', 'info', 'attributes'), '* !filter !merge !diff !text !eol !ident !working-tree-encoding\n');
        }
      } catch (error) {
        setupError = error;
        throw error;
      }
      return makeGit({ run: scratchRun, cwd: scratch.root, env: isolatedEnv });
    },
    get root() { return scratch?.root; },
    async cleanup() { if (scratch) await scratch.cleanup(); },
  };
}

export async function refreshStaleOverlay({ root, overlay, mainSha, env = process.env,
  settings = resolveOverlayRefreshSettings(env), alert = () => {}, run = gitRun,
  createScratch, push, scratchSession,
} = {}) {
  let files = [];
  const fail = (reason) => {
    alert('overlay-refresh-failed', { ref: overlay.ref, files, reason });
    return { ok: false, files, reason };
  };
  if (!settings.autoRefresh) return { ok: true, refreshed: false };
  const git = makeGit({ run, cwd: root, env });
  if (!isSafeBranchName(overlay.ref) || !/^[a-f0-9]{40}$/.test(mainSha)) return fail('Invalid overlay ref or main sha');
  let session;
  try {
    const topSha = verifyRev(git, `origin/${overlay.ref}^{commit}`);
    if (!topSha) return fail('Overlay tip unresolved');
    if (overlay.pinnedSha !== undefined && topSha !== overlay.pinnedSha) return fail('tip differs from registered sha');
    session = scratchSession ?? createOverlayScratch({ root, env, run, createScratch });
    const sg = await session.git();
    const probe = sg(['merge-tree', '--write-tree', topSha, mainSha]);
    if (probe.status === 0) return { ok: true, refreshed: false };
    if (probe.status !== 1) return fail('Refresh preflight merge-tree failed');
    alert('overlay-refresh-settings', settings);
    const requireOk = (r, message) => { if (r.status !== 0) throw new Error(`${message}: ${r.stderr ?? ''}`); return r; };
    requireOk(sg(['reset', '--hard']), 'Scratch reset failed');
    requireOk(sg(['checkout', '--detach', topSha]), 'Scratch checkout failed');
    const commitEnv = rebuildCommitEnv(sg, topSha, mainSha);
    const merge = sg(['merge', '--no-ff', '--no-edit', '-m', `Merge main ${mainSha} into overlay ${overlay.ref}`, mainSha], { env: commitEnv });
    if (merge.status !== 0) {
      const conflicts = requireOk(sg(['diff', '--name-only', '--diff-filter=U', '-z']), 'Conflict inspection failed');
      files = String(conflicts.stdout).split('\0').filter(Boolean);
      return fail(files.length ? 'Merge conflicts' : 'Merge failed without proven conflicts');
    }
    const sha = verifyRev(sg, 'HEAD');
    const parents = requireOk(sg(['rev-list', '--parents', '-n', '1', 'HEAD']), 'Parent inspection failed').stdout.trim().split(/\s+/).slice(1);
    if (parents.length !== 2 || parents[0] !== topSha || parents[1] !== mainSha || verifyRev(sg, 'MERGE_HEAD')) return fail('Merge is incomplete or has unexpected parents');
    const ref = `${overlay.ref.replace(/-mainsync-[a-f0-9]+$/i, '')}-mainsync-${mainSha.slice(0, 7)}`;
    const existing = requireOk(sg(['ls-remote', '--heads', 'origin', `refs/heads/${ref}`]), 'Target inspection failed').stdout.trim();
    if (existing && existing.split(/\s+/)[0] !== sha) return fail('Refresh target already exists at a different sha');
    if (!existing) {
      const pushed = push ? await push({ root: session.root, ref, sha })
        : sg(['push', 'origin', `${sha}:refs/heads/${ref}`]);
      requireOk(pushed, 'Refresh push failed');
    }
    replaceOverlayRef(root, overlay, ref, { env, pinnedSha: sha });
    alert('overlay-refreshed', { ref, from: overlay.ref, mainSha, via: 'clean' });
    return { ok: true, from: overlay.ref, ref, sha };
  } catch (e) { return fail(String(e?.message ?? e)); }
  finally { if (session && !scratchSession) await session.cleanup(); }
}
