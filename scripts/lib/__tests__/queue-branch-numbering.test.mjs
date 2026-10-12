import { describe, it, expect, vi } from 'vitest';
import { handNumberedNewItems } from '../../check-standards-rules.mjs';
import { exemptDrainNumberedItems, resolveQueueNumbering, hashBacklogFiles, isMergeGroupCiRun, mergeGroupHashRefusals, prepareBranchBeforeEnqueue, reservationPlan, finishBranchPreparation } from '../queue-branch-numbering.mjs';

describe('queue branch numbering', () => {
  it('refuses hash cards in merge groups even when drain numbering is off', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group', WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: 'off' };
    expect(mergeGroupHashRefusals({ env, files: ['backlog/xabc123-foo.md', 'backlog/5970-bar.md'] })).toEqual([
      'Backlog file "backlog/xabc123-foo.md" would land on main with a NON-NUMERIC leading id — a temporary (hash) id can never enter main through the merge queue; the drain numbers cards on the PR branch before enqueue. This merge group is refused (unconditional, no setting disables it)',
    ]);
  });
  it('does not refuse hash cards outside merge-group CI', () => {
    for (const env of [{}, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'merge_group' }]) {
      expect(mergeGroupHashRefusals({ env, files: ['backlog/xabc123-foo.md'] })).toEqual([]);
    }
  });
  it('wires the merge-group refusal without a numbering setting condition', () => {
    const source = readFileSync('scripts/check-standards.mjs', 'utf8');
    const block = source.match(/if \(isMergeGroupCiRun\(\)\) \{([\s\S]*?)\/\/ #2319/);
    expect(block).not.toBeNull();
    expect(block[1]).toContain('mergeGroupHashRefusals(');
    expect(block[1]).not.toContain('setting.value');
  });
  it('resolves defaults, file, env and reports invalid layers', () => {
    const readFile = () => JSON.stringify({ mergeQueue: { numberCardsBeforeEnqueue: false } });
    expect(resolveQueueNumbering({ readFile, env: {} })).toMatchObject({ value: false, source: 'scripts/settings/merge-queue-numbering.json' });
    for (const raw of ['on', 'true', '1']) expect(resolveQueueNumbering({ readFile, env: { WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: raw } }).value).toBe(true);
    for (const raw of ['off', 'false', '0']) expect(resolveQueueNumbering({ readFile, env: { WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: raw } }).value).toBe(false);
    expect(resolveQueueNumbering({ readFile, env: { WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: 'bad' } })).toMatchObject({ value: false, invalid: [expect.stringContaining('bad')] });
    expect(resolveQueueNumbering({ readFile: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, env: {} })).toMatchObject({ value: true, source: 'default' });
  });
  it('exempts only hash birth stamps when queue numbering is enabled without mutating input', () => {
    const items = Object.freeze([
      Object.freeze({ num: '5938', bornAs: 'xabc123' }),
      ...[undefined, null, '', '5938', 'xabc12', 'xabc1234', 'XABC123', ' xabc123'].map((bornAs) => Object.freeze({ num: '5939', bornAs })),
    ]);
    expect(exemptDrainNumberedItems(items, { enabled: true })).toEqual(items.slice(1));
    expect(exemptDrainNumberedItems(items, { enabled: false })).toBe(items);
    expect(exemptDrainNumberedItems([], { enabled: true })).toEqual([]);
  });
  it('keeps the hand-picked-id gate active for unstamped cards and when numbering is off', () => {
    const items = [
      { id: '5938-drained', num: '5938', bornAs: 'xabc123' },
      { id: '5939-picked', num: '5939' },
      { id: '5940-invalid', num: '5940', bornAs: 'not-a-hash' },
      { id: '010-main', num: '010' },
    ];
    const main = ['backlog/010-main.md'];
    const enabled = handNumberedNewItems(exemptDrainNumberedItems(items, { enabled: true }), main);
    expect(enabled).toHaveLength(2);
    expect(enabled[0]).toContain('5939-picked');
    expect(enabled[1]).toContain('5940-invalid');
    expect(handNumberedNewItems(exemptDrainNumberedItems(items, { enabled: false }), main)).toHaveLength(3);
  });
  it('detects only tracked hash card names and merge groups', () => {
    expect(hashBacklogFiles('backlog/xabc123-foo.md\nbacklog/012-bar.md\nother/xabc123-a.md\nbacklog/xabc12-b.md')).toEqual(['backlog/xabc123-foo.md']);
    expect(isMergeGroupCiRun({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' })).toBe(true);
    expect(isMergeGroupCiRun({ GITHUB_EVENT_NAME: 'merge_group' })).toBe(false);
    expect(isMergeGroupCiRun({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' })).toBe(false);
  });
  it('uses main and live reservations, pruning landed and closed PRs', () => {
    const rows = [ { repo: 'r', num: 1, headRef: 'a', nnns: [11], at: 'now' }, { repo: 'r', num: 2, headRef: 'b', nnns: [25], at: 'now' }, { repo: 'r', num: 3, headRef: 'c', nnns: [99], at: 'now' } ];
    expect(reservationPlan(['backlog/011-a.md', 'backlog/020-b.md'], rows, (_, n) => n !== 3)).toEqual({ reservations: [rows[1]], minNext: 26 });
  });
  function setup({ pending = true, state = '{"reservations":[]}', head = 'old' } = {}) {
    let numbered = false;
    const exec = vi.fn((_, args) => {
      if (args[0] === 'ls-remote') return `${head}\trefs/heads/topic\n`;
      if (args[0] === 'ls-files') return pending && !numbered ? 'backlog/xabc123-foo.md' : 'backlog/041-foo.md';
      if (args[0] === 'ls-tree') return 'backlog/040-main.md';
      if (args[0] === 'rev-parse') return 'new';
      return '';
    });
    const fs = { symlinkSync: vi.fn(), mkdtempSync: vi.fn(() => '/tmp/fake'), rmSync: vi.fn(), readFileSync: vi.fn(() => state), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() };
    const number = vi.fn(() => { numbered = true; return { assigned: [{ hash: 'xabc123', nnn: '041' }], committed: true }; });
    const lock = vi.fn((fn) => ({ ran: true, result: fn() }));
    const args = { c: { repo: 'r', num: 4, headRef: 'topic' }, traceHeadSha: 'old', cwd: '/clone', statePath: '/state/reservations.json', exec, fs, number, lock, isOpen: () => true };
    return { args, exec, fs, number, lock };
  }
  it('returns final without locking or pushing when nothing needs doing', () => {
    const x = setup({ pending: false });
    expect(prepareBranchBeforeEnqueue(x.args)).toEqual({ action: 'final' });
    expect(x.lock).not.toHaveBeenCalled();
    expect(x.fs.rmSync).toHaveBeenCalled();
  });
  it('numbers under the mandatory mutex and pushes only the branch', () => {
    const x = setup();
    expect(prepareBranchBeforeEnqueue(x.args)).toMatchObject({ action: 'numbered', newHead: 'new' });
    expect(x.number).toHaveBeenCalledWith('/tmp/fake/tree', { minNext: 41 });
    expect(x.lock).toHaveBeenCalledWith(expect.any(Function), { runUnlockedOnContention: false });
    expect(x.exec).toHaveBeenCalledWith('git', ['push', 'origin', 'HEAD:refs/heads/topic'], expect.any(Object));
    expect(x.fs.writeFileSync).toHaveBeenCalled();
  });
  it('reports an already successful push when worktree cleanup fails', () => {
    const x = setup();
    x.fs.rmSync.mockImplementation(() => { throw new Error('cleanup denied'); });
    expect(prepareBranchBeforeEnqueue(x.args)).toEqual({
      action: 'skip', reason: 'merge-queue: worktree cleanup failed: cleanup denied; push already happened at new',
    });
    expect(x.exec.mock.calls.some(([, args]) => args[0] === 'push')).toBe(true);
  });
  it('does not claim publication when cleanup fails before a successful push', () => {
    const x = setup();
    const exec = x.args.exec;
    x.args.exec = (...args) => {
      if (args[1][0] === 'push') throw new Error('push refused');
      return exec(...args);
    };
    x.fs.rmSync.mockImplementation(() => { throw new Error('cleanup denied'); });
    expect(prepareBranchBeforeEnqueue(x.args)).toEqual({ action: 'skip', reason: 'merge-queue: worktree cleanup failed: cleanup denied' });
  });
  it('allocates above another queued PR reservation', () => {
    const x = setup({ state: JSON.stringify({ reservations: [{ repo: 'r', num: 9, headRef: 'other', nnns: [72], at: 'now' }] }) });
    prepareBranchBeforeEnqueue(x.args);
    expect(x.number).toHaveBeenCalledWith('/tmp/fake/tree', { minNext: 73 });
  });
  it('refuses moved heads, unreadable state and lock contention', () => {
    for (const options of [{ head: 'moved' }, { state: '{broken' }]) {
      const x = setup(options);
      expect(prepareBranchBeforeEnqueue(x.args).action).toBe('skip');
      expect(x.number).not.toHaveBeenCalled();
      expect(x.fs.writeFileSync).not.toHaveBeenCalled();
    }
    const x = setup(); x.args.lock = () => ({ ran: false });
    expect(prepareBranchBeforeEnqueue(x.args).reason).toContain('mutex');
  });
  it('resolves the local manifest card using its assigned id, with publication disabled', () => {
    const x = setup();
    x.args.c = { ...x.args.c, hasManifest: true, item: 'xabc123' };
    x.fs.readFileSync.mockImplementation((path) => path.endsWith('.md') ? '---\nstatus: open\n---\n' : '{"reservations":[]}');
    x.args.resolveItem = vi.fn(() => ({ flipped: true }));
    expect(prepareBranchBeforeEnqueue(x.args)).toMatchObject({ action: 'numbered', resolved: ['041'] });
    expect(x.args.resolveItem).toHaveBeenCalledWith('/tmp/fake/tree', '041', { sync: false, publish: false });
  });
  it('refuses unresolved cards and failed numbering without pushing', () => {
    const x = setup();
    x.args.c = { ...x.args.c, hasManifest: true, item: 'xabc123' };
    x.fs.readFileSync.mockImplementation((path) => path.endsWith('.md') ? '---\nstatus: open\n---\n' : '{"reservations":[]}');
    x.args.resolveItem = () => ({ flipped: false, reason: 'guard refused' });
    expect(prepareBranchBeforeEnqueue(x.args).reason).toContain('guard refused');
    expect(x.exec.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    const y = setup(); y.args.number = () => ({ assigned: [], error: 'number failed' });
    expect(prepareBranchBeforeEnqueue(y.args).reason).toContain('number failed');
    expect(y.exec.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });
  it('refuses invalid reservation schemas instead of overwriting them', () => {
    for (const state of ['{}', '{"reservations":[{}]}', '{"reservations":null}']) {
      const x = setup({ state });
      expect(prepareBranchBeforeEnqueue(x.args).reason).toContain('unreadable');
      expect(x.fs.writeFileSync).not.toHaveBeenCalled();
    }
  });
  it('records re-stamp refusal without relaxing acceptance', () => {
    const aborted = [];
    expect(finishBranchPreparation({ action: 'numbered', newHead: '123456789abcd' }, { c: { num: 4 }, revalidationAborted: aborted, needsAcceptanceRestamp: () => true, restampAcceptance: () => ({ ok: false, reason: 'net diff changed' }), log: { write() {} } })).toBe(false);
    expect(aborted[0].reason).toContain('acceptance re-stamp failed: net diff changed');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withNumberingLock } from '../../readiness/drain-lock.mjs';
import { buildFollowupInput } from '../drain-followup-job.mjs';
import { openReservationPr, probeQueuedLand, sweepQueuedHashCards } from '../queue-branch-numbering.mjs';

it('retains reservations when the pass cannot prove a PR closed', () => {
  expect(openReservationPr({ prsByRepo: new Map([['r', []]]), contextComplete: true }, 'r', 1)).toBe(false);
  expect(openReservationPr({ prsByRepo: new Map([['r', []]]), contextComplete: false }, 'r', 1)).toBeUndefined();
  expect(openReservationPr({ prsByRepo: new Map(), contextComplete: true }, 'r', 1)).toBeUndefined();
});

it('threads the queue flag into follow-up input', () => {
  expect(buildFollowupInput({ numberingOnBranch: true }).numberingOnBranch).toBe(true);
  expect(buildFollowupInput({})).not.toHaveProperty('numberingOnBranch');
});

it('reports stranded queue hashes with a read-only probe', () => {
  const exec = vi.fn(() => 'backlog/xabc123-bad.md\n'); const write = vi.fn();
  const result = probeQueuedLand('/clone', { exec, log: { write } });
  expect(result.files).toEqual(['backlog/xabc123-bad.md']);
  expect(result.warning).toContain('not pushed; the merge_group gate should have refused it');
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1][0]).toBe('ls-tree');
  expect(write).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
});

it('publishes a real fast-forward numbering commit to the PR branch, never main', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-numbering-git-'));
  const cwd = join(root, 'clone'); const origin = join(root, 'origin.git');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, cwd], { stdio: 'pipe' });
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@test'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'no-hooks')); git('config', 'core.hooksPath', join(root, 'no-hooks'));
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, '.gitignore'), '.claude/skills/batch-backlog-items/id-ledger.json\n');
    writeFileSync(join(cwd, 'backlog/010-old.md'), '---\nstatus: resolved\n---\n');
    git('add', '.'); git('commit', '-qm', 'seed'); git('push', '-q', 'origin', 'main');
    const main = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'topic');
    writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n');
    git('add', '.'); git('commit', '-qm', 'branch card'); git('push', '-q', 'origin', 'topic');
    const old = git('rev-parse', 'HEAD');
    const c = { repo: 'test/repo', num: 1, headRef: 'topic' };
    const statePath = join(root, 'state.json');
    const lock = (fn, options) => withNumberingLock(fn, { ...options, lockRoot: join(root, 'locks') });
    const result = prepareBranchBeforeEnqueue({ cwd, c, traceHeadSha: old, statePath, lock });
    expect(result, result.reason).toMatchObject({ action: 'numbered', assigned: [{ hash: 'xabc123', nnn: '011' }] });
    expect(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]).toBe(main);
    expect(git('ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]).toBe(result.newHead);
    git('merge-base', '--is-ancestor', old, result.newHead);
    expect(git('ls-tree', '-r', '--name-only', result.newHead)).toContain('backlog/011-foo.md');
    expect(git('ls-tree', '-r', '--name-only', result.newHead)).not.toContain('backlog/xabc123-foo.md');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).reservations[0].nnns).toEqual([11]);
    expect(prepareBranchBeforeEnqueue({ cwd, c, traceHeadSha: result.newHead, statePath, lock })).toEqual({ action: 'final' });
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git('rev-parse', 'HEAD')).toBe(old);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

describe('sweepQueuedHashCards', () => {
  function setup() {
    const nodes = [1, 2, 3, 4].map((number) => ({ id: `entry-${number}`, state: 'QUEUED', pullRequest: {
      id: `pr-${number}`, number, headRefName: `topic-${number}`, headRefOid: `sha-${number}`, isCrossRepository: number === 3,
    } }));
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'gh' && args[3].startsWith('query=query(')) return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes } } } } });
      if (args[0] === 'ls-tree') return args[3] === 'sha-2' ? 'backlog/012-clean.md' : 'backlog/xabc123-card.md';
      return '{}';
    });
    return { repo: 'owner/repo', cwd: '/clone', exec, log: { write: vi.fn() }, prepare: vi.fn(() => ({ action: 'numbered', newHead: 'new' })), isOpen: () => true };
  }
  it('dequeues hash-bearing PRs, prepares their branches, and leaves clean and cross-repo PRs alone', () => {
    const x = setup();
    expect(sweepQueuedHashCards(x)).toEqual({ dequeued: [1, 4], numbered: [1, 4], errors: [] });
    expect(x.exec).toHaveBeenCalledWith('gh', ['api', 'graphql', '-f', expect.stringContaining('mergeQueue(branch:"main")'), '-f', 'owner=owner', '-f', 'name=repo'], expect.any(Object));
    expect(x.exec).toHaveBeenCalledWith('gh', ['api', 'graphql', '-f', 'query=mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}', '-f', 'id=pr-1'], expect.any(Object));
    expect(x.prepare).toHaveBeenCalledWith({ c: { num: 1, repo: null, headRef: 'topic-1', item: null, hasManifest: false }, traceHeadSha: 'sha-1', cwd: '/clone', isLocal: true, isOpen: x.isOpen });
    expect(x.prepare).toHaveBeenCalledTimes(2);
    expect(x.exec.mock.calls.some(([, args]) => args.includes('refs/heads/topic-3'))).toBe(false);
    expect(x.log.write).toHaveBeenCalledWith(expect.stringContaining('PR 1 DEQUEUED: carries hash card(s) backlog/xabc123-card.md'));
  });
  it('continues after an entry fetch fails', () => {
    const x = setup(); const exec = x.exec;
    x.exec = vi.fn((cmd, args, opts) => {
      if (args.includes('refs/heads/topic-1')) throw new Error('fetch failed');
      return exec(cmd, args, opts);
    });
    expect(sweepQueuedHashCards(x)).toEqual({ dequeued: [4], numbered: [4], errors: [{ num: 1, reason: 'fetch failed' }] });
  });
  it('records preparation refusal and queue-read failure without throwing', () => {
    const x = setup(); x.prepare.mockReturnValue({ action: 'skip', reason: 'mutex refused' });
    expect(sweepQueuedHashCards(x)).toEqual({ dequeued: [1, 4], numbered: [], errors: [{ num: 1, reason: 'mutex refused' }, { num: 4, reason: 'mutex refused' }] });
    x.exec.mockImplementation(() => { throw new Error('queue unavailable'); });
    expect(sweepQueuedHashCards(x)).toEqual({ dequeued: [], numbered: [], errors: [{ num: null, reason: 'queue unavailable' }] });
  });
});
