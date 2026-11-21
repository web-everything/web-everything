/** Real git fidelity: the card reader runs real git against a real repo with a real origin/main ref. */
import { expect, it } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { readPriorityCards } from '../build-priority-set-io.mjs';

it('reads a real origin/main card and refuses a missing one', async () => {
  await withRealRepo(async ctx => {
    ctx.commit({ 'backlog/0042-example.md': '---\nid: 42\nscope: [scripts/a.mjs]\n---\nbody\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const git = args => ctx.git(args);
    expect(readPriorityCards({ git })('42').scope).toEqual(['scripts/a.mjs']);
    expect(() => readPriorityCards({ git })('43')).toThrow(/missing or ambiguous/);
  });
});
