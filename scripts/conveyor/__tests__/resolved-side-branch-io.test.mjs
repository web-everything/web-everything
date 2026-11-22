// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { defaultResolvedSideBranchIo, enrichResolvedSideBranches, runResolvedSideBranchPass } from '../resolved-side-branch-push.mjs';
import { emitFixQuestion } from '../stand-down.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const repo = 'web-everything/web-everything', H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40);
const pr = { number: 7329, state: 'OPEN', isCrossRepository: false, headRefName: 'lane/topic', headRefOid: H, baseRefName: 'main', baseRefOid: B, comments: [] };
const name = 'lane/topic-fix-7329-alt';
function transportFixture({ fetched = S, oversized = false } = {}) {
  const calls = [], env = { PATH: '/attacker', GIT_DIR: '/attacker', GIT_WORK_TREE: '/attacker', GIT_CONFIG_PARAMETERS: 'evil',
    GIT_REPLACE_REF_BASE: 'refs/evil', GH_HOST: 'attacker.invalid', GH_TOKEN: 'ghp_personal' };
  const exec = vi.fn((bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args.includes('ls-remote')) return Array.from({ length: oversized ? 17 : 1 }, () => `${S}\trefs/heads/${name}`).join('\n');
    if (args.includes('rev-parse')) return args.at(-1).includes(B) ? B : args.at(-1).includes(H) ? H : fetched;
    if (args.includes('rev-list')) return [S, H, B].join('\n');
    return '';
  });
  return { calls, exec, io: defaultResolvedSideBranchIo({ exec, env, ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', record: () => {}, log: () => {} }) };
}
it('bare discovery scrubs hostile git environment; it never changes or bypasses repository hooks', () => {
  const { io, calls } = transportFixture();
  expect(io.readBranches(pr, repo)).toEqual([{ name, sha: S, ancestors: [S, H, B] }]);
  for (const c of calls) {
    expect(c.bin).toBe('/usr/bin/git');
    expect(c.opts.env).toMatchObject({ PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' });
    expect(c.opts.env.GIT_DIR).toBeUndefined();
    expect(c.opts.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(c.opts.env.GH_TOKEN).toBeUndefined();
    expect(c.opts.timeout).toBe(30000);
    expect(c.opts.maxBuffer).toBe(2 * 1024 * 1024);
    expect(c.args).toContain('core.commitGraph=false');
    expect(c.args.join(' ')).not.toMatch(/core.hooksPath|ghp_personal|--no-verify|--force/);
  }
});
it.each(['moved-fetch', 'oversized'])('refuses %s with no readable branch evidence', variant => {
  const { io } = transportFixture({ fetched: H, oversized: variant === 'oversized' });
  expect(() => io.readBranches(pr, repo)).toThrow();
});
it.each([null, 'ghp_personal', 'github_pat_personal', 'ghs_app\n'])('App cache unavailable (%s): no personal fallback', token => {
  const exec = vi.fn();
  const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', env: { GH_TOKEN: 'ghp_personal' }, tokenForRepo: () => token });
  expect(() => io.listPrs(repo)).toThrow();
  expect(() => io.readBranches(pr, repo)).toThrow();
  expect(exec).not.toHaveBeenCalled();
});
it('planner evidence is bound to current head; unreadable scans hold dispatch', () => {
  const io = { readPr: () => ({ ...pr, headRefOid: S }), readBranches: vi.fn() };
  expect(enrichResolvedSideBranches([pr], { repo, io })[0].resolvedSideBranches).toBeNull();
  expect(io.readBranches).not.toHaveBeenCalled();
});
it('zero scan budget defers without falsely holding an unread PR; oversized scan bound refuses', async () => {
  const io = { listPrs: () => [pr], log: vi.fn(), preparePush: vi.fn() };
  const rows = await runResolvedSideBranchPass({ repo, maxPrs: 0 }, io);
  expect([...rows]).toEqual([]);
  expect(rows).toMatchObject({ nextCursor: pr.number, deferred: [pr.number] });
  expect(io.preparePush).not.toHaveBeenCalled();
  await expect(runResolvedSideBranchPass({ repo, maxPrs: 9 }, io)).rejects.toThrow(/operator/);
});
it('full PR page is incomplete evidence; operator fallback rather than truncation', () => {
  const io = defaultResolvedSideBranchIo({ ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', exec: () => JSON.stringify(Array.from({ length: 100 }, () => ({}))) });
  expect(() => io.listPrs(repo)).toThrow(/operator/);
});
it('ninth PR is unscanned and reconciles normally, then rotates to the first position next pass', () => {
  const readBranches = vi.fn(() => []), cursors = new Map();
  const rows = Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1 }));
  const opts = { repo, cursors, io: { readPr: (_repo, number) => ({ ...pr, number }), readBranches } };
  const result = enrichResolvedSideBranches(rows, opts);
  expect(readBranches).toHaveBeenCalledTimes(8);
  expect(result[8]).not.toHaveProperty('resolvedSideBranches');
  expect(result[8]).toEqual(rows[8]);
  const next = enrichResolvedSideBranches(rows, opts);
  expect(readBranches.mock.calls[8][0].number).toBe(9);
  expect(next[8].resolvedSideBranches).toEqual([]);
});
it('question producer writes an unfiltered fix-question-asked event line through the shared event feed', async () => {
  const lines = [];
  await emitFixQuestion({ repo, pr: pr.number, head: S }, event => appendDaemonEvent(event, {
    env: { WE_DAEMON_EVENTS: join(process.env.TMPDIR, 'we-question-test', 'events.jsonl') },
    appendFile: async (_path, line) => lines.push(line),
  }));
  expect(JSON.parse(lines[0])).toMatchObject({ kind: 'fix-question-asked', repo, pr: pr.number, detail: { head: S, needsYou: true } });
  expect(lines[0]).not.toMatch(/fix-stood-down|status:needs-you|drain-skip:conflicting/);
});
it.each([true, false])('stand-down note emits a question only after successful publication (%s)', ok => {
  const order = [], questionEvent = vi.fn(() => { order.push('event'); });
  runReconcileNotesAllRepos({ repos: [repo], dryRun: false,
    tick: () => ({ notes: [{ kind: 'stood-down', prNumber: pr.number, text: 'needs your decision' }], prsByNumber: new Map([[pr.number, { ...pr, comments: [] }]]) }),
    postComment: () => { order.push('comment'); return { ok }; }, questionEvent,
  });
  expect(order).toEqual(ok ? ['comment', 'event'] : ['comment']);
  expect(questionEvent).toHaveBeenCalledTimes(ok ? 1 : 0);
});
