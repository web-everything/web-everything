import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertLaunchable, demoteConflictRebase, dispatchFix, resumeBgSession, runReconcileFixDispatch, tryResumeFix } from '../reconcile-fix-dispatch.mjs';
import { runRearmReviewCli } from '../rearm-review.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40);
const planned = { pr: 1764, itemNum: '3438', lane: 9, laneRef: 'lane/3438-fixture', scope: ['we:scripts/x.mjs'],
  headRefOid: head, isConflict: true, mode: 'conflict-rebase', labels: ['review:accepted'],
  conflictRebase: { defaultBranch: 'main', oldHead: head, mainSha: target, receipt: `accepted-conflict-rebase:${head}@${target}` } };
const proof = () => ({ ok: true, pr: planned.pr, round: 'conflict-start', labels: ['review:pending'] });
const liveState = (labels = ['review:accepted']) => ({ headRefOid: head, labels, state: 'OPEN', isDraft: false,
  baseRefName: 'main', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' });
const template = '{{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}';
function deps(events, demote = () => { events.push('demote'); return proof(); }) {
  let live = liveState();
  return { root: '/repo', readLive: () => live, demote: (...args) => {
    const result = demote(...args);
    if (result?.ok) live = liveState(result.labels);
    return result;
  }, wrapFix: false, executorDecision: { executor: 'claude' },
    readFixClaim: () => null, acquireClaim: () => { events.push('claim'); return { ok: true }; },
    releaseClaim: vi.fn(() => events.push('release')), readBrief: () => template,
    mintSessionId: () => 'session', sessionCwdFor: () => '/scratch/session', ensureSessionCwd: x => x,
    grantConflictHelper: () => ({ ok: true }), isolateSession: () => ({}), resolveSettingsEnv: () => ({}),
    postNotice: () => {}, advisorFor: () => null, readHistoryInputs: () => null,
    spawnAgent: vi.fn(() => { events.push('launch'); return ''; }) };
}
function pass(options) {
  return runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
    reconcile: () => ({ dispatch: [{ ...planned, kind: 'fix', prNumber: planned.pr, headRefName: planned.laneRef }], refusals: [] }),
    findItemFn: () => ({ num: '3438', slug: 'fixture', scope: planned.scope }), loadItems: () => [],
    fetchItemlessDiffPaths: () => ['scripts/x.mjs'], pickFreeLanes: () => [9],
    listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null, tryResumeRound: null,
    ...options });
}

