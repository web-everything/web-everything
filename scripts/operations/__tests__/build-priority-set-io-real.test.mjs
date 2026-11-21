/** Real git fidelity: the card reader runs real git against a real repo with a real origin/main ref. */
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
