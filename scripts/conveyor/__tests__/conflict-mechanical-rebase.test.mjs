import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { buildConflictRebaseCandidates, sweepMechanicalConflictRebases, createConflictRebaseLedger,
  resolveConflictRebaseSettings, defaultReadConflictRebasePr } from '../conflict-mechanical-rebase.mjs';
import { STAND_DOWN_MARKER, buildConcurrentAuthorPauseComment, buildLoadFlakeHoldComment,
  buildLoadFlakeResolvedComment } from '../stand-down.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { readSettingsChecked } from '../../lib/settings-files.mjs';
import { runTickAllRepos, buildCliDaemonEffects, runConflictRebaseAllRepos, resolveFixPassBudgets } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

import { CONFLICT_FIX_ABSOLUTE_CEILING, CONFLICT_FIX_ROUND_CAP } from '../reconcile-core.mjs';
import { CONFLICT_FIX_COMMENT_MARKER, countConflictFixComments, countStaleConflictFixRounds } from '../conflict-fix-round-count.mjs';
import { buildConflictFixMarkComment, postConflictFixMarkComment } from '../conflict-fix-mark.mjs';

const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40);
const pr = (number, extra = {}) => ({ number, state: 'OPEN', baseRefName: 'main', isCrossRepository: false,
  headRefName: `lane/test-${number}`, headRefOid: 'c'.repeat(40), mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', labels: [], comments: [], ...extra });
const fixture = (extra = {}) => { const opts = { repo: 'web-everything/web-everything', apply: true,
  readOpenPrs: () => [pr(1), pr(2), pr(3)], readMainTip: () => ({ sha }),
  run: vi.fn(() => ({ status: 0, stdout: sha })),
  refresh: vi.fn(() => ({ ok: true, action: 'rebased', newCommit: nextSha })),
  ledger: createConflictRebaseLedger({ env: { WE_UNDER_TEST: '1' } }), maxPerPass: 3,
  now: () => 1000, checkClaim: () => null, readIsCrossRepository: () => false,
  reconcileAcceptance: vi.fn(() => ({ attempted: false })), postComment: vi.fn(), ...extra };
  opts.readPr ??= number => opts.readOpenPrs().find(p => p.number === number);
  return opts; };

describe('mechanical conflict rebase', () => {
  const trusted = (body, extra = {}) => ({ body, author: { login: 'web-everything' }, ...extra });
  const stop = trusted(`${STAND_DOWN_MARKER}\nQuestion needing an operator answer.`, { id: 'IC_stop' });

  it.each(['discovery', 'fresh'])('shared absolute ceiling at %s leaves human escalation ownership and no ledger attempt', phase => {
    const comments = Array.from({ length: CONFLICT_FIX_ABSOLUTE_CEILING + (phase === 'fresh' ? 1 : 0) }, () => trusted(CONFLICT_FIX_COMMENT_MARKER));
    const opts = fixture({ readOpenPrs: () => [pr(1, { comments: phase === 'discovery' ? comments : [] })],
      readPr: () => pr(1, { comments }) });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([{ kind: 'conflict-rebase-ceiling', why: expect.stringContaining('human takeover') }]);
    expect(opts.ledger.read()).toEqual({}); expect(opts.refresh).not.toHaveBeenCalled();
  });

  it('posts the shared target-stamped durable marker before refresh', () => {
    const exec = vi.fn();
    const opts = fixture({ readOpenPrs: () => [pr(1)], postComment: (n, options) => postConflictFixMarkComment(n, { ...options, exec }) });
    opts.refresh.mockImplementation(() => {
      expect(exec).toHaveBeenCalledOnce();
      const body = exec.mock.calls[0][1][4];
      expect(countStaleConflictFixRounds([trusted(body)], { currentRef: 'main', currentSha: sha }))
        .toEqual({ stale: 1, total: 1 });
      return { ok: true, action: 'rebased', newCommit: nextSha };
    });
    sweepMechanicalConflictRebases(opts);
    expect(exec).toHaveBeenCalledOnce();
    const body = exec.mock.calls[0][1][4];
    expect(body.startsWith(CONFLICT_FIX_COMMENT_MARKER + '\n')).toBe(true);
    expect(countConflictFixComments([trusted(body)])).toBe(1);
  });

  it.each(['discovery', 'fresh'])('shared per-target cap at %s refuses below the absolute ceiling', phase => {
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => trusted(
      buildConflictFixMarkComment({ baseRefName: 'main', baseSha: sha })));
    const opts = fixture({ readOpenPrs: () => [pr(1, { comments: phase === 'discovery' ? comments : [] })],
      readPr: () => pr(1, { comments }) });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([{ kind: 'conflict-rebase-ceiling' }]);
    expect(opts.refresh).not.toHaveBeenCalled(); expect(opts.postComment).not.toHaveBeenCalled();
    expect(opts.ledger.read()).toEqual({});
  });

  it.each(['old-sha', 'other-ref', 'legacy', 'ceiling'])(
    'shared accounting handles %s history against the current main tip', history => {
      const comments = Array.from({ length: history === 'ceiling' ? CONFLICT_FIX_ABSOLUTE_CEILING : CONFLICT_FIX_ROUND_CAP },
        () => trusted(history === 'legacy' ? CONFLICT_FIX_COMMENT_MARKER : buildConflictFixMarkComment({
          baseRefName: history === 'other-ref' ? 'lane/stack' : 'main', baseSha: nextSha,
        })));
      const opts = fixture({ readOpenPrs: () => [pr(1, { comments })] });
      const blocked = ['legacy', 'ceiling'].includes(history);
      expect(sweepMechanicalConflictRebases(opts).applied).toHaveLength(blocked ? 0 : 1);
      expect(opts.refresh).toHaveBeenCalledTimes(blocked ? 0 : 1);
    });

  it('failed marker post leaves no rebase or consumed attempt and can retry', () => {
    const opts = fixture({ readOpenPrs: () => [pr(1)],
      postComment: vi.fn().mockImplementationOnce(() => { throw Error('comment unavailable'); }) });
    expect(sweepMechanicalConflictRebases(opts)).toMatchObject({ applied: [], refusals: [
      { kind: 'conflict-rebase-comment-failed', why: expect.stringContaining('existing fix path') },
    ] });
    expect(opts.refresh).not.toHaveBeenCalled(); expect(opts.ledger.read()).toEqual({});
    expect(sweepMechanicalConflictRebases(opts).applied).toHaveLength(1);
    expect(opts.refresh).toHaveBeenCalledOnce();
  });

  it('failed rebases remain durably counted after losing the file ledger', () => {
    const comments = [];
    const opts = fixture({ readOpenPrs: () => [pr(1, { comments })],
      postComment: (n, options) => comments.push(trusted(buildConflictFixMarkComment(options))),
      refresh: vi.fn(() => ({ ok: false, action: 'error', error: 'code conflict' })),
    });
    for (let i = 0; i < CONFLICT_FIX_ROUND_CAP; i++) {
      sweepMechanicalConflictRebases({ ...opts, ledger: createConflictRebaseLedger({ env: { WE_UNDER_TEST: '1' } }) });
    }
    expect(sweepMechanicalConflictRebases({ ...opts,
      ledger: createConflictRebaseLedger({ env: { WE_UNDER_TEST: '1' } }),
    }).refusals).toMatchObject([{ kind: 'conflict-rebase-ceiling' }]);
    expect(opts.refresh).toHaveBeenCalledTimes(CONFLICT_FIX_ROUND_CAP);
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: sha }))
      .toEqual({ stale: CONFLICT_FIX_ROUND_CAP, total: CONFLICT_FIX_ROUND_CAP });
  });

  it.each(['head', 'base', 'same-repo', 'clean', 'labels', 'comments', 'stand-down', 'pause', 'load-flake', 'claim', 'read-failed'])(
    'fresh %s evidence refuses before ledger claim after local verification', change => {
      let verified = false;
      const opts = fixture({ readOpenPrs: () => [pr(1)], now: () => Date.parse('2026-11-18T12:01:00Z'),
        run: (_cmd, args) => { if (args[0] === 'rev-parse') verified = true; return { status: 0, stdout: sha }; },
        checkClaim: () => verified && change === 'claim' ? { message: 'held' } : null,
        readPr: () => {
          expect(verified).toBe(true);
          if (change === 'read-failed') throw Error('unreadable');
          const changes = { head: { headRefOid: nextSha }, base: { baseRefName: 'lane/stack' },
            'same-repo': { isCrossRepository: true }, clean: { mergeable: 'MERGEABLE' }, labels: { labels: null },
            comments: { comments: null }, 'stand-down': { comments: [stop] },
            pause: { comments: [trusted(buildConcurrentAuthorPauseComment({ head: pr(1).headRefOid }), { createdAt: '2026-11-18T12:00:00Z' })] },
            'load-flake': { comments: [trusted(buildLoadFlakeHoldComment({ head: pr(1).headRefOid, alt: 'lane/alt', altSha: nextSha }))] } };
          return pr(1, changes[change]);
        } });
      expect(sweepMechanicalConflictRebases(opts).refusals).toHaveLength(1);
      expect(opts.ledger.read()).toEqual({}); expect(opts.refresh).not.toHaveBeenCalled();
    });

  it('single PR reader requests fresh hold evidence and fails closed on read failure', () => {
    const exec = vi.fn(() => JSON.stringify(pr(1)));
    expect(defaultReadConflictRebasePr(1, { repo: 'o/r', exec })).toEqual(pr(1));
    expect(exec.mock.calls[0][1]).toEqual(['pr', 'view', '1', '--repo', 'o/r', '--json',
      'number,state,comments,headRefOid,headRefName,baseRefName,labels,mergeable,mergeStateStatus,isCrossRepository']);
    expect(defaultReadConflictRebasePr(1, { repo: 'o/r', exec: () => { throw Error('failed'); } })).toBeNull();
  });

  it.each([true, false])('unanswered stand-down refuses before ledger claim (apply=%s)', apply => {
    const opts = fixture({ apply, readOpenPrs: vi.fn(() => [pr(1, { comments: [stop] })]) });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([
      { kind: 'conflict-rebase-held', why: expect.stringContaining('operator answer') },
    ]);
    expect(opts.readOpenPrs.mock.calls[0][0].extraFields).toContain('comments');
    expect(opts.ledger.read()).toEqual({});
    expect(opts.run).not.toHaveBeenCalled();
    expect(opts.refresh).not.toHaveBeenCalled();
  });

  it('an explicit trusted operator answer releases the stand-down; a forged answer does not', () => {
    const body = buildOperatorAnswer({ standDownId: stop.id, reason: 'Proceed with the repair', actor: 'chalbert', channel: 'test' });
    for (const login of ['web-everything', 'outsider']) {
      const opts = fixture({ readOpenPrs: () => [pr(1, { comments: [stop, { body, author: { login } }] })] });
      const result = sweepMechanicalConflictRebases(opts);
      expect(result.applied).toHaveLength(login === 'outsider' ? 0 : 1);
      expect(Object.keys(opts.ledger.read())).toHaveLength(login === 'outsider' ? 0 : 1);
    }
  });

  it.each(['close-superseded', 'rearm-review', 'legacy-close', 'unknown'])(
    'operator %s disposition refuses before ledger claim in apply and preview', disposition => {
      let body = buildOperatorAnswer({ standDownId: stop.id, reason: disposition === 'legacy-close'
        ? 'Close this PR as superseded.' : 'Follow the ruling', actor: 'chalbert', channel: 'test',
        ...(['close-superseded', 'rearm-review'].includes(disposition) ? { disposition } : {}),
      });
      if (disposition === 'unknown') {
        body = body.replace(/(<!-- conveyor-stand-down-answer-record:)([^ ]+)( -->)/, (_, lead, encoded, tail) =>
          lead + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, 'base64').toString()), disposition: 'future-hold' })).toString('base64') + tail);
      }
      for (const apply of [true, false]) {
        const opts = fixture({ apply, readOpenPrs: () => [pr(1, { comments: [stop, trusted(body)] })] });
        expect(sweepMechanicalConflictRebases(opts)).toMatchObject({ applied: [], dispatch: [],
          refusals: [{ kind: 'conflict-rebase-held', why: expect.stringContaining(
            disposition === 'unknown' ? 'unanswered stand-down' : 'operator disposition') }] });
        expect(opts.ledger.read()).toEqual({});
        expect(opts.run).not.toHaveBeenCalled();
        expect(opts.refresh).not.toHaveBeenCalled();
      }
    });

  it.each(['live', 'resolved', 'new-head'])('load-flake alternate-branch hold uses shared state: %s', state => {
    const comments = [trusted(buildLoadFlakeHoldComment({ head: pr(1).headRefOid,
      alt: 'lane/test-alt', altSha: nextSha }), { createdAt: '2026-11-18T12:00:00Z' })];
    if (state === 'resolved') comments.push(trusted(buildLoadFlakeResolvedComment({ altSha: nextSha, result: 'pushed' }),
      { createdAt: '2026-11-18T12:01:00Z' }));
    for (const apply of [true, false]) {
      const opts = fixture({ apply, readOpenPrs: () => [pr(1, { comments,
        headRefOid: state === 'new-head' ? nextSha : pr(1).headRefOid })] });
      const result = sweepMechanicalConflictRebases(opts);
      if (state === 'live') {
        expect(result).toMatchObject({ applied: [], dispatch: [], refusals: [
          { kind: 'conflict-rebase-held', why: expect.stringContaining('alternate-branch verification') }] });
        expect(opts.ledger.read()).toEqual({});
        expect(opts.run).not.toHaveBeenCalled();
        expect(opts.refresh).not.toHaveBeenCalled();
      } else expect(apply ? result.applied : result.dispatch).toHaveLength(1);
    }
  });

  it.each([undefined, null, '', 'invalid'])('pause timestamp %s fails closed before ledger claim', createdAt => {
    for (const apply of [true, false]) {
      const opts = fixture({ apply, now: () => Date.parse('2026-11-18T12:21:00Z'),
        readOpenPrs: () => [pr(1, { comments: [trusted(buildConcurrentAuthorPauseComment({ head: pr(1).headRefOid }), { createdAt })] })] });
      expect(sweepMechanicalConflictRebases(opts)).toMatchObject({ applied: [], dispatch: [], refusals: [
        { kind: 'conflict-rebase-held', why: expect.stringContaining('operator must inspect') }] });
      expect(opts.ledger.read()).toEqual({});
      expect(opts.run).not.toHaveBeenCalled();
      expect(opts.refresh).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, null, {}, [null], [{}], [{ body: '' }], Array.from({ length: 100 }, () => ({ body: '', author: { login: 'outsider' } }))])(
    'unreadable or capped comments fail closed with full-thread operator fallback (%#)', comments => {
      const opts = fixture({ readOpenPrs: () => [pr(1, { comments })] });
      expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([
        { kind: 'conflict-rebase-held', why: expect.stringContaining('operator must inspect the full thread') },
      ]);
      expect(opts.ledger.read()).toEqual({});
      expect(opts.run).not.toHaveBeenCalled();
      expect(opts.refresh).not.toHaveBeenCalled();
    });

  it.each(['held', 'new-head', 'quiet'])('concurrent-author pause uses reconcile state: %s', state => {
    const head = pr(1).headRefOid;
    const comments = [trusted(buildConcurrentAuthorPauseComment({ head }), { createdAt: '2026-11-18T12:00:00Z' })];
    const opts = fixture({ now: () => Date.parse(state === 'quiet' ? '2026-11-18T12:21:00Z' : '2026-11-18T12:01:00Z'),
      readOpenPrs: () => [pr(1, { comments, headRefOid: state === 'new-head' ? nextSha : head })] });
    const result = sweepMechanicalConflictRebases(opts);
    expect(result.applied).toHaveLength(state === 'held' ? 0 : 1);
    if (state === 'held') {
      expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-held', why: expect.stringContaining('concurrent author') }]);
      expect(opts.ledger.read()).toEqual({});
      expect(opts.run).not.toHaveBeenCalled();
      expect(opts.refresh).not.toHaveBeenCalled();
    }
  });

  it.each(['malformed', 'unreadable', 'absent', 'valid'])('settings %s resolves closed on read/parse failures', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-settings-'));
    const legacyPath = join(dir, 'settings.json');
    try {
      if (mode === 'malformed') writeFileSync(legacyPath, '{');
      if (mode === 'valid') writeFileSync(legacyPath, '{}');
      const result = resolveConflictRebaseSettings({ env: {}, platform: {},
        readSettings: () => readSettingsChecked({ dir, legacyPath: mode === 'unreadable' ? dir : legacyPath }),
      });
      expect(result.value.conflictRebasePerPass).toBe(['absent', 'valid'].includes(mode) ? 3 : 0);
      if (['malformed', 'unreadable'].includes(mode)) {
        const closed = resolveConflictRebaseSettings({ env: { WE_CONFLICT_REBASE_PER_PASS: '3' }, platform: {},
          readSettings: () => readSettingsChecked({ dir, legacyPath: mode === 'unreadable' ? dir : legacyPath }),
        });
        expect(closed.value.conflictRebasePerPass).toBe(0);
        expect(closed.sources.conflictRebasePerPass).toBe('tool');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([null, undefined, -1, 101, 1.5, 'bad', {}, false])('invalid present tool cap %s disables even with an enabling environment', value => {
    const resolved = resolveConflictRebaseSettings({ env: { WE_CONFLICT_REBASE_PER_PASS: '3' }, platform: {},
      file: { fix: { conflictRebasePerPass: value } },
    });
    expect(resolved.value.conflictRebasePerPass).toBe(0);
    expect(resolved.sources.conflictRebasePerPass).toBe('tool');
  });

  it.each(['stale', 'unreadable', 'fetch-failed', 'throws'])('%s local main refuses before consuming a ledger attempt', mode => {
    const run = vi.fn((_cmd, args) => {
      if (mode === 'throws') throw Error('git unavailable');
      return { status: mode === 'fetch-failed' || mode === 'unreadable' && args[0] === 'rev-parse' ? 1 : 0, stdout: nextSha };
    });
    const opts = fixture({ run });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([{ kind: 'conflict-rebase-stale-main' }]);
    expect(opts.ledger.read()).toEqual({});
    expect(opts.refresh).not.toHaveBeenCalled();
    expect(opts.postComment).not.toHaveBeenCalled();
    expect(run.mock.calls[0]).toEqual(['git', ['fetch', 'origin', 'main'], { cwd: expect.any(String) }]);
  });

  it('fetches and verifies the configured default branch in the repo root before claiming', () => {
    const opts = fixture({ defaultBranch: 'trunk', readOpenPrs: () => [pr(1, { baseRefName: 'trunk' })] });
    opts.ledger.claim = vi.fn((evidenceKey, _at, recordAttempt, applyRefresh) => {
      expect(opts.run.mock.calls.map(call => call[1])).toEqual([['fetch', 'origin', 'trunk'], ['rev-parse', 'origin/trunk']]);
      expect(opts.run.mock.calls[0][2]).toEqual(opts.run.mock.calls[1][2]);
      evidenceKey();
      recordAttempt();
      applyRefresh();
      return true;
    });
    expect(sweepMechanicalConflictRebases(opts).applied).toHaveLength(1);
    expect(opts.ledger.claim).toHaveBeenCalledWith(expect.any(Function), 1000, expect.any(Function), expect.any(Function));
    expect(opts.refresh).toHaveBeenCalledWith('lane/test-1', expect.objectContaining({ base: 'origin/trunk' }));
  });

  it.each(['unknown-conflict', 'unreadable-count'])('default sweep refresh uses strict rebase for %s', mode => {
    const run = vi.fn((_cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: sha };
      if (args[0] === 'merge-tree') return { status: mode === 'unknown-conflict' ? 1 : 0, stdout: 'd'.repeat(40) + '\n' };
      if (args[0] === 'write-tree') return { status: 0, stdout: 'e'.repeat(40) };
      if (args[0] === 'diff') return { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    });
    const opts = fixture({ refresh: undefined, run, readOpenPrs: () => [pr(1)] });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([{ kind: 'conflict-rebase-not-mechanical' }]);
    expect(run.mock.calls.some(call => ['commit-tree', 'push'].includes(call[1][0]))).toBe(false);
    expect(opts.ledger.read()).toEqual({ [`1@${sha}@${pr(1).headRefOid}@0`]: 1000 });
  });

  it('includes drafts and review:human/accepted across all conflict signals; excludes non-main, closed, forks and unknown evidence', () => {
    const rows = [pr(1, { isDraft: true, labels: ['review:human'] }),
      pr(2, { labels: [{ name: 'review:accepted' }], mergeStateStatus: 'BLOCKED', mergeable: 'CONFLICTING' }),
      pr(3, { mergeStateStatus: 'UNKNOWN', labels: [{ name: 'merge-status:conflicting' }] }),
      pr(4, { baseRefName: 'lane/stack' }), pr(5, { state: 'CLOSED' }),
      pr(6, { isCrossRepository: true }), pr(7, { isCrossRepository: undefined }),
      pr(8, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })];
    expect(buildConflictRebaseCandidates(rows).map(p => p.number)).toEqual([1, 2, 3]);
    expect(buildConflictRebaseCandidates([pr(4, { baseRefName: 'trunk' })], { defaultBranch: 'trunk' })).toHaveLength(1);
  });

  it('dedupes stale evidence across passes and permits later attempts only after observing a new durable marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-rebase-'));
    const path = join(dir, 'ledger.json');
    try {
      const opts = fixture({ readOpenPrs: () => [pr(1)], ledger: createConflictRebaseLedger({ path }),
        refresh: vi.fn(() => {
          expect(createConflictRebaseLedger({ path }).read()[`1@${sha}@${pr(1).headRefOid}@0`]).toBe(1000);
          return { ok: true, action: 'current' };
        }) });
      sweepMechanicalConflictRebases(opts);
      expect(sweepMechanicalConflictRebases({ ...opts, ledger: createConflictRebaseLedger({ path }) }).applied).toEqual([]);
      expect(sweepMechanicalConflictRebases({ ...opts, readMainTip: () => ({ sha: nextSha }), run: () => ({ status: 0, stdout: nextSha }) }).applied).toHaveLength(1);
      const later = 1001;
      expect(sweepMechanicalConflictRebases({ ...opts, now: () => later }).applied).toEqual([]);
      const comments = [trusted(buildConflictFixMarkComment({ baseRefName: 'main', baseSha: sha }))];
      expect(sweepMechanicalConflictRebases({ ...opts, now: () => later,
        readOpenPrs: () => [pr(1, { comments })], readPr: () => pr(1, { comments }),
        refresh: () => ({ ok: true, action: 'current' }),
      }).applied).toHaveLength(1);
      expect(opts.ledger.read()[`1@${sha}@${pr(1).headRefOid}@1`]).toBe(later);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('legacy target-only claims fail closed with an operator repair fallback', () => {
    const ledger = createConflictRebaseLedger({ env: { WE_UNDER_TEST: '1' } });
    ledger.write({ [`1@${sha}`]: 999 });
    const opts = fixture({ readOpenPrs: () => [pr(1)], ledger });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([
      { kind: 'conflict-rebase-ledger-unreadable', why: expect.stringContaining('inspect/repair ledger') },
    ]);
    expect(opts.postComment).not.toHaveBeenCalled(); expect(opts.refresh).not.toHaveBeenCalled();
  });

  it('overlapping passes with different timestamps and stale cap-minus-one snapshots post only one marker and refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-concurrent-'));
    const path = join(dir, 'ledger.json');
    const release = new Int32Array(new SharedArrayBuffer(4));
    const workers = [];
    const timers = [];
    writeFileSync(path, '{}');
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const release = new Int32Array(workerData.release);
      const read = fs.readFileSync, open = fs.openSync;
      let held = false, contended = false;
      fs.readFileSync = function(file, ...args) {
        const result = read.call(this, file, ...args);
        if (workerData.first && file === workerData.path && !held) {
          held = true;
          parentPort.postMessage({ holding: true });
          if (Atomics.wait(release, 0, 0, 5000) === 'timed-out') throw Error('claim release timed out');
        }
        return result;
      };
      fs.openSync = function(file, ...args) {
        try { return open.call(this, file, ...args); }
        catch (error) {
          if (!workerData.first && file === workerData.path + '.lock' && error.code === 'EEXIST' && !contended) {
            contended = true;
            parentPort.postMessage({ contended: true });
          }
          throw error;
        }
      };
      require('node:module').syncBuiltinESMExports();
      (async () => {
        const { createConflictRebaseLedger, sweepMechanicalConflictRebases } = await import(workerData.module);
        const ledger = createConflictRebaseLedger({ path: workerData.path });
        const claims = [];
        let refreshes = 0, markers = 0;
        const result = sweepMechanicalConflictRebases({
          repo: 'web-everything/web-everything', apply: true, maxPerPass: 1, now: () => workerData.first ? 1000 : 1001,
          readOpenPrs: () => [workerData.pr], readPr: () => {
            if (!fs.existsSync(workerData.path + '.lock')) throw Error('fresh read outside exclusion');
            return workerData.pr;
          }, readMainTip: () => ({ sha: workerData.sha }),
          checkClaim: () => null, readIsCrossRepository: () => false,
          run: () => ({ status: 0, stdout: workerData.sha }),
          ledger: { claim: (...args) => { const won = ledger.claim(...args); claims.push(won); return won; } },
          refresh: () => {
            if (!fs.existsSync(workerData.path + '.lock')) throw Error('refresh outside exclusion');
            refreshes++; return { ok: true, action: 'current' };
          },
          reconcileAcceptance: () => { throw Error('current must not reconcile acceptance'); },
          postComment: () => { markers++; },
        });
        parentPort.postMessage({ done: true, claims, refreshes, markers, refusals: result.refusals });
      })().catch(error => { throw error; });
    `;
    const run = (first, onHolding = () => {}) => new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: { first, path, release: release.buffer,
        module: pathToFileURL(join(process.cwd(), 'scripts/conveyor/conflict-mechanical-rebase.mjs')).href, pr: pr(1, { comments: Array.from({ length: CONFLICT_FIX_ROUND_CAP - 1 },
          () => trusted(buildConflictFixMarkComment({ baseRefName: 'main', baseSha: sha }))) }), sha } });
      workers.push(worker);
      timers.push(setTimeout(() => reject(Error('concurrent ledger worker timed out')), 10000));
      let result;
      worker.on('message', message => {
        if (message.holding) onHolding();
        if (message.contended) { Atomics.store(release, 0, 1); Atomics.notify(release, 0); }
        if (message.done) result = message;
      });
      worker.on('error', reject);
      worker.on('exit', code => code === 0 && result ? resolve(result) : reject(Error(`claim worker exited ${code}`)));
    });
    try {
      let second;
      // First pauses after reading under the lock; second must encounter that live lock
      // before first can persist. Removing locking cannot pass as sequential execution.
      const first = await run(true, () => { second = run(false); });
      const results = [first, await second];
      expect(results.flatMap(result => result.claims).sort()).toEqual([false, true]);
      expect(results.reduce((sum, result) => sum + result.refreshes, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.markers, 0)).toBe(1);
      expect(results.flatMap(result => result.refusals)).toEqual([]);
      expect(createConflictRebaseLedger({ path }).read()).toEqual({ [`1@${sha}@${pr(1).headRefOid}@2`]: 1000 });
    } finally {
      timers.forEach(clearTimeout);
      await Promise.all(workers.map(worker => worker.terminate()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('caps work at two attempts and leaves the remaining PR for a later pass', () => {
    const opts = fixture({ maxPerPass: 2 });
    expect(sweepMechanicalConflictRebases(opts).applied.map(p => p.prNumber)).toEqual([1, 2]);
    expect(sweepMechanicalConflictRebases(opts).applied.map(p => p.prNumber)).toEqual([3]);
    expect(opts.reconcileAcceptance).toHaveBeenCalledTimes(3);
    expect(opts.refresh).toHaveBeenCalledWith('lane/test-1', expect.objectContaining({ prNumber: 1, readIsCrossRepository: opts.readIsCrossRepository }));
  });

  it.each(['skip', 'error'])('%s is a durable not-mechanical refusal, with no retry or acceptance mutation', action => {
    const opts = fixture({ readOpenPrs: () => [pr(1)], refresh: vi.fn(() => ({ ok: false, action, error: 'code conflict' })) });
    expect(sweepMechanicalConflictRebases(opts).refusals).toMatchObject([{ prNumber: 1, kind: 'conflict-rebase-not-mechanical' }]);
    expect(sweepMechanicalConflictRebases(opts).applied).toEqual([]);
    expect(opts.refresh).toHaveBeenCalledTimes(1);
    expect(opts.reconcileAcceptance).not.toHaveBeenCalled();
    expect(opts.postComment).toHaveBeenCalledTimes(1);
  });

  it('claim and unknown/fork same-repo guards refuse before recording an attempt', () => {
    for (const overrides of [{ checkClaim: () => ({ message: 'held' }) },
      { readIsCrossRepository: () => null }, { readIsCrossRepository: () => true }]) {
      const opts = fixture(overrides);
      expect(sweepMechanicalConflictRebases(opts).refusals).toHaveLength(3);
      expect(opts.refresh).not.toHaveBeenCalled();
      expect(opts.ledger.read()).toEqual({});
    }
  });

  it('fails closed on missing main SHA and unreadable/unwritable ledgers; existing fix remains the fallback', () => {
    for (const overrides of [{ readMainTip: () => null }, { ledger: { read: () => { throw Error('unreadable'); } } },
      { ledger: { read: () => ({}), write: () => { throw Error('unwritable'); } } },
      { ledger: { read: () => ({ invalid: 'stamp' }) } }]) {
      const opts = fixture(overrides);
      expect(sweepMechanicalConflictRebases(opts).refusals[0].why).toContain('existing fix path');
      expect(opts.refresh).not.toHaveBeenCalled();
    }
  });

  it('refuses corrupted persisted JSON instead of forgetting an attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-corrupt-'));
    try {
      const path = join(dir, 'ledger.json'); writeFileSync(path, '{');
      const opts = fixture({ ledger: createConflictRebaseLedger({ path }) });
      expect(sweepMechanicalConflictRebases(opts).refusals[0].kind).toBe('conflict-rebase-ledger-unreadable');
      expect(opts.refresh).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('disabled, oversized and dry-run bounds never refresh or record', () => {
    for (const overrides of [{ maxPerPass: 0 }, { maxPerPass: 101 }, { apply: false }]) {
      const opts = fixture(overrides); sweepMechanicalConflictRebases(opts);
      expect(opts.refresh).not.toHaveBeenCalled(); expect(opts.ledger.read()).toEqual({});
    }
  });

  it('resolves cap and provenance through all four layers, disabling invalid/oversized input', () => {
    const resolve = extra => resolveConflictRebaseSettings({ env: {}, file: {}, platform: {}, ...extra });
    expect(resolve().value.conflictRebasePerPass).toBe(3);
    expect(resolve({ platform: { conflictRebasePerPass: 2 } }).sources.conflictRebasePerPass).toBe('platform');
    expect(resolve({ file: { fix: { conflictRebasePerPass: 4 } } }).sources.conflictRebasePerPass).toBe('tool');
    for (const value of ['0', '999', 'typo', 'true']) {
      const result = resolve({ env: { WE_CONFLICT_REBASE_PER_PASS: value } });
      expect(result.value.conflictRebasePerPass).toBe(0);
      expect(result.sources.conflictRebasePerPass).toBe('env');
    }
  });
});

describe('daemon conflict rebase half', () => {
  const noActions = () => ({ dispatched: [], applied: [], refusals: [] });
  const daemon = extra => ({ repos: ['web-everything/web-everything'],
    ciHealTick: noActions, hungCiTick: noActions, mainRedRebaseTick: noActions, missingRunTick: noActions,
    promoteDraftTick: noActions, notesTick: () => ({ notes: [], prsByNumber: new Map() }),
    authGateOverride: () => ({ paused: false }), ...extra });

  it('rebases two PRs before fix while fix defers its second repo, outside its PR and time budgets', async () => {
    const opts = fixture({ readOpenPrs: () => [pr(1), pr(2)] });
    const order = [];
    let time = 0;
    const result = await runTickAllRepos(daemon({ repos: ['web-everything/web-everything', 'frontier-ui/frontierui'],
      now: () => ++time, budgetRotation: {}, prCursors: {},
      passBudgets: resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { fixMs: 1000 } } }),
      conflictRebaseTick: ({ repo }) => {
        order.push('rebase'); return repo === opts.repo ? sweepMechanicalConflictRebases(opts) : noActions();
      },
      fixTick: () => { order.push('fix'); time += 2000; return { dispatched: [], refusals: [] }; },
    }));
    expect(order).toEqual(['rebase', 'rebase', 'fix']);
    expect(result.conflictRebase.dispatched).toHaveLength(2);
    expect(result.budgets.fix.hit).toBe(true);
    expect(result.budgets.fix.skipped).toHaveLength(1);
    expect(result.dispatched).toHaveLength(2);
    expect(result.phaseMs['conflict-rebase']).toBeGreaterThan(0);
    const lines = [];
    buildCliDaemonEffects({ log: { error: line => lines.push(line) } }).onTick(result);
    expect(lines).toContain(`reconcile-fix-dispatch-daemon: conflict-rebase ${opts.repo} PR #1 (lane/test-1) — rebased`);
  });

  it('runs during auth pause and isolates repo failures into aggregate refusals', async () => {
    const tick = vi.fn(() => ({ applied: [{ prNumber: 1, ok: true, action: 'rebased' }], refusals: [] }));
    const fixTick = vi.fn(noActions);
    const result = await runTickAllRepos(daemon({ authGateOverride: () => ({ paused: true }), conflictRebaseTick: tick, fixTick }));
    expect(tick).toHaveBeenCalledOnce(); expect(fixTick).not.toHaveBeenCalled();
    expect(result.dispatched).toHaveLength(1);
    expect(runConflictRebaseAllRepos({ repos: ['one', 'two'], tick: ({ repo }) => {
      if (repo === 'one') throw Error('unreadable'); return noActions();
    } }).refusals).toMatchObject([{ repo: 'one', kind: 'tick-failed' }]);
  });

  it('invalidates the shared snapshot after a rebase before fix plans', async () => {
    const snapshot = pr(1, { body: '', isDraft: true, statusCheckRollup: [], comments: [], files: [] });
    const fixTick = vi.fn(options => {
      // No shared readPrs means fix uses its normal fresh discovery.
      expect(options.readPrs).toBeUndefined();
      return noActions();
    });
    await runTickAllRepos(daemon({ readPrs: () => [snapshot], fixSettings: { skipEmptySteps: true }, fixTick,
      conflictRebaseTick: options => {
        expect(options.readPrs()).toEqual([snapshot]);
        return { applied: [{ prNumber: 1, ok: true, action: 'rebased' }], refusals: [] };
      },
    }));
    expect(fixTick).toHaveBeenCalledOnce();
  });
});
