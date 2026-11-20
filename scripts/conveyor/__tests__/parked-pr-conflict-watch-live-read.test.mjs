import { describe, expect, it, vi } from 'vitest';
import { defaultReadPrLive, defaultRevertBounce,
  defaultPostConflictFinding } from '../parked-pr-conflict-watch.mjs';
import { invalidateConflictFinding } from '../../lib/conflict-finding.mjs';
import { readFileSync } from 'node:fs';
import * as watch from '../parked-pr-conflict-watch.mjs';
import { buildReconcileFindingBody } from '../reconcile-finding.mjs';
import { buildVerdictComment, runReviewLabelCli } from '../../review-set-label.mjs';
import { createGhProvider } from '../../lib/review-label-provider.mjs';

const head = 'a'.repeat(40), moved = 'b'.repeat(40);
const pr = { number: 7183, headRefOid: head };
const repo = 'o/n';

describe('accepted bounce writes the harmful label swap last', () => {
  it.each(['before-comment', 'before-swap-mergeable', 'before-swap-head', 'swap-pin', 'edit-fails', 'clear-ledger-fails', 'success'])(
    '%s preserves approval until the final guarded swap and reports partial writes', scenario => {
      let liveHead = head, mergeable = 'CONFLICTING';
      let labels = ['review:accepted', 'ready-to-merge'];
      const thread = [], ledger = [], writes = [], entry = {}, log = vi.fn();
      const provider = createGhProvider({ exec: argv => {
        if (argv[0] === 'pr' && argv[1] === 'view') return JSON.stringify({ headRefOid: liveHead,
          labels, comments: thread, state: 'OPEN', body: '' });
        if (argv[0] === 'pr' && argv[1] === 'comment') {
          const body = readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8');
          expect(body).toContain('&lt;!-- conflict-watch-bounce:');
          thread.push({ id: 'IC_test', body, createdAt: new Date().toISOString(), author: { login: 'web-everything' } });
          writes.push('comment');
          if (scenario !== 'success') {
            if (scenario === 'before-swap-head' || scenario === 'swap-pin') liveHead = moved;
            else mergeable = 'MERGEABLE';
          }
          return '';
        }
        if (argv[0] === 'pr' && argv[1] === 'edit') {
          writes.push('label');
          labels = ['review:changes'];
          return '';
        }
        if (argv[0] === 'api' && argv[1] === 'graphql') {
          if (scenario === 'edit-fails') throw new Error('edit unavailable');
          const id = argv.find(a => a.startsWith('id=')).slice(3);
          const body = readFileSync(argv.find(a => a.startsWith('body=@')).slice(6), 'utf8');
          thread.find(c => c.id === id).body = body;
          return '';
        }
        throw new Error(`unexpected fake gh: ${JSON.stringify(argv)}`);
      } });
      const result = watch.bounceIfStillConflicting({ pr: { ...pr, labels }, judgedHead: head, repo, entry, log,
        revertBounce: vi.fn(() => { throw new Error('unexpected post-swap rollback'); }),
        readPrLive: () => ({ headRefOid: scenario === 'swap-pin' ? head : liveHead, mergeable }),
        postFindingArgs: { provider, listPrComments: () => thread, writerOptions: {
          signalFix: () => {}, appendVerdict: row => {
            if (row.reasonCode === 'cleared' && scenario === 'clear-ledger-fails') return { ok: false, errors: ['ledger unavailable'] };
            ledger.push(row);
            if (row.reasonCode !== 'cleared') {
              writes.push('ledger');
              if (scenario === 'before-comment') mergeable = 'MERGEABLE';
            }
            return { ok: true };
          },
        } },
      });
      if (scenario === 'success') {
        expect(result).toBe(true);
        expect(writes).toEqual(['ledger', 'comment', 'label']);
        expect(labels).toEqual(['review:changes']);
        return;
      }
      expect(result).toBe(false);
      expect(labels).toEqual(['review:accepted', 'ready-to-merge']);
      expect(writes).toEqual(scenario === 'before-comment' ? ['ledger'] : ['ledger', 'comment']);
      expect(entry.error).toMatch(scenario === 'edit-fails' ? /edit unavailable/ : scenario === 'clear-ledger-fails' ? /ledger unavailable/ : /conflict-cleared-before-bounce/);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-.*error/));
      if (scenario !== 'clear-ledger-fails') expect(ledger).toContainEqual(expect.objectContaining({ reasonCode: 'cleared', type: 'release' }));
      if (scenario !== 'before-comment' && scenario !== 'edit-fails') {
        expect(thread[0].body).toBe(`superseded: conflict cleared on ${head}`);
        expect(watch.hasRecentConflictFindingComment(thread)).toBe(false);
      }
    });
});

