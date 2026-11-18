/** @file Real Git resolution and filesystem persistence for audit IO. */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';

describe('codex-audit real IO', () => {
  it('resolves a branch and commit SHA to the full 40-hex commit in a real repo', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      const sha = head();
      git(['branch', 'audit-target', sha]);
      commit({ 'next.txt': 'another commit\n' });
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });

      expect(head()).not.toBe(sha);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(deps.resolveSha('audit-target')).toBe(sha);
      expect(deps.resolveSha(sha)).toBe(sha);
    });
  });

  it('throws for an unknown ref in a real repo', async () => {
    await withRealRepo(async ({ root: repo, tmp }) => {
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });

      expect(() => deps.resolveSha('missing-audit-ref'))
        .toThrow('audit subprocess failed or exceeded its bound');
    });
  });

  it('creates directories under the temp home and appends JSON lines at the default record path', async () => {
    await withRealRepo(async ({ root: repo, tmp, head }) => {
      const home = join(tmp, 'home');
      const recordPath = join(home, 'workspace', '.operations', 'coordination', 'audits.jsonl');
      // Native Node keeps the adapter's settings URL intact; Vite rewrites new URL(..., import.meta.url).
      const moduleUrl = new NodeURL('../codex-audit-io.mjs', import.meta.url).href;
      const appendRecord = record => execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { createAuditDeps } = await import(process.argv[1]);
        const deps = createAuditDeps({ cwd: process.argv[2], home: process.argv[3] });
        deps.appendRecord(JSON.parse(process.argv[4]));
      `, moduleUrl, repo, home, JSON.stringify(record)], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      const first = { sha: head(), ok: true, message: 'first audit\nwith a newline' };
      const second = { sha: head(), ok: false, message: 'second audit' };

      expect(existsSync(home)).toBe(false);
      appendRecord(first);
      expect(existsSync(dirname(recordPath))).toBe(true);
      expect(readFileSync(recordPath, 'utf8')).toBe(`${JSON.stringify(first)}\n`);

      appendRecord(second);
      const contents = readFileSync(recordPath, 'utf8');
      expect(contents).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      expect(contents.trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([first, second]);
    });
  });
});


describe('R1053 base reproduction IO', () => {
  it('a1 reruns dedupe cards and B1 adds one security needs-you line', async () => {
    await withRealRepo(async ({ root, tmp }) => {
      const cardsPath = join(tmp, 'cards.md'), indexPath = join(tmp, 'index.jsonl');
      const options = { cwd: root, home: join(tmp, 'home'), cardsPath, indexPath };
      const card = { key: 'x.mjs|X|B1', cardLine: '- [R1053] test security', expedite: true, needsYou: true };
      expect(createAuditDeps(options).fileCard(card)).toBe(true);
      const first = readFileSync(cardsPath, 'utf8');
      expect(first).toContain('[R1053][needs-you]');
      expect(first).toContain('security pre-existing (B1)');
      expect(createAuditDeps(options).fileCard(card)).toBe(true);
      expect(readFileSync(cardsPath, 'utf8')).toBe(first);
      expect(readFileSync(indexPath, 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });
  it.each(['success', 'timeout', 'malformed', 'add fails'])('removes detached scratch worktree in finally: %s', async kind => {
    await withRealRepo(async ({ root, tmp, head, git }) => {
      let dir;
      const deps = createAuditDeps({ cwd: root, scratchRoot: tmp, spawnSync(command, args, opts) {
        if (command === process.execPath) {
          dir = args.find(a => a.startsWith('--dir=')).slice(6);
          expect(git(['-C', dir, 'rev-parse', 'HEAD']).trim()).toBe(head());
          if (kind === 'timeout') return { status: null, error: Error('timeout') };
          return { status: 0, stdout: kind === 'malformed' ? '{}' : JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'proof' }) };
        }
        if (kind === 'add fails' && args[0] === 'worktree' && args[1] === 'add') return { status: 1 };
        return spawnSync(command, args, opts);
      } });
      if (kind === 'success') expect(await deps.reproOnBase('question', [], head())).toBe('proof');
      else await expect(deps.reproOnBase('question', [], head())).rejects.toThrow();
      if (dir) expect(existsSync(dir)).toBe(false);
      expect(git(['worktree', 'list', '--porcelain'])).not.toContain('audit-base-');
    });
  });
});
