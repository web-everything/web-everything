/** R503 admission with real Git objects, including a head absent from the local clone. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBareOrigin, withNarrowClone } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { netDiffFingerprint } from '../../lib/net-diff-fingerprint.mjs';

describe('prototype-load real R503 candidate fetch', () => {
  it.each([['full clone', withBareOrigin], ['single-branch clone', withNarrowClone]])(
    'requires live readiness when the rebased candidate object is initially absent: %s', async (_, fixture) => {
      await fixture(async ({ tmp, clone, origin, seedOriginBranch, git }) => {
        const branch = 'lane/rebased';
        seedOriginBranch('lane/audited', { 'feature.txt': 'reviewed change\n' });
        const oldSha = git(['rev-parse', 'lane/audited'], { cwd: origin }).trim();
        const base = git(['rev-parse', 'main'], { cwd: origin }).trim();
        seedOriginBranch('main', { 'main-only.txt': 'unrelated main change\n' });
        seedOriginBranch(branch, { 'feature.txt': 'reviewed change\n' });
        const sha = git(['rev-parse', branch], { cwd: origin }).trim();
        const fingerprint = netDiffFingerprint(origin, 'main', oldSha);
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(netDiffFingerprint(origin, 'main', sha)).toBe(fingerprint);
        expect(() => git(['cat-file', '-e', `${sha}^{commit}`])).toThrow();
        expect(netDiffFingerprint(clone, 'origin/main', sha)).toBeNull();

        const readyRecordPath = join(tmp, 'fix-ready.jsonl');
        const auditRecordPath = join(tmp, 'audits.jsonl');
        const recordPath = join(tmp, 'prototype-loads.jsonl');
        fs.writeFileSync(readyRecordPath, JSON.stringify({ ref: branch, sha: oldSha, fingerprint, tests: 'green', audit: 'NOT WEAKENED' }) + '\n');
        fs.writeFileSync(auditRecordPath, JSON.stringify({ head: oldSha, base, fingerprint, questionHash: QUESTION_HASH,
          at: '2026-11-09T12:00:00Z', verdict: 'NOT WEAKENED', findings: [] }) + '\n');
        const calls = [];
        const exec = (command, args, options) => {
          calls.push({ command, args, options });
          if (command === 'node' && args[1] === 'list') return JSON.stringify({ list: [] });
          if (command === 'node' && args[1] === 'add' && args.includes('--check'))
            return JSON.stringify({ check: { ok: true, clean: true, candSha: sha }, wouldRegister: true });
          if (command !== 'git') throw new Error(`Unexpected subprocess ${command}`);
          // Bind the production fingerprint helper's explicit -C to the fixture,
          // and every other Git command to the same local-only bare origin.
          const boundArgs = args[0] === '-C' ? ['-C', clone, ...args.slice(2)] : args;
          return execFileSync(command, boundArgs, { ...options, cwd: clone });
        };
        const load = createPrototypeLoader({ ...defaultDeps(), exec,
          env: { HOME: tmp, TMPDIR: tmp, WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays'),
            GIT_GRAFT_FILE: join(tmp, 'forged-grafts'), GIT_NO_REPLACE_OBJECTS: '0',
            GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' },
          testCheck: async () => ({ sha, name: 'test', status: 'completed', conclusion: 'success', appId: 15368 }),
          settings: { daemons: { control: { clone } }, workspaceRoot: tmp, loaderCli: 'scripts/daemon-overlay.mjs',
            readyRecordPath, auditRecordPath, recordPath, adoption: { timeoutMs: 30, pollMs: 10 } },
        });
        const result = await load({ branch, sha, daemon: 'control', dryRun: true });
        expect(result).toMatchObject({ ok: false, stopReason: 'no-ready' });
        expect(result.gate).toBeNull();
        expect(git(['cat-file', '-e', `${sha}^{commit}`])).toBe('');
        expect(git(['rev-parse', `refs/remotes/origin/${branch}`]).trim()).toBe(sha);
        const fetch = calls.findIndex(({ args }) => args[0] === 'fetch' && args.includes(`+refs/heads/${branch}:refs/remotes/origin/${branch}`));
        const fingerprintRead = calls.findIndex(({ args }) => args.includes('--end-of-options'));
        // Inspect the actual producer calls, outside any fail-closed production catch.
        const proofCalls = calls.filter(({ command, args }) => command === 'git' && args[0] === '-C');
        expect(proofCalls.length).toBeGreaterThan(0);
        for (const call of proofCalls) {
          expect(call.options.env.GIT_GRAFT_FILE).toBe('/dev/null');
          expect(call.options.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
          const pins = Array.from({ length: Number(call.options.env.GIT_CONFIG_COUNT) }, (_, i) =>
            [call.options.env[`GIT_CONFIG_KEY_${i}`], call.options.env[`GIT_CONFIG_VALUE_${i}`]]);
          expect(pins.filter(([key]) => key === 'core.commitGraph').at(-1)).toEqual(['core.commitGraph', 'false']);
        }
        const fetchEnv = calls[fetch]?.options.env;
        expect(fetchEnv?.GIT_GRAFT_FILE).toBeUndefined();
        expect(fetchEnv?.GIT_NO_REPLACE_OBJECTS).toBeUndefined();
        expect(fetchEnv?.GIT_CONFIG_COUNT).toBeUndefined();
        expect(fetch).toBeGreaterThanOrEqual(0);
        expect(fingerprintRead).toBeGreaterThan(fetch);
        expect(calls.some(({ args }) => ['push', 'commit-tree'].includes(args[0]))).toBe(false);
        expect(calls.filter(({ command }) => command === 'node').every(({ args }) => args[1] === 'list' || args.includes('--check'))).toBe(true);
        expect(fs.readFileSync(recordPath, 'utf8').trim().split('\n')).toHaveLength(1);
      });
    });
});

// Default (non-injected) dispatch-smoke branch with real Git worktrees (PR #6610 review). Only the smoke
// runner is substituted, via the `realDispatchSmoke` seam; worktree add/remove, the HEAD identity check and cleanup are real.
const BRANCH = 'lane/dispatch-change';

async function smokeFixture(smoke, check, { wrapExec = (exec) => exec } = {}) {
  await withBareOrigin(async ({ tmp, clone, origin, seedOriginBranch, git }) => {
    const base = git(['rev-parse', 'main'], { cwd: origin }).trim();
    seedOriginBranch(BRANCH, { 'scripts/operations/dispatch-lane.mjs': 'export const changed = true;\n' });
    const sha = git(['rev-parse', BRANCH], { cwd: origin }).trim();
    const readyRecordPath = join(tmp, 'fix-ready.jsonl');
    const auditRecordPath = join(tmp, 'audits.jsonl');
    const recordPath = join(tmp, 'prototype-loads.jsonl');
    fs.writeFileSync(readyRecordPath, '');
    fs.writeFileSync(auditRecordPath, JSON.stringify({ head: sha, base, questionHash: QUESTION_HASH,
      at: '2026-11-09T12:00:00Z', verdict: 'NOT WEAKENED', findings: [] }) + '\n');
    const calls = [];
    const baseExec = (command, args, options) => {
      calls.push({ command, args });
      if (command === 'node' && args[1] === 'list') return JSON.stringify({ list: [] });
      if (command === 'node' && args[1] === 'add' && args.includes('--check'))
        return JSON.stringify({ check: { ok: true, clean: true, candSha: sha }, wouldRegister: true });
      if (command !== 'git') throw new Error(`Unexpected subprocess ${command}`);
      // The smoke worktree lives outside the clone: only the production repo's own commands are rebound to it.
      const inSmokeTree = args[0] === '-C' && String(args[1]).includes('prototype-dispatch-smoke-');
      const bound = args[0] === '-C' && !inSmokeTree ? ['-C', clone, ...args.slice(2)] : args;
      return execFileSync(command, bound, { ...options, cwd: clone });
    };
    const load = createPrototypeLoader({ ...defaultDeps(), exec: wrapExec(baseExec), realDispatchSmoke: smoke,
      env: { HOME: tmp, TMPDIR: tmp, USER: 'test', WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') },
      testCheck: async () => ({ sha, name: 'test', status: 'completed', conclusion: 'success', appId: 15368 }),
      settings: { daemons: { control: { clone } }, workspaceRoot: tmp, loaderCli: 'scripts/daemon-overlay.mjs',
        readyRecordPath, auditRecordPath, recordPath, adoption: { timeoutMs: 30, pollMs: 10 } } });
    const worktrees = () => git(['worktree', 'list', '--porcelain'], { cwd: clone }).split('\n').filter((l) => l.startsWith('worktree '));
    await check({ load: (input = {}) => load({ branch: BRANCH, sha, daemon: 'control', dryRun: true, ...input }), sha, tmp, calls, worktrees });
  });
}

describe('prototype-load default dispatch smoke (real worktree)', () => {
  it('runs the smoke in a detached worktree at exactly the candidate sha, then removes it', async () => {
    const seen = [];
    const smoke = vi.fn(async ({ tree }) => {
      seen.push({ head: execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        file: fs.existsSync(join(tree, 'scripts/operations/dispatch-lane.mjs')) });
      return { ok: true, ran: true };
    });
    await smokeFixture(smoke, async ({ load, sha, worktrees }) => {
      const before = worktrees().length;
      expect(await load()).toMatchObject({ ok: true, stopReason: null, dispatchSmoke: { ok: true, sha } });
      expect(smoke).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ head: sha, file: true }]);
      expect(worktrees()).toHaveLength(before);
      expect(fs.existsSync(smoke.mock.calls[0][0].tree)).toBe(false);
    });
  });
  it('provisions the checkout node_modules in the smoke tree so its dispatch imports resolve (PR #6610 round 3)', async () => {
    const productionModules = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'node_modules');
    const seen = [];
    const smoke = vi.fn(async ({ tree }) => {
      const linked = join(tree, 'node_modules');
      seen.push({ present: fs.existsSync(linked), same: fs.existsSync(linked) && fs.realpathSync(linked) === fs.realpathSync(productionModules),
        resolves: fs.existsSync(join(linked, 'markdown-it')) });
      return { ok: true, ran: true };
    });
    await smokeFixture(smoke, async ({ load, sha, worktrees }) => {
      const before = worktrees().length;
      expect(await load()).toMatchObject({ ok: true, stopReason: null, dispatchSmoke: { ok: true, sha } });
      expect(seen).toEqual([{ present: true, same: true, resolves: true }]);
      expect(worktrees()).toHaveLength(before);
      // Removing the worktree must unlink, never follow, the dependency link.
      expect(fs.existsSync(join(productionModules, 'markdown-it'))).toBe(true);
    });
  });
  it.each([
    ['a failing verdict', async () => ({ ok: false, reason: 'launch-failed' })],
    ['a skipped verdict', async () => ({ ok: true, skipped: true })],
    ['a verdict that did not run', async () => ({ ok: true, ran: false })],
  ])('refuses with dispatch-smoke-failed on %s and still removes the worktree', async (_, verdict) => {
    await smokeFixture(vi.fn(verdict), async ({ load, worktrees }) => {
      const before = worktrees().length;
      expect(await load()).toMatchObject({ ok: false, stopReason: 'dispatch-smoke-failed' });
      expect(worktrees()).toHaveLength(before);
    });
  });
  it('refuses when the smoke runner throws, and still removes the worktree', async () => {
    const smoke = vi.fn(async () => { throw new Error('smoke crashed'); });
    await smokeFixture(smoke, async ({ load, worktrees }) => {
      const before = worktrees().length;
      expect(await load()).toMatchObject({ ok: false, stopReason: 'dispatch-smoke-failed' });
      expect(smoke).toHaveBeenCalledTimes(1);
      expect(worktrees()).toHaveLength(before);
    });
  });
  it('never runs the smoke when the worktree HEAD is not the candidate sha', async () => {
    const smoke = vi.fn(async () => ({ ok: true, ran: true }));
    const moved = (exec) => (command, args, options) => command === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD'
      ? `${'f'.repeat(40)}\n` : exec(command, args, options);
    await smokeFixture(smoke, async ({ load }) => {
      expect(await load()).toMatchObject({ ok: false, stopReason: 'dispatch-smoke-failed' });
      expect(smoke).not.toHaveBeenCalled();
    }, { wrapExec: moved });
  });
  it('a failing worktree cleanup never masks the smoke verdict', async () => {
    const smoke = vi.fn(async () => ({ ok: true, ran: true }));
    const stuck = (exec) => (command, args, options) => {
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove')
        throw Object.assign(new Error('worktree remove failed'), { status: 128, stderr: 'locked' });
      return exec(command, args, options);
    };
    await smokeFixture(smoke, async ({ load, sha }) => {
      expect(await load()).toMatchObject({ ok: true, stopReason: null, dispatchSmoke: { ok: true, sha } });
    }, { wrapExec: stuck });
    const failing = vi.fn(async () => ({ ok: false, reason: 'launch-failed' }));
    await smokeFixture(failing, async ({ load }) => {
      expect(await load()).toMatchObject({ ok: false, stopReason: 'dispatch-smoke-failed', dispatchSmoke: { ok: false, reason: 'launch-failed' } });
    }, { wrapExec: stuck });
  });
});


it('a real clean main merge carries only an exact waiver and requires a live canonical audit', async () => {
  const { sameContentRepo } = await import('../../lib/__tests__/fixtures/same-content-repo.mjs');
  const { createSameContentProof } = await import('../../lib/same-content-waiver-io.mjs');
  const { readyEvidence, canonicalAuditEvidence } = await import('../prototype-load.mjs');
  const { QUESTION_HASH } = await import('../codex-audit.mjs');
  const f = sameContentRepo('clean');
  try {
    const ref = 'lane/waiver', findings = ['A', 'B'], sameContent = createSameContentProof(f);
    const entry = { ref, sha: f.from, ruling: 'R12', findings };
    const ready = { ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: findings };
    const gate = readyEvidence([ready], { branch: ref, sha: f.to }, [entry], null, { sameContent });
    expect(gate).toMatchObject({ sameContentCarry: { commits: [{ sha: f.to, kind: 'clean-main-merge' }] } });
    const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings, questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
    const judge = records => canonicalAuditEvidence(records, f.to, () => true, 'c'.repeat(64), { ruledWeakened: gate });
    expect(judge([audit]).ok).toBe(true);
    expect(judge([{ ...audit, head: f.from, fingerprint: 'c'.repeat(64) }]).ok).toBe(false);
    for (const findings of [['A'], ['B', 'A'], ['A', 'A']]) expect(judge([{ ...audit, findings }]).ok).toBe(false);
  } finally { f.cleanup(); }
});