describe('default conflict-watch GitHub readers', () => {
  it('reads the live PR using bounded, throttled App-only argv', () => {
    const exec = vi.fn(() => JSON.stringify({ headRefOid: moved, mergeable: 'UNKNOWN' }));
    expect(defaultReadPrLive({ pr, repo, exec })).toEqual({ headRefOid: moved, mergeable: 'UNKNOWN' });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '7183', '--repo', repo,
      '--json', 'headRefOid,mergeable'], expect.objectContaining({ timeout: expect.any(Number),
      maxBuffer: 1024 * 1024, throttle: { personalRoute: false },
      env: expect.objectContaining({ WE_GH_THROTTLE_PERSONAL_ROUTE: '0' }) }));
  });
  it('propagates unreadable/oversized GitHub output for the caller to hold', () => {
    const exec = () => { throw new Error('maxBuffer exceeded'); };
    expect(() => defaultReadPrLive({ pr, repo, exec })).toThrow('maxBuffer');
  });
  it.each([
    ['concurrent rejection', ['review:changes', 'advisory:changes'], head],
    ['concurrent rearm', ['review:pending'], head],
    ['concurrent acceptance', ['review:accepted'], head],
    ['another head move', ['review:changes'], moved],
    ['missing receipt', ['review:changes'], head],
  ])('skips rollback after %s without editing live labels', (_, labels, liveHead) => {
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: liveHead, labels, comments: [] })) };
    expect(defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:accepted'] },
      headRefOid: head, provider })).toBe('bounce-revert-skipped-state-changed');
    expect(provider.readPrState).toHaveBeenCalledWith(repo, pr.number);
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('skips a concurrent same-label rejection after our finding token', () => {
    const findingToken = '12345678-1234-1234-1234-123456789abc';
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: head,
      labels: ['review:changes'], comments: [
        { author: { login: 'web-everything' }, body: `<!-- conflict-watch-bounce:${findingToken} -->` },
        { author: { login: 'web-everything' }, body: 'Independent rejection' },
      ] })) };
    expect(defaultRevertBounce({ pr, repo, headRefOid: head, findingToken, provider }))
      .toBe('bounce-revert-skipped-state-changed');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('holds when rollback state is unreadable or oversized', () => {
    const provider = { setLabels: vi.fn(), readPrState: () => { throw new Error('maxBuffer exceeded'); } };
    expect(() => defaultRevertBounce({ pr, repo, headRefOid: head, provider })).toThrow('maxBuffer');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('retains our bounce when snapshot acceptance has no guarded clearing proof', () => {
    const findingToken = '12345678-1234-1234-1234-123456789abc';
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: head,
      labels: ['review:changes'], comments: [{ author: { login: 'web-everything' },
        body: `<!-- conflict-watch-bounce:${findingToken} -->` }] })) };
    expect(() => defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:accepted', 'ready-to-merge'] },
      headRefOid: head, findingToken, provider })).toThrow('human review/rearm');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('passes the judged head through the real finding transport', () => {
    const exec = vi.fn();
    defaultPostConflictFinding({ pr, repo, headRefOid: head, exec });
    expect(exec.mock.calls[0][1]).toContain(`--expect-head=${head}`);
  });
});

