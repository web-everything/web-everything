/** Real git fidelity: the card reader runs real git against a real repo with a real origin/main ref. */
import { chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { readPriorityCards } from '../build-priority-set-io.mjs';

it('reads the real remote main despite a shadowing local branch and refuses a missing card', async () => {
  await withRealRepo(async ctx => {
    ctx.commit({ 'backlog/0042-example.md': '---\nid: 42\nscope: [scripts/a.mjs]\n---\nbody\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    ctx.commit({ 'backlog/0042-example.md': '---\nscope: [scripts/shadow.mjs]\n---\n' });
    ctx.git(['update-ref', 'refs/heads/origin/main', 'HEAD']);
    const git = args => ctx.git(args);
    expect(readPriorityCards({ git })('42').scope).toEqual(['scripts/a.mjs']);
    expect(() => readPriorityCards({ git })('43')).toThrow(/missing or ambiguous/);
  });
});

it('refuses real directory, ancestor, missing and symlink tree entries; accepts only regular blob modes on the pinned card SHA', async () => {
  await withRealRepo(async ctx => {
    const regular = 'scripts/conveyor/a.mjs', executable = 'scripts/conveyor/pr-stall-sweep.mjs';
    ctx.commit({
      'backlog/42-example.md': '---\nscope: ["we:scripts/conveyor/a.mjs"]\n---\n',
      [regular]: 'export {};\n', [executable]: 'export {};\n',
      'scripts/conveyor/relocated.mjs/child.mjs': 'export {};\n',
    });
    symlinkSync('a.mjs', join(ctx.root, 'scripts/conveyor/link.mjs'));
    chmodSync(join(ctx.root, executable), 0o755);
    ctx.git(['add', '--', 'scripts']);
    ctx.git(['commit', '--quiet', '-m', 'fixture: file modes']);
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const read = readPriorityCards({ git: args => ctx.git(args) });
    expect(read('42').scope).toEqual(['we:scripts/conveyor/a.mjs']);
    for (const path of ['scripts/conveyor', 'scripts/conveyor/relocated.mjs', 'scripts/conveyor/missing.mjs', 'scripts/conveyor/link.mjs']) {
      expect(read.pathType(path), path).not.toBe('file');
    }
    ctx.git(['rm', '--quiet', '--', regular]);
    ctx.git(['commit', '--quiet', '-m', 'fixture: remove regular file']);
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(read.pathType(regular)).toBe('file');
    expect(read.pathType(executable)).toBe('file');
    expect(readPriorityCards({ git: args => ctx.git(args) }).pathType(regular)).not.toBe('file');
  });
});
