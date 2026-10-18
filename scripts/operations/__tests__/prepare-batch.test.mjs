import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPrepareBatch } from '../prepare-batch.mjs';
import { realIo } from '../probation-build-run.mjs';

// Exercise the actual ref, fetch, cherry-pick and abort ports against temporary repositories.
describe('prepare batch git assembly', () => {
  it.each([false, true])('assembles three isolated commits, aborting conflicts without resolution (conflict=%s)', async conflict => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-batch-git-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (dir, args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const source = join(root, 'source'); mkdirSync(source);
      git(source, ['init', '-q']); mkdirSync(join(source, 'backlog'));
      const ids = ['7101', '7102', '7103'];
      for (const id of ids) writeFileSync(join(source, `backlog/${id}-card.md`), 'original\n');
      git(source, ['add', '.']);
      const snapshot = (dir, parent) => {
        git(dir, ['add', '.']);
        return git(dir, ['commit-tree', git(dir, ['write-tree']), ...(parent ? ['-p', parent] : []), '-m', 'prepare']);
      };
      const original = snapshot(source);
      git(source, ['update-ref', 'HEAD', original]);
      let base = original;
      if (conflict) {
        writeFileSync(join(source, 'backlog/7102-card.md'), 'updated on main\n');
        base = snapshot(source, original);
        git(source, ['update-ref', 'HEAD', base]);
      }
      const cards = [];
      for (const id of ids) {
        const lanePath = join(root, id);
        git(root, ['clone', '-q', source, lanePath]);
        if (conflict && id === '7102') git(lanePath, ['reset', '--hard', original]);
        writeFileSync(join(lanePath, `backlog/${id}-card.md`), `prepared ${id}\n`);
        const sha = snapshot(lanePath, git(lanePath, ['rev-parse', 'HEAD']));
        git(lanePath, ['update-ref', 'HEAD', sha]);
        cards.push({ outcome: 'prepared-commit', num: id, path: `backlog/${id}-card.md`, lanePath, baseSha: base, sha });
      }
      const ports = realIo({ env });
      const openPr = vi.fn(() => ({ ok: true, pr: 99 }));
      const result = await runPrepareBatch({ num: ids[0], groupMembers: ids.slice(1), session: 'test', scope: [], worker: {} }, {
        ...ports, forPrepareCard: undefined, log: () => {}, findItem: id => ({ path: `backlog/${id}-card.md` }),
        runGate: () => ({ pass: true }), writePrBody: () => '/tmp/body', openPr,
      }, { batchParallel: true, batchMaxParallel: 3 }, async args => cards.find(c => c.num === args.num));
      const assembler = cards[0].lanePath;
      expect(openPr).toHaveBeenCalledOnce();
      expect(openPr.mock.calls[0][0].preparedIds).toEqual(conflict ? ['7101', '7103'] : ids);
      expect(git(assembler, ['rev-list', '--count', `${base}..HEAD`])).toBe(conflict ? '2' : '3');
      expect(git(assembler, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
      expect(readFileSync(join(assembler, 'backlog/7102-card.md'), 'utf8')).toBe(conflict ? 'updated on main\n' : 'prepared 7102\n');
      expect(result.deferredToNextBatch).toEqual(conflict ? ['7102'] : []);
      for (const card of cards) expect(git(card.lanePath, ['rev-parse', `lane/prep-${card.num}`])).toBe(card.sha);
      expect(git(assembler, ['rev-parse', `lane/prepare-batch-7101-${conflict ? 2 : 3}`])).toBe(git(assembler, ['rev-parse', 'HEAD']));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
