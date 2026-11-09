/** R503 admission with real Git objects, including a head absent from the local clone. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { withBareOrigin, withNarrowClone } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { netDiffFingerprint } from '../../lib/net-diff-fingerprint.mjs';

describe('prototype-load real R503 candidate fetch', () => {
  it.each([['full clone', withBareOrigin], ['single-branch clone', withNarrowClone]])(
    'carries readiness and canonical audit when the rebased candidate object is initially absent: %s', async (_, fixture) => {
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
          calls.push({ command, args });
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
          env: { HOME: tmp, TMPDIR: tmp, WE_DAEMON_OVERLAY_DIR: join(tmp, 'overlays') },
          testCheck: async () => ({ sha, name: 'test', status: 'completed', conclusion: 'success', appId: 15368 }),
          settings: { daemons: { control: { clone } }, workspaceRoot: tmp, loaderCli: 'scripts/daemon-overlay.mjs',
            readyRecordPath, auditRecordPath, recordPath, adoption: { timeoutMs: 30, pollMs: 10 } },
        });
        const result = await load({ branch, sha, daemon: 'control', dryRun: true });
        expect(result).toMatchObject({ ok: true, stopReason: null, wouldRegister: true,
          gate: { source: 'ready-record', record: { sha: oldSha } },
          canonicalAudit: { ok: true, record: { head: oldSha } } });
        expect(git(['cat-file', '-e', `${sha}^{commit}`])).toBe('');
        expect(git(['rev-parse', `refs/remotes/origin/${branch}`]).trim()).toBe(sha);
        const fetch = calls.findIndex(({ args }) => args[0] === 'fetch' && args.includes(`+refs/heads/${branch}:refs/remotes/origin/${branch}`));
        const fingerprintRead = calls.findIndex(({ args }) => args.includes('--end-of-options'));
        expect(fetch).toBeGreaterThanOrEqual(0);
        expect(fingerprintRead).toBeGreaterThan(fetch);
        expect(calls.some(({ args }) => ['push', 'commit-tree'].includes(args[0]))).toBe(false);
        expect(calls.filter(({ command }) => command === 'node').every(({ args }) => args[1] === 'list' || args.includes('--check'))).toBe(true);
        expect(fs.readFileSync(recordPath, 'utf8').trim().split('\n')).toHaveLength(1);
      });
    });
});