describe('conflict-rebase dispatch demotion', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])('runs conflict-start pinned to dispatched head for %s', label => {
    const exec = vi.fn(() => JSON.stringify(proof()));
    expect(demoteConflictRebase({ ...planned, labels: [label] }, { root: '/repo', exec })).toEqual(proof());
    expect(exec.mock.calls[0][1]).toEqual(['/repo/scripts/conveyor/rearm-review.mjs', '1764',
      '--repo=web-everything/web-everything', '--round=conflict-start',
      `--only-if=${label === 'review:accepted' ? 'accepted' : 'missing'}`, `--expect-head=${head}`,
      `--actor=accepted-conflict-rebase:${head}@${target}`]);
    expect(exec.mock.calls[0][2].maxBuffer).toBe(1024 * 1024);
  });
  it('rejects mismatched head evidence before calling the CLI', () => {
    const exec = vi.fn();
    expect(() => demoteConflictRebase({ ...planned, headRefOid: target }, { exec })).toThrow('mismatched');
    expect(exec).not.toHaveBeenCalled();
  });
  it('launches only after claimed demotion succeeds', () => {
    const events = [], options = deps(events);
    const result = pass({ tryResume: () => ({ resumed: false }), demote: options.demote,
      dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    expect(result.refusals).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    expect(events).toEqual(['claim', 'demote', 'launch']);
  });
  it.each(['accepted', 'missing'])('hold arriving after planning at a fresh %s read refuses before demotion and launch', guard => {
    const events = [], output = [];
    let reads = 0;
    const setLabels = vi.fn(), postComment = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    const demote = () => runRearmReviewCli({
      argv: [String(planned.pr), '--repo=o/n', '--round=conflict-start', `--only-if=${guard}`,
        `--expect-head=${head}`, `--actor=${planned.conflictRebase.receipt}`],
      labelCliOptions: { provider: {
        readPrState: () => ({ state: 'OPEN', isDraft: false, headRefOid: head, comments: [],
          labels: [...(guard === 'accepted' ? ['review:accepted'] : ['ready-to-merge']),
            ...(++reads > 1 ? ['review:held-mechanical'] : [])] }),
        setLabels, postComment,
      }, emit: line => output.push(JSON.parse(line)) },
    });
    const options = deps(events, demote);
    try {
      const result = pass({ tryResume: () => ({ resumed: false }), demote: options.demote,
        dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
      expect(reads).toBeGreaterThan(1);
      expect(output).toEqual([expect.objectContaining({ error: expect.stringContaining('STOP repair') })]);
      expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed' }]);
      expect(result.dispatched).toEqual([]);
      expect(setLabels).not.toHaveBeenCalled();
      expect(postComment).not.toHaveBeenCalled();
      expect(options.spawnAgent).not.toHaveBeenCalled();
      expect(options.releaseClaim).toHaveBeenCalledOnce();
    } finally { exit.mockRestore(); }
  });

  it('hold arriving during demotion refuses verification and dispatcher launch', () => {
    const events = [], output = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    const demote = () => runRearmReviewCli({
      argv: [String(planned.pr), '--repo=o/n', '--round=conflict-start', '--only-if=accepted',
        `--expect-head=${head}`, `--actor=${planned.conflictRebase.receipt}`],
      readLabels: () => ['review:pending', 'review:held-mechanical'],
      labelCliOptions: { provider: {
        readPrState: () => ({ state: 'OPEN', headRefOid: head, comments: [], labels: planned.labels }),
        readLabels: () => ['review:pending'], setLabels: () => events.push('demote'), postComment: () => {},
      }, emit: line => output.push(JSON.parse(line)) },
    });
    const options = deps(events, demote);
    try {
      const result = pass({ tryResume: () => ({ resumed: false }), demote: options.demote,
        dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
      expect(events).toEqual(['claim', 'demote', 'release']);
      expect(output).toEqual([expect.objectContaining({ ok: false, reason: expect.stringContaining('STOP repair') })]);
      expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed' }]);
      expect(options.spawnAgent).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });

  it.each([
    ['failed', () => { throw new Error('write failed'); }, 'write failed'],
    ['refused', () => ({ ok: false, reason: 'head moved' }), 'head moved'],
    ['unconfirmed', () => ({ ...proof(), labels: ['review:accepted', 'review:pending'] }), 'could not be confirmed'],
    ['missing pending', () => ({ ...proof(), labels: [] }), 'could not be confirmed'],
    ['unreadable', () => undefined, 'could not be confirmed'],
    ['wrong PR', () => ({ ...proof(), pr: 99 }), 'could not be confirmed'],
    ['malformed labels', () => ({ ...proof(), labels: [null, 'review:pending'] }), 'could not be confirmed'],
    ['oversized CLI output', entry => demoteConflictRebase(entry, { exec: () => { throw new Error('stdout maxBuffer length exceeded'); } }), 'maxBuffer'],
    ['unreadable CLI output', entry => demoteConflictRebase(entry, { exec: () => 'unreadable' }), 'JSON'],
  ])('%s demotion releases claim and records refusal without launching', (_name, demote, why) => {
    const events = [], options = deps(events, demote);
    const result = pass({ tryResume: () => ({ resumed: false }), demote: options.demote,
      dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed', why: expect.stringContaining(why) }]);
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'ordinary', 'stale-base'])('leaves mode %s unaffected', mode => {
    const events = [], demote = vi.fn(), options = deps(events, demote);
    dispatchFix({ ...planned, mode }, options);
    expect(demote).not.toHaveBeenCalled();
    expect(options.spawnAgent).toHaveBeenCalledOnce();
  });
  it.each(['resumed', 'fallback', 'failed'])('demotes before resume with one receipt (outcome=%s)', outcome => {
    const success = outcome !== 'failed';
    const events = [], candidate = 'cand-0000-0000-0000-000000000000';
    const demote = () => { events.push('demote'); if (!success) throw new Error('write refused'); return proof(); };
    const options = deps(events, demote);
    const resume = (entry, io) => tryResumeFix({ ...entry, body: buildAuthorActorMarker(candidate) }, {
      ...options, demote: io.demote, readCompletion: () => null, resolveHead: () => head,
      listAgentsAll: () => [{ sessionId: candidate, id: 'candxxxx', name: 'fix-1764', cwd: '/lanes/lane-4', state: 'running', kind: 'background' }],
      spawnAgent: () => { events.push('resume'); return `backgrounded · ${outcome === 'fallback' ? 'forkedid' : 'candxxxx'}`; }, wait: () => {}, stop: () => {},
    });
    const result = pass({ tryResume: resume, demote: options.demote, dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    if (success) {
      expect(events.indexOf('demote')).toBeLessThan(events.indexOf('resume'));
      expect(events.filter(e => e === 'demote')).toHaveLength(1);
      expect(result.dispatched).toHaveLength(1);
      if (outcome === 'resumed') {
        expect(result.dispatched[0].resumed).toBe(true);
        expect(events).toEqual(['claim', 'demote', 'resume', 'release']);
      } else {
        expect(events).toEqual(['claim', 'demote', 'resume', 'release', 'claim', 'launch']);
      }
    } else {
      expect(events).toEqual(['claim', 'demote', 'release']);
      expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed' }]);
      expect(result.dispatched).toEqual([]);
    }
  });
});


describe('single fresh conflict-rebase launch gate', () => {
  it('enumerates every fixer launch and requires an adjacent gate, including new paths', () => {
    const source = readFileSync('scripts/conveyor/reconcile-fix-dispatch.mjs', 'utf8');
    const ast = ts.createSourceFile('dispatch.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const sites = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && ['spawnAgent', 'spawnBorrowed', 'launchWrapped'].includes(node.expression.text)) {
        sites.push(`${node.expression.text}:${node.arguments[0]?.getText(ast).split(/[\s{]/)[0] || 'request'}`);
        const preceding = source.slice(0, node.getStart(ast)).split('\n').slice(-4).join('\n');
        expect(preceding, `unguarded launch at ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`)
          .toMatch(/assertLaunchable\(planned, \{ repo, root, demote, readLive \}\)/);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(sites).toEqual(['spawnAgent:resumeArgv', 'spawnBorrowed:request', 'launchWrapped:request', 'spawnAgent:argv']);
  });

  it.each([
    ['missing demotion: no-op', () => undefined, 'conflict-rebase-demotion-failed'],
    ['missing demotion: failed', () => { throw new Error('write failed'); }, 'conflict-rebase-demotion-failed'],
    ['demotion only in the brief/result', proof, 'conflict-rebase-launch-refused'],
  ])('%s refuses without launching', (_name, demote, kind) => {
    const events = [], options = deps(events);
    expect(() => dispatchFix(planned, { ...options, demote, readLive: () => liveState() })).toThrow();
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
    try { assertLaunchable(planned, { demote, readLive: () => liveState() }); }
    catch (error) { expect(error.kind).toBe(kind); }
  });

  it.each([
    ['hold after planning', () => liveState(['review:accepted', 'review:held-mechanical'])],
    ['changes after planning', () => liveState(['review:accepted', 'review:changes'])],
    ['head moved after planning', () => ({ ...liveState(), headRefOid: target })],
    ['unreadable evidence', () => { throw new Error('read failed'); }],
    ['incomplete evidence', () => ({ labels: ['review:pending'] })],
    ['closed PR', () => ({ ...liveState(), state: 'CLOSED' })],
    ['draft PR', () => ({ ...liveState(), isDraft: true })],
    ['wrong base', () => ({ ...liveState(), baseRefName: 'other' })],
    ['conflict resolved', () => ({ ...liveState(), mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })],
    ['missing state', () => ({ ...liveState(), state: undefined })],
    ['missing draft status', () => ({ ...liveState(), isDraft: undefined })],
    ['malformed labels', () => liveState([null])],
  ])('%s refuses and releases the claim', (_name, readLive) => {
    const events = [], options = deps(events);
    expect(() => dispatchFix(planned, { ...options, readLive })).toThrow(expect.objectContaining({ kind: 'conflict-rebase-launch-refused' }));
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
    expect(events).toEqual(['claim', 'release']);
  });

  it.each(['hold', 'head'])('failed resume fallback re-reads live and refuses a new %s', change => {
    const events = [], options = deps(events);
    let live = liveState(), reads = 0;
    const readLive = () => { reads++; return live; };
    const demote = vi.fn(() => { live = liveState(['review:pending']); return proof(); });
    const resumedSpawn = vi.fn(() => {
      live = change === 'hold' ? liveState(['review:pending', 'review:changes']) : { ...live, headRefOid: target };
      return '';
    });
    const result = pass({ demote, readLive,
      tryResume: (entry, io) => resumeBgSession(entry, { ...options, ...io, candidate: 'candidate', prompt: 'repair',
        spawnAgent: resumedSpawn, listAgentsAll: () => [], wait: () => {}, stop: () => {} }),
      dispatch: (entry, io) => dispatchFix(entry, { ...options, ...io }),
    });
    expect(resumedSpawn).toHaveBeenCalledOnce();
    expect(reads).toBe(3); // resume before/after demotion, then a new read at fallback launch
    expect(demote).toHaveBeenCalledOnce();
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledTimes(2);
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-launch-refused' }]);
  });

  it.each(['hold', 'head', 'approval', 'missing pending', 'read failure'])(
    'post-demotion fresh verification refuses %s', change => {
      const options = deps([]);
      let reads = 0;
      const readLive = () => {
        if (++reads === 1) return liveState();
        if (change === 'read failure') throw new Error('verification unreadable');
        return change === 'head' ? { ...liveState(['review:pending']), headRefOid: target }
          : liveState(change === 'hold' ? ['review:pending', 'review:held-mechanical']
            : change === 'approval' ? ['review:pending', 'review:accepted'] : []);
      };
      expect(() => dispatchFix(planned, { ...options, demote: proof, readLive }))
        .toThrow(expect.objectContaining({ kind: 'conflict-rebase-launch-refused' }));
      expect(reads).toBe(2);
      expect(options.spawnAgent).not.toHaveBeenCalled();
      expect(options.releaseClaim).toHaveBeenCalledOnce();
    });

  it.each(['wrapped', 'borrowed'])('%s launch refuses a hold arriving during preparation', route => {
    const options = deps([]), spawnBorrowed = vi.fn(), launchWrapped = vi.fn();
    let live = liveState(['review:pending']);
    const introduceHold = () => { live = liveState(['review:pending', 'review:changes']); };
    expect(() => dispatchFix(planned, { ...options, readLive: () => live,
      wrapFix: route === 'wrapped', launchWrapped, spawnBorrowed, stampExecutor: () => {},
      executorDecision: { executor: route === 'borrowed' ? 'codex' : 'claude' },
      writeBorrowedPrompt: () => { introduceHold(); return '/nonexistent-fixture-prompt'; },
      resolveSettingsEnv: () => { introduceHold(); return {}; },
    })).toThrow(expect.objectContaining({ kind: 'conflict-rebase-launch-refused' }));
    expect(spawnBorrowed).not.toHaveBeenCalled();
    expect(launchWrapped).not.toHaveBeenCalled();
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
  });

  it('already pending re-reads without a second receipt and launches once', () => {
    const events = [], options = deps(events), demote = vi.fn();
    const readLive = vi.fn(() => liveState(['review:pending']));
    dispatchFix(planned, { ...options, demote, readLive });
    expect(readLive).toHaveBeenCalledTimes(2);
    expect(readLive).toHaveBeenCalledWith(planned.pr, 'we');
    expect(demote).not.toHaveBeenCalled();
    expect(options.spawnAgent).toHaveBeenCalledOnce();
  });

  it('resume gate runs after settings preparation and releases its claim on refusal', () => {
    const options = deps([]), spawnAgent = vi.fn();
    let live = liveState(['review:pending']);
    expect(() => resumeBgSession(planned, { ...options, candidate: 'candidate', prompt: 'repair', spawnAgent,
      prepareResume: () => { live = liveState(['review:pending', 'review:changes']); },
      readLive: () => live,
    })).toThrow(expect.objectContaining({ kind: 'conflict-rebase-launch-refused' }));
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
  });
});
