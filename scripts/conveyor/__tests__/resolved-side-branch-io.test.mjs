// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultResolvedSideBranchIo, enrichResolvedSideBranches, runResolvedSideBranchPass } from '../resolved-side-branch-push.mjs';
import { emitFixQuestion } from '../stand-down.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const repo = 'web-everything/web-everything', H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40);
const pr = { number: 7329, state: 'OPEN', isCrossRepository: false, headRefName: 'lane/topic', headRefOid: H, baseRefName: 'main', baseRefOid: B };
const name = 'lane/topic-fix-7329-alt';

function transportFixture({ advertised = H, fetched = S, oversized = false, claim = null } = {}) {
  const calls = [], env = { PATH: '/attacker', GIT_DIR: '/attacker', GIT_WORK_TREE: '/attacker', GIT_CONFIG_PARAMETERS: 'evil',
    GIT_REPLACE_REF_BASE: 'refs/evil', GH_TOKEN: 'ghp_personal', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'evil' };
  const exec = vi.fn((bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args.includes('ls-remote')) return Array.from({ length: oversized ? 17 : 1 }, () => `${S}\trefs/heads/${name}`).join('\n');
    if (args.includes('rev-parse')) {
      if (args.at(-1).includes(B)) return B;
      if (args.at(-1).includes(H)) return H;
      return fetched;
    }
    if (args.includes('rev-list')) return [S, H, B].join('\n');
    if (args.includes('push')) {
      // Real trusted hook, fake transport. An advertised move refuses even after the API pre-read.
      execFileSync('/bin/sh', [join(opts.cwd, 'hooks/pre-push')], {
        input: `${S} ${S} refs/heads/lane/topic ${advertised}\n`, stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    return '';
  });
  return { calls, exec, io: defaultResolvedSideBranchIo({ exec, env, tokenForRepo: () => 'ghs_app', checkClaim: () => claim, record: () => {}, log: () => {} }) };
}

it('fresh bare transport scrubs location/config/PATH/replacement objects and pins App auth; no force', () => {
  const { io, calls } = transportFixture();
  expect(io.readBranches(pr, repo)).toEqual([{ name, sha: S, ancestors: [S, H, B] }]);
  io.push({ repo, sha: S, head: H, branch: pr.headRefName, token: 'ghs_app' });
  for (const c of calls) {
    expect(c.bin).toBe('/usr/bin/git');
    expect(c.opts.env).toMatchObject({ PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' });
    expect(c.opts.env.GIT_DIR).toBeUndefined();
    expect(c.opts.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(c.opts.env.GH_TOKEN).toBeUndefined();
    expect(c.opts.timeout).toBe(30000);
    expect(c.opts.maxBuffer).toBe(2 * 1024 * 1024);
    expect(c.args).toContain('core.commitGraph=false');
    expect(c.args.join(' ')).not.toContain('ghp_personal');
  }
  const push = calls.find(c => c.args.includes('push'));
  expect(push.args.slice(-3)).toEqual(['push', `https://github.com/${repo}.git`, `${S}:refs/heads/lane/topic`]);
  expect(push.args.join(' ')).not.toMatch(/--force|--no-verify/);
});
it('read/write advertisement race refuses without a force fallback', () => {
  const { io, calls } = transportFixture({ advertised: B });
  expect(() => io.push({ repo, sha: S, head: H, branch: pr.headRefName, token: 'ghs_app' })).toThrow();
  expect(calls.filter(c => c.args.includes('push'))).toHaveLength(1);
});
it('a claim acquired during transport preparation refuses the actual write', () => {
  const { io, calls } = transportFixture({ claim: { held: true } });
  expect(() => io.push({ repo, sha: S, head: H, branch: pr.headRefName, token: 'ghs_app' })).toThrow(/claim/);
  expect(calls.some(c => c.args.includes('push'))).toBe(false);
});
it.each(['moved-fetch', 'oversized'])('refuses %s with no readable branch evidence', variant => {
  const { io } = transportFixture({ fetched: H, oversized: variant === 'oversized' });
  expect(() => io.readBranches(pr, repo)).toThrow();
});
it.each([null, 'ghp_personal', 'github_pat_personal'])('App cache unavailable (%s): never calls gh auth token or a personal helper', token => {
  const exec = vi.fn();
  const io = defaultResolvedSideBranchIo({ exec, env: { GH_TOKEN: 'ghp_personal' }, tokenForRepo: () => token });
  expect(() => io.listPrs(repo)).toThrow();
  expect(() => io.readBranches(pr, repo)).toThrow();
  expect(exec).not.toHaveBeenCalled();
});
it('planner evidence is bound to current head, unreadable evidence and bounds hold instead of dispatching', () => {
  const io = { readPr: () => ({ ...pr, headRefOid: S }), readBranches: vi.fn() };
  expect(enrichResolvedSideBranches([pr], { repo, io })[0].resolvedSideBranches).toBeNull();
  expect(io.readBranches).not.toHaveBeenCalled();
});
it('per-tick bounds leave an operator fallback and never push oversized inventory', async () => {
  const io = { listPrs: () => [pr], log: vi.fn(), push: vi.fn() };
  expect((await runResolvedSideBranchPass({ repo, maxPrs: 0 }, io))[0].why).toMatch(/operator/);
  expect(io.push).not.toHaveBeenCalled();
  await expect(runResolvedSideBranchPass({ repo, maxPrs: 9 }, io)).rejects.toThrow(/operator/);
});
it('an unpaginated full PR page is incomplete evidence; operator fallback rather than truncation', () => {
  const io = defaultResolvedSideBranchIo({ tokenForRepo: () => 'ghs_app', exec: () => JSON.stringify(Array.from({ length: 100 }, () => ({}))) });
  expect(() => io.listPrs(repo)).toThrow(/operator/);
});
it('planner enrichment bounds the ninth PR scan and exposes unreadable evidence', () => {
  const readBranches = vi.fn(() => []);
  const rows = Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1 }));
  const result = enrichResolvedSideBranches(rows, { repo, io: { readPr: (_repo, number) => ({ ...pr, number }), readBranches } });
  expect(readBranches).toHaveBeenCalledTimes(8);
  expect(result[8].resolvedSideBranches).toBeNull();
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