describe('changes writer head pin', () => {
  it.each([head, moved, 'short'])('refuses a missing or moved head before any write (pin %s)', pin => {
    const provider = { readPrState: vi.fn(() => ({ headRefOid: moved, labels: [{ name: 'review:accepted' }],
      comments: [], state: 'OPEN', headRefName: 'lane/7183', body: '' })), postComment: vi.fn(), setLabels: vi.fn() };
    // For the matching pin, move the head only at the pre-write read.
    if (pin === moved) provider.readPrState.mockReturnValueOnce({ headRefOid: moved, labels: [{ name: 'review:accepted' }],
      comments: [], state: 'OPEN', headRefName: 'lane/7183', body: '' }).mockReturnValue({ headRefOid: head });
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
    try {
      expect(() => runReviewLabelCli({ argv: ['7183', '--repo=o/n', '--to=changes', `--expect-head=${pin}`],
        provider, emit: () => {}, verdictBody: 'Resolve the conflict.', defaultActor: 'test',
        buildComment: () => 'finding', successResult: o => o, refusalResult: o => o })).toThrow();
      expect(provider.setLabels).not.toHaveBeenCalled();
      expect(provider.postComment).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });
});

describe('conflict finding rollback receipt', () => {
  const findingToken = '12345678-1234-1234-1234-123456789abc';
  const marker = `<!-- conflict-watch-bounce:${findingToken} -->`;
  const comment = { id: 'IC_bounce', body: buildVerdictComment({ to: 'changes', actor: 'watch', body: buildReconcileFindingBody(`finding\n${marker}`) }), author: { login: 'web-everything' } };
  it('edits exactly the trusted finding identified by the transport receipt', () => {
    const provider = { editComment: vi.fn() };
    invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head, provider,
      listPrComments: () => [{ ...comment, id: 'IC_other', body: 'unrelated finding' }, comment] });
    expect(provider.editComment).toHaveBeenCalledTimes(1);
    expect(provider.editComment).toHaveBeenCalledWith(repo, comment.id,
      expect.stringContaining(`bounce reverted for head ${head}`), { pr: pr.number });
    expect(provider.editComment.mock.calls[0][2]).not.toContain('Auto-detected by');
  });
  it.each([
    ['missing finding', []],
    ['unreadable thread', null],
    ['untrusted matching comment', [{ ...comment, author: { login: 'stranger' } }]],
    ['ambiguous receipt', [comment, { ...comment, id: 'IC_duplicate' }]],
    ['missing comment id', [{ ...comment, id: undefined }]],
  ])('retains the bounce rather than editing a %s', (_, comments) => {
    const provider = { editComment: vi.fn() };
    expect(() => invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head, provider,
      listPrComments: () => comments })).toThrow('bounce retained');
    expect(provider.editComment).not.toHaveBeenCalled();
  });
  it('propagates failed comment edits so approval labels cannot be restored', () => {
    expect(() => invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head,
      listPrComments: () => [comment], provider: { editComment: () => { throw new Error('edit unavailable'); } } }))
      .toThrow('edit unavailable');
  });
});


describe('single conflict bounce choke point', () => {
  it('has no direct finding calls outside the choke point', () => {
    const source = readFileSync('scripts/conveyor/parked-pr-conflict-watch.mjs', 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const start = source.indexOf('export function bounceIfStillConflicting(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nexport ', start + 1);
    const outside = source.slice(0, start) + source.slice(end);
    expect(outside).not.toMatch(/\bpostFinding\s*\(/);
  });
  it.each(['ledger', 'comment', 'label'])('holds on a head move immediately before %s', step => {
    const writes = [], log = vi.fn(), revertBounce = vi.fn();
    let live = { headRefOid: head, mergeable: 'CONFLICTING' };
    const postFinding = ({ beforeWrite }) => {
      for (const name of ['ledger', 'comment', 'label']) {
        if (name === step) live = { headRefOid: moved, mergeable: 'CONFLICTING' };
        beforeWrite(name);
        writes.push(name);
      }
    };
    expect(watch.bounceIfStillConflicting({ pr, judgedHead: head, repo, postFinding,
      postFindingArgs: {}, readPrLive: () => live, revertBounce, log })).toBe(false);
    expect(writes).toEqual(['ledger', 'comment', 'label'].slice(0, ['ledger', 'comment', 'label'].indexOf(step)));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\d{4}-.*conflict-cleared-before-bounce/));
    expect(revertBounce).not.toHaveBeenCalled();
  });
  it.each([null, { headRefOid: head, mergeable: 'UNKNOWN' }, { headRefOid: head, mergeable: 'MERGEABLE' }])(
    'holds incomplete or cleared evidence %j', live => {
      const postFinding = vi.fn();
      expect(watch.bounceIfStillConflicting({ pr, judgedHead: head, repo, postFinding,
        readPrLive: () => live, log: () => {} })).toBe(false);
      expect(postFinding).not.toHaveBeenCalled();
    });
  it.each([undefined, 'short'])('holds an invalid judged head %s', judgedHead => {
    const postFinding = vi.fn();
    expect(watch.bounceIfStillConflicting({ pr, judgedHead, repo, postFinding,
      readPrLive: () => ({ headRefOid: head, mergeable: 'CONFLICTING' }), log: () => {} })).toBe(false);
    expect(postFinding).not.toHaveBeenCalled();
  });
});

