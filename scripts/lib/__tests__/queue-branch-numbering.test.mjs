import { describe, it, expect, vi } from 'vitest';
import * as realFs from 'node:fs';
import { handNumberedNewItems } from '../../check-standards-rules.mjs';
import { BRANCH_NUMBERING_CI_CONTRACT, mainAcceptsBranchNumbering, drainNumberedPairs, trustedDrainAuthors, assertWorktreeCard, exemptDrainNumberedItems, resolveQueueNumbering, hashBacklogFiles, isMergeGroupCiRun, mergeGroupHashRefusals, prepareBranchBeforeEnqueue, reservationPlan, finishBranchPreparation } from '../queue-branch-numbering.mjs';

describe('queue branch numbering', () => {
  it('probes main for the branch-numbering CI contract and fails closed', () => {
    expect(BRANCH_NUMBERING_CI_CONTRACT).toBe('drain-branch-numbering-ci-v1');
    const exec = vi.fn(() => '// drain-branch-numbering-ci-v1');
    expect(mainAcceptsBranchNumbering({ cwd: '/clone', exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith('git', ['show', 'origin/main:scripts/lib/queue-branch-numbering.mjs'], { cwd: '/clone', encoding: 'utf8', stdio: 'pipe' });
    expect(mainAcceptsBranchNumbering({ exec: () => '// older main' })).toBe(false);
    expect(mainAcceptsBranchNumbering({ exec: () => { throw new Error('missing ref'); } })).toBe(false);
  });
  it('reads normalized pairs only from drain JIT-number subjects on the branch', () => {
    const exec = vi.fn(() => [
      'drain: JIT-number xabc123→#5986, xdef456→#5987 at land (#2288)',
      'drain: JIT-number xghi789→#0042 at land (#2288)',
      'unrelated xabc123→#9999',
      'prefix drain: JIT-number xabc123→#9999 at land (#2288)',
      'drain: JIT-number xabc123→#9999 at land (#2288) suffix',
      'drain: JIT-number invalid→#5988, xabc123→#bad at land (#2288)',
    ].map(subject => `Trusted\0drain@example.test\0${subject}`).join('\n'));
    expect(drainNumberedPairs({ cwd: '/clone', exec })).toEqual(new Set(['xabc123→5986', 'xdef456→5987', 'xghi789→42']));
    expect(exec).toHaveBeenCalledWith('git', ['log', '--topo-order', '--reverse', '--format=%an%x00%ae%x00%s', 'origin/main..HEAD'], { cwd: '/clone', encoding: 'utf8', stdio: 'pipe' });
    drainNumberedPairs({ cwd: '/clone', exec, base: 'custom-base' });
    expect(exec).toHaveBeenLastCalledWith('git', ['log', '--topo-order', '--reverse', '--format=%an%x00%ae%x00%s', 'custom-base..HEAD'], { cwd: '/clone', encoding: 'utf8', stdio: 'pipe' });
    expect(drainNumberedPairs({ cwd: '/clone', exec: () => { throw new Error('missing ref'); } })).toEqual(new Set());
  });
  it('carries a drain pair through later collision-heal renumbers, parents first (PR #5042)', () => {
    const exec = () => [
      'drain: JIT-number xaxezem→#5979, xdef456→#5980, xghi789→#5981 at land (#2288)',
      'backlog: heal new-item id collision(s) pre-check (#5979→#5321, #7000→#7001) (#2222)',
      'backlog: heal new-item id collision(s) on land (#5321→#6010) (#2071)',
      'drain: rebase lane/x onto origin/main, drop transient .lane-manifest.json, renumber #5980→#6020/#5981→#6021',
    ].map(subject => `Trusted\0drain@example.test\0${subject}`).join('\n');
    expect(drainNumberedPairs({ cwd: '/clone', exec })).toEqual(new Set(['xaxezem→6010', 'xdef456→6020', 'xghi789→6021']));
  });
  it('applies the moves of one heal commit together, so a swap does not chain', () => {
    const exec = () => [
      'drain: JIT-number xaaaaaa→#10, xbbbbbb→#11 at land (#2288)',
      'backlog: heal new-item id collision(s) pre-check (#10→#11, #11→#10) (#2222)',
    ].map(subject => `Trusted\0drain@example.test\0${subject}`).join('\n');
    expect(drainNumberedPairs({ cwd: '/clone', exec })).toEqual(new Set(['xaaaaaa→11', 'xbbbbbb→10']));
  });
  it('never lets a heal subject exempt a number the drain did not assign', () => {
    const exec = () => [
      'backlog: heal new-item id collision(s) pre-check (#4000→#4001) (#2222)',
      'drain: JIT-number xaxezem→#5979 at land (#2288)',
      'backlog: heal new-item id collision(s) pre-check (#1→#2) (#2222) suffix',
      'drain: rebase lane/x onto origin/main, drop transient .lane-manifest.json',
      'backlog: heal new-item id collision(s) pre-check (#5979→#5321) (#2222)',
    ].map(subject => `Trusted\0drain@example.test\0${subject}`).join('\n');
    const pairs = drainNumberedPairs({ cwd: '/clone', exec });
    expect(pairs).toEqual(new Set(['xaxezem→5321']));
    const items = [{ id: '5321-healed', num: '5321', bornAs: 'xaxezem' }, { id: '4001-picked', num: '4001' }];
    const errors = handNumberedNewItems(exemptDrainNumberedItems(items, { drainNumbered: pairs }), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('4001-picked');
  });
  it('does not let an untrusted author assign a pair, nor a heal of it carry one', () => {
    const exec = vi.fn((_cmd, args) => args.includes('--grep=^drain: JIT-number ')
      ? 'Trusted\0drain@example.test\0drain: JIT-number xaaaaaa→#10 at land (#2288)'
      : [
        'Trusted\0drain@example.test\0drain: JIT-number xaaaaaa→#10 at land (#2288)',
        'Forger\0forger@example.test\0drain: JIT-number xbbbbbb→#20 at land (#2288)',
        'Forger\0forger@example.test\0backlog: heal new-item id collision(s) pre-check (#20→#21) (#2222)',
      ].join('\n'));
    expect(drainNumberedPairs({ cwd: '/clone', exec })).toEqual(new Set(['xaaaaaa→10']));
  });
  it('keeps an accepted drain author trusted after more than 100 newer numbering commits', () => {
    const history = [
      ...Array.from({ length: 101 }, () => 'Newer\0newer@example.test\0drain: JIT-number xbbbbbb→#20 at land (#2288)'),
      'Established\0established@example.test\0drain: JIT-number xaaaaaa→#10 at land (#2288)',
    ];
    const exec = vi.fn((_cmd, args) => {
      if (!args.includes('--grep=^drain: JIT-number ')) return [
        'Established\0established@example.test\0drain: JIT-number xwfgsk7→#6678 at land (#2288)',
        'Forger\0forger@example.test\0drain: JIT-number xcccccc→#6679 at land (#2288)',
      ].join('\n');
      const limit = args.find(arg => arg.startsWith('--max-count='));
      return history.slice(0, limit ? Number(limit.split('=')[1]) : history.length).join('\n');
    });
    const pairs = drainNumberedPairs({ cwd: '/clone', exec });
    expect(pairs).toEqual(new Set(['xwfgsk7→6678']));
    expect(handNumberedNewItems(exemptDrainNumberedItems([
      { id: '6678-admission', num: '6678', bornAs: 'xwfgsk7' },
    ], { drainNumbered: pairs }), [])).toEqual([]);
  });
  it('retains an accepted drain author after 100 newer numbering commits by another author', () => {
    const main = [
      ...Array.from({ length: 100 }, () => 'Recent\0recent@example.test\0drain: JIT-number xbbbbbb→#20 at land (#2288)'),
      'Established\0established@example.test\0drain: JIT-number xaaaaaa→#10 at land (#2288)',
    ];
    const exec = vi.fn((_cmd, args) => {
      if (args.at(-1) !== 'origin/main') return [
        'Established\0established@example.test\0drain: JIT-number xabc123→#30 at land (#2288)',
        'Forger\0forger@example.test\0drain: JIT-number xdef456→#31 at land (#2288)',
      ].join('\n');
      const limit = args.find(arg => arg.startsWith('--max-count='));
      return (limit ? main.slice(0, Number(limit.split('=')[1])) : main).join('\n');
    });
    const pairs = drainNumberedPairs({ cwd: '/clone', exec });
    expect(pairs).toEqual(new Set(['xabc123→30']));
    expect(handNumberedNewItems(exemptDrainNumberedItems([
      { id: '30-drained', num: '30', bornAs: 'xabc123' },
      { id: '31-forged', num: '31', bornAs: 'xdef456' },
    ], { drainNumbered: pairs }), [])).toEqual([expect.stringContaining('31-forged')]);
  });
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
  it('exempts only matching hash and numeric pairs without mutating input', () => {
    const items = Object.freeze([
      Object.freeze({ num: '05938', bornAs: 'xabc123' }),
      Object.freeze({ num: '5939', bornAs: 'xabc123' }),
      Object.freeze({ num: '5938', bornAs: 'xdef456' }),
      ...[undefined, null, '', '5938', 'xabc12', 'xabc1234', 'XABC123', ' xabc123'].map((bornAs) => Object.freeze({ num: '5939', bornAs })),
    ]);
    expect(exemptDrainNumberedItems(items, { drainNumbered: new Set(['xabc123→5938']) })).toEqual(items.slice(1));
    expect(exemptDrainNumberedItems(items, { drainNumbered: new Set() })).toEqual(items);
    expect(exemptDrainNumberedItems([], { drainNumbered: new Set(['xabc123→5938']) })).toEqual([]);
  });
  it('keeps the hand-picked-id gate active for unstamped cards and absent drain pairs', () => {
    const items = [
      { id: '5938-drained', num: '5938', bornAs: 'xabc123' },
      { id: '5939-picked', num: '5939' },
      { id: '5940-invalid', num: '5940', bornAs: 'not-a-hash' },
      { id: '010-main', num: '010' },
    ];
    const main = ['backlog/010-main.md'];
    const enabled = handNumberedNewItems(exemptDrainNumberedItems(items, { drainNumbered: new Set(['xabc123→5938']) }), main);
    expect(enabled).toHaveLength(2);
    expect(enabled[0]).toContain('5939-picked');
    expect(enabled[1]).toContain('5940-invalid');
    expect(handNumberedNewItems(exemptDrainNumberedItems(items, { drainNumbered: new Set() }), main)).toHaveLength(3);
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
    const fs = { lstatSync: vi.fn(path => ({ isSymbolicLink: () => false, isFile: () => path.endsWith('.md'), isDirectory: () => !path.endsWith('.md') })), symlinkSync: vi.fn(), mkdtempSync: vi.fn(() => '/tmp/fake'), rmSync: vi.fn(), readFileSync: vi.fn(() => state), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() };
    const number = vi.fn(() => { numbered = true; return { assigned: [{ hash: 'xabc123', nnn: '041' }], committed: true }; });
    const lock = vi.fn((fn) => ({ ran: true, result: fn() }));
    const args = { c: { repo: 'r', num: 4, headRef: 'topic' }, traceHeadSha: 'old', cwd: '/clone', statePath: '/state/reservations.json', exec, fs, number, lock, isOpen: () => true };
    return { args, exec, fs, number, lock };
  }
  it.each(['card', 'parent'])('refuses a symlinked backlog %s before numbering or writing outside the worktree', kind => {
    const x = setup();
    x.fs.lstatSync = vi.fn(path => ({ isSymbolicLink: () => kind === 'card' ? path.endsWith('.md') : path.endsWith('/backlog'), isFile: () => path.endsWith('.md'), isDirectory: () => !path.endsWith('.md') }));
    expect(prepareBranchBeforeEnqueue(x.args)).toMatchObject({ action: 'skip', reason: expect.stringContaining('symlink') });
    expect(x.number).not.toHaveBeenCalled();
    expect(x.fs.writeFileSync).not.toHaveBeenCalled();
  });
  it('does not exempt a forged-author numbering commit', () => {
    const exec = vi.fn((_cmd, args) => args.includes('--format=%s') ? 'drain: JIT-number xabc123→#5986 at land (#2288)\n' : args.at(-1) === 'origin/main'
      ? 'Trusted\0drain@example.test\0drain: JIT-number xdef456→#42 at land (#2288)\n'
      : 'Attacker\0attacker@example.test\0drain: JIT-number xabc123→#5986 at land (#2288)\n');
    const pairs = drainNumberedPairs({ cwd: '/clone', exec });
    expect(pairs).toEqual(new Set());
    expect(handNumberedNewItems(exemptDrainNumberedItems([{ id: '5986-picked', num: '5986', bornAs: 'xabc123' }], { drainNumbered: pairs }), [])).toHaveLength(1);
  });
  it('retains accepted drain identities after more than 100 newer numbering commits', () => {
    const accepted = [
      ...Array.from({ length: 100 }, () => 'Current\0current@example.test\0drain: JIT-number xaaaaaa→#10 at land (#2288)'),
      'Returning\0returning@example.test\0drain: JIT-number xbbbbbb→#20 at land (#2288)',
    ];
    const exec = vi.fn((_cmd, args) => {
      if (args.at(-1) === 'origin/main') {
        const limit = args.find(arg => arg.startsWith('--max-count='));
        return accepted.slice(0, limit ? Number(limit.split('=')[1]) : undefined).join('\n');
      }
      return [
        'Returning\0returning@example.test\0drain: JIT-number xabc123→#6672 at land (#2288)',
        'Forger\0forger@example.test\0drain: JIT-number xdef456→#6673 at land (#2288)',
      ].join('\n');
    });
    const pairs = drainNumberedPairs({ cwd: '/clone', exec });
    expect(pairs).toEqual(new Set(['xabc123→6672']));
    const items = [
      { id: '6672-drained', num: '6672', bornAs: 'xabc123' },
      { id: '6673-forged', num: '6673', bornAs: 'xdef456' },
    ];
    const errors = handNumberedNewItems(exemptDrainNumberedItems(items, { drainNumbered: pairs }), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('6673-forged');
  });
  it('bounds the trusted identity read by time and output size', () => {
    const exec = vi.fn(() => 'Trusted\0drain@example.test\0drain: JIT-number xabc123→#42 at land (#2288)\n');
    expect(trustedDrainAuthors({ cwd: '/clone', exec })).toEqual(new Set(['Trusted\0drain@example.test']));
    expect(exec).toHaveBeenCalledWith('git', ['log', '--grep=^drain: JIT-number ', '--format=%an%x00%ae%x00%s', 'origin/main'], expect.objectContaining({ timeout: 60000, maxBuffer: 4 * 1024 * 1024 }));
    expect(trustedDrainAuthors({ exec: () => { throw new Error('history unavailable'); } })).toEqual(new Set());
  });
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
    expect(x.exec).toHaveBeenCalledWith('git', ['push', '--no-verify', 'origin', 'HEAD:refs/heads/topic'], expect.any(Object));
    expect(x.fs.writeFileSync).toHaveBeenCalled();
    for (const [, , options] of x.exec.mock.calls) expect(options.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });
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
  it('leaves a numeric unresolved manifest card final without committing or pushing', () => {
    const x = setup({ pending: false });
    x.args.c = { ...x.args.c, hasManifest: true, item: '041' };
    x.fs.readFileSync.mockImplementation((path) => path.endsWith('.md') ? '---\nstatus: open\n---\n' : '{"reservations":[]}');
    expect(prepareBranchBeforeEnqueue(x.args)).toEqual({ action: 'final' });
    expect(x.number).not.toHaveBeenCalled();
    expect(x.lock).not.toHaveBeenCalled();
    expect(x.fs.writeFileSync).not.toHaveBeenCalled();
    expect(x.exec.mock.calls.some(([, args]) => ['push', 'commit'].includes(args[0]))).toBe(false);
  });
  it('numbers a hash manifest card without resolving it', () => {
    const x = setup();
    x.args.c = { ...x.args.c, hasManifest: true, item: 'xabc123' };
    x.fs.readFileSync.mockImplementation((path) => path.endsWith('.md') ? '---\nstatus: open\n---\n' : '{"reservations":[]}');
    expect(prepareBranchBeforeEnqueue(x.args)).toEqual({ action: 'numbered', newHead: 'new', assigned: [{ hash: 'xabc123', nnn: '041' }] });
    expect(x.exec.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
    expect(x.fs.writeFileSync.mock.calls.some(([path]) => path.endsWith('.md'))).toBe(false);
  });
  it('refuses failed numbering without pushing', () => {
    const x = setup(); x.args.number = () => ({ assigned: [], error: 'number failed' });
    expect(prepareBranchBeforeEnqueue(x.args).reason).toContain('number failed');
    expect(x.exec.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withNumberingLock } from '../../readiness/drain-lock.mjs';
import { buildFollowupInput } from '../drain-followup-job.mjs';
import { withHooksDisabled, fallbackMinNext, repairHashOnMain, openReservationPr, probeQueuedLand, sweepQueuedHashCards } from '../queue-branch-numbering.mjs';

it('rejects a real external card symlink and leaves the target unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-symlink-'));
  try {
    const tree = join(root, 'tree'); mkdirSync(join(tree, 'backlog'), { recursive: true });
    const outside = join(root, 'outside.md'); const text = '---\nstatus: open\n---\n';
    writeFileSync(outside, text); symlinkSync(outside, join(tree, 'backlog/xabc123-card.md'));
    expect(() => assertWorktreeCard(tree, 'backlog/xabc123-card.md')).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe(text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])('permits confined convenience links and refuses escaping links (external=%s)', external => {
  const root = mkdtempSync(join(tmpdir(), 'queue-directory-link-'));
  try {
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'backlog'), { recursive: true }); mkdirSync(join(tree, '.claude'));
    mkdirSync(join(tree, 'skills-src')); mkdirSync(join(root, 'outside'));
    writeFileSync(join(tree, 'backlog/041-card.md'), '---\nstatus: resolved\n---\n');
    symlinkSync(external ? join(root, 'outside') : '../skills-src', join(tree, '.claude/skills'));
    const exec = vi.fn((_cmd, args) => args[0] === 'ls-remote' ? 'head\trefs/heads/lane/example' : args[0] === 'ls-files'
      ? (args.length === 1 ? 'backlog/041-card.md\n.claude/skills' : 'backlog/041-card.md') : '');
    const out = prepareBranchBeforeEnqueue({ c: { headRef: 'lane/example' }, traceHeadSha: 'head', exec,
      fs: { ...realFs, mkdtempSync: () => root }, number: () => { throw new Error('unexpected numbering'); } });
    expect(out).toMatchObject(external ? { action: 'skip', reason: expect.stringContaining('escapes worktree') } : { action: 'final' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
  expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['fetch', 'ls-tree']);
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
    let old = git('rev-parse', 'HEAD');
    mkdirSync(join(cwd, '.githooks'));
    mkdirSync(join(cwd, 'scripts'));
    const sentinel = join(root, 'executed-untrusted-code');
    for (const hook of ['pre-commit', 'pre-push']) writeFileSync(join(cwd, '.githooks', hook), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    writeFileSync(join(cwd, 'scripts/backlog.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
    git('add', '.'); git('commit', '-qm', 'untrusted branch code'); git('push', '-q', 'origin', 'topic');
    git('config', 'core.hooksPath', '.githooks');
    const c = { repo: 'test/repo', num: 1, headRef: 'topic', hasManifest: true, item: 'xabc123' };
    old = git('rev-parse', 'HEAD');
    const statePath = join(root, 'state.json');
    const lock = (fn, options) => withNumberingLock(fn, { ...options, lockRoot: join(root, 'locks') });
    const envBefore = { ...process.env };
    const result = prepareBranchBeforeEnqueue({ cwd, c, traceHeadSha: old, statePath, lock });
    expect(process.env).toEqual(envBefore);
    expect(result, result.reason).toMatchObject({ action: 'numbered', assigned: [{ hash: 'xabc123', nnn: '011' }] });
    expect(existsSync(sentinel)).toBe(false);
    expect(git('show', `${result.newHead}:backlog/011-foo.md`)).toContain('status: open');
    expect(result).not.toHaveProperty('resolved');
    expect(git('log', '--format=%s', `${old}..${result.newHead}`).split('\n')).toEqual(['drain: JIT-number xabc123→#011 at land (#2288)']);
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

it('restores existing and absent hook configuration even on failure', () => {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const original = keys.map((k) => process.env[k]);
  try {
    process.env.GIT_CONFIG_COUNT = '2';
    delete process.env.GIT_CONFIG_KEY_0;
    process.env.GIT_CONFIG_VALUE_0 = 'prior';
    expect(() => withHooksDisabled(() => {
      expect(keys.map((k) => process.env[k])).toEqual(['1', 'core.hooksPath', '/dev/null']);
      throw new Error('failure');
    })).toThrow('failure');
    expect(keys.map((k) => process.env[k])).toEqual(['2', undefined, 'prior']);
    expect(withHooksDisabled(() => 42)).toBe(42);
    expect(keys.map((k) => process.env[k])).toEqual(['2', undefined, 'prior']);
  } finally { keys.forEach((k, i) => original[i] === undefined ? delete process.env[k] : process.env[k] = original[i]); }
});

it('fallback allocation retains queue reservations above main', () => {
  const exec = vi.fn(() => 'backlog/100-main.md');
  const fs = { readFileSync: () => JSON.stringify({ reservations: [{ repo: null, num: 9, headRef: 'topic', nnns: [101], at: 'now' }] }) };
  expect(fallbackMinNext({ cwd: '/clone', exec, fs, statePath: '/state' })).toBe(102);
});

it('probes on every live queue pass and repairs when inline numbering will not run', () => {
  const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
  expect(source).toContain('if (mergeStrategy.enqueues(null) && !DRY_RUN) numbered = probeQueuedLand(process.cwd());');
  expect(source).toContain('if (queuedHashOnMain && !landedLocal && !DRY_RUN) numbered = repairHashOnMain(');
  expect(source).toContain('(numberingOnBranch || queuedHashOnMain) ? { minNext: fallbackMinNext(');
  expect(source).toContain('if (landedLocal && !DRY_RUN) {\n    if (queuedHashOnMain)');
});

it('repairs fresh remote main under the lock above reservations, leaving the checkout alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-repair-'));
  const cwd = join(root, 'clone'), origin = join(root, 'origin.git');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, cwd], { stdio: 'pipe' });
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@test');
    git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/100-main.md'), '---\nstatus: resolved\n---\n');
    git('add', '.'); git('commit', '-qm', 'seed'); git('push', '-q', 'origin', 'main');
    const stale = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n');
    git('add', '.'); git('commit', '-qm', 'human land'); git('push', '-q', 'origin', 'main');
    const landed = git('rev-parse', 'HEAD');
    git('checkout', '--detach', stale);
    git('update-ref', 'refs/remotes/origin/main', stale);
    const statePath = join(root, 'reservations.json');
    writeFileSync(statePath, JSON.stringify({ reservations: [{ repo: null, num: 9, headRef: 'queued', nnns: [101], at: 'now' }] }));
    const log = { write: vi.fn() };
    const lock = vi.fn((fn) => ({ ran: true, result: fn() }));
    const exec = vi.fn(execFileSync);
    const refused = repairHashOnMain({ cwd, statePath, exec, log, lock: () => ({ ran: false }) });
    expect(refused.pushed).not.toBe(true);
    expect(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]).toBe(landed);
    const out = repairHashOnMain({ cwd, statePath, exec, log, lock });
    expect(out).toMatchObject({ committed: true, pushed: true, assigned: [{ hash: 'xabc123', nnn: '102' }] });
    expect(lock).toHaveBeenCalledWith(expect.any(Function), { runUnlockedOnContention: false });
    const push = exec.mock.calls.find(([, args]) => args[0] === 'push');
    expect(push[1]).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/main']);
    expect(push[2].env).toMatchObject({ MAIN_PUSH_OK: '1', GIT_CONFIG_VALUE_0: '/dev/null' });
    git('fetch', 'origin');
    expect(git('ls-tree', '-r', '--name-only', 'origin/main')).toContain('backlog/102-foo.md');
    expect(git('rev-parse', 'HEAD')).toBe(stale);
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(log.write).toHaveBeenCalledWith('  ⚠ FALLBACK: hash card(s) backlog/xabc123-foo.md on main — numbered and pushed to main so the queue is not blocked\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