// Exercise the actual transport, reconcile harness and renderer: a fake writer
// calling the callback itself cannot prove the production write boundaries.
describe('production finding write boundaries', () => {
  for (const step of ['ledger', 'comment', 'label']) {
    it.each(['moved', 'MERGEABLE', 'UNKNOWN', 'null', 'unreadable', 'oversized'])(
      `stops before ${step} when live evidence becomes %s`, evidence => {
        const writes = [], thread = [], log = vi.fn();
        const index = ['ledger', 'comment', 'label'].indexOf(step);
        const provider = {
          readPrState: () => ({ headRefOid: head, labels: [], comments: [], state: 'OPEN', body: '' }),
          readLabels: () => [],
          postComment: (_repo, _pr, body) => { expect(body).toContain('&lt;!-- conflict-watch-bounce:'); writes.push('comment');
            thread.push({ id: 'IC_partial', body, author: { login: 'web-everything' } }); },
          editComment: vi.fn((_repo, id, body) => { thread.find(c => c.id === id).body = body; }),
          setLabels: () => writes.push('label'),
        };
        let reads = 0;
        const readPrLive = () => {
          if (++reads === index + 2) {
            if (evidence === 'unreadable' || evidence === 'oversized') throw new Error(evidence);
            if (evidence === 'null') return null;
            return { headRefOid: evidence === 'moved' ? moved : head,
              mergeable: evidence === 'moved' ? 'CONFLICTING' : evidence };
          }
          return { headRefOid: head, mergeable: 'CONFLICTING' };
        };
        expect(watch.bounceIfStillConflicting({ pr, judgedHead: head, repo, readPrLive, log,
          postFindingArgs: { provider, listPrComments: () => thread, writerOptions: { emit: () => {},
            appendVerdict: row => { if (row.reasonCode !== 'cleared') writes.push('ledger'); return { ok: true }; }, signalFix: () => {} } },
        })).toBe(false);
        expect(writes).toEqual(['ledger', 'comment', 'label'].slice(0, index));
        expect(provider.editComment).toHaveBeenCalledTimes(step === 'label' ? 1 : 0);
        expect(watch.hasRecentConflictFindingComment(thread)).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('conflict-cleared-before-bounce'));
      });
  }
});


describe('partial bounce recovery', () => {
  it.each(['ledger', 'comment', 'label'])(
    'keeps the next conflicting sweep dispatchable after refusal before %s', step => {
      const now = Date.parse('2026-11-19T20:00:00Z'), thread = [];
      let labels = ['review:pending'], liveReads = 0, refuse = true;
      const snapshot = () => ({ ...pr, headRefName: 'lane/7183', baseRefName: 'main',
        mergeable: 'CONFLICTING', labels, files: [{ path: 'scripts/x.mjs' }] });
      const provider = {
        readPrState: () => ({ ...snapshot(), state: 'OPEN', body: '', comments: thread }),
        readLabels: () => labels,
        postComment: (_repo, _pr, body) => thread.push({ id: `IC_${thread.length}`,
          body, createdAt: new Date(now).toISOString(), author: { login: 'web-everything' } }),
        editComment: vi.fn((_repo, id, body) => { thread.find(c => c.id === id).body = body; }),
        ensureLabel: () => {},
        setLabels: vi.fn((_repo, _pr, { add, remove }) => {
          labels = labels.filter(label => !remove.includes(label));
          if (add && !labels.includes(add)) labels.push(add);
        }),
      };
      const postFinding = vi.fn(options => defaultPostConflictFinding({ ...options, provider,
        listPrComments: () => thread,
        writerOptions: { appendVerdict: () => ({ ok: true }), signalFix: () => {} },
      }));
      const sweep = () => watch.watchParkedPrConflicts({ repo, listPrs: () => [snapshot()],
        provider, postFinding, listPrComments: () => thread, now, log: () => {},
        inCardGroupFn: () => false, cardGroupStateUnreadable: () => false,
        sameLineConflict: 'fixer', listAgents: () => [], labelRemovedAtMs: () => 0,
        listPrFiles: () => snapshot().files, computeConflictDisposition: () => 'real',
        computeConflictingPaths: () => ['scripts/x.mjs'],
        readPrLive: () => {
          const boundary = ['ledger', 'comment', 'label'].indexOf(step) + 2;
          return { headRefOid: head, mergeable: refuse && ++liveReads === boundary ? 'MERGEABLE' : 'CONFLICTING' };
        },
      });
      expect(sweep()[0]).toMatchObject({ routedTo: 'conflict-cleared-before-bounce' });
      expect(labels).not.toContain('review:changes');
      expect(watch.hasRecentConflictFindingComment(thread, { now })).toBe(false);
      expect(provider.editComment).toHaveBeenCalledTimes(step === 'label' ? 1 : 0);
      refuse = false;
      expect(sweep()[0].error).toBeUndefined();
      expect(postFinding).toHaveBeenCalledTimes(2);
      expect(labels).toContain('review:changes');
      expect(watch.hasRecentConflictFindingComment(thread, { now })).toBe(true);
    });
});
