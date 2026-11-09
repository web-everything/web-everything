import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideRequiredContextRetrigger, createMergeGateRetriggerStore, createRetriggerIo, readHeadWorkflowRuns,
  retriggerRequiredContext } from '../merge-gate-retrigger.mjs';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);

describe('merge-gate retrigger safety', () => {
  const startupFailure = {
    name: 'Merge gate', event: 'pull_request_target', status: 'completed', conclusion: 'startup_failure',
    created_at: '2026-10-13T11:00:00Z', id: 101,
  };
  const eligible = {
    requiredContexts: ['merge-gate'], rollup: [], workflowRuns: [startupFailure], alreadyRetriggered: false,
  };

  it('skips an existing merge-gate context even when the workflow had a startup failure', () => {
    expect(decideRequiredContextRetrigger(eligible).action).toBe('retrigger');
    expect(decideRequiredContextRetrigger({ ...eligible, rollup: [
      { __typename: 'CheckRun', name: 'merge-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] }).action).toBe('skip');
  });

  it('skips a live merge-gate run even when a newer run had a startup failure', () => {
    expect(decideRequiredContextRetrigger(eligible).action).toBe('retrigger');
    for (const status of ['queued', 'in_progress']) {
      expect(decideRequiredContextRetrigger({ ...eligible, workflowRuns: [startupFailure,
        { ...startupFailure, id: 100, created_at: '2026-10-13T10:00:00Z', status, conclusion: null },
      ] }).action).toBe('skip');
    }
  });

  it('skips a latest completed non-startup-failure run regardless of response order', () => {
    expect(decideRequiredContextRetrigger(eligible).action).toBe('retrigger');
    for (const conclusion of ['success', 'failure', 'cancelled']) {
      const latest = { ...startupFailure, id: 102, created_at: '2026-10-13T12:00:00Z', conclusion };
      for (const workflowRuns of [[startupFailure, latest], [latest, startupFailure]]) {
        expect(decideRequiredContextRetrigger({ ...eligible, workflowRuns }).action).toBe('skip');
      }
    }
  });

  it('persists claims across store instances and refuses a corrupt ledger before IO', () => {
    const root = mkdtempSync(join(tmpdir(), 'merge-gate-retrigger-'));
    try {
      const path = join(root, 'state.json');
      const key = { repo, pr: 1, head, context: 'merge-gate' };
      expect(createMergeGateRetriggerStore({ path }).claim(key)).toBe(true);
      expect(createMergeGateRetriggerStore({ path }).claim(key)).toBe(false);
      expect(createMergeGateRetriggerStore({ path }).claim({ ...key, pr: 2 })).toBe(true);
      writeFileSync(path, '{broken');
      const io = { readHead: vi.fn(), addLabel: vi.fn() };
      expect(retriggerRequiredContext({ ...key, ledger: createMergeGateRetriggerStore({ path }), io }).ok).toBe(false);
      expect(io.readHead).not.toHaveBeenCalled();
      expect(io.addLabel).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('moved live head refuses label writes and retains the claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'merge-gate-retrigger-'));
    try {
      const path = join(root, 'state.json');
      const key = { repo, pr: 1, head, context: 'merge-gate' };
      const io = labelIo();
      io.readHead.mockReturnValue('b'.repeat(40));
      expect(retriggerRequiredContext({ ...key, io, ledger: createMergeGateRetriggerStore({ path }) }))
        .toEqual(expect.objectContaining({ ok: false, deferred: true,
          error: 'live head moved or is unreadable; operator inspection required' }));
      expect(createMergeGateRetriggerStore({ path }).claim(key)).toBe(false);
      expect(retriggerRequiredContext({ ...key, io, ledger: createMergeGateRetriggerStore({ path }) }))
        .toEqual(expect.objectContaining({ ok: false, deferred: true,
          error: 'retrigger already spent or claim unavailable' }));
      expect(io.readHead).toHaveBeenCalledTimes(1);
      expect(io.readLabels).not.toHaveBeenCalled();
      expect(io.addLabel).not.toHaveBeenCalled();
      expect(io.removeLabel).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('unreadable live head spends the claim without sending a label event', () => {
    const io = { readHead: () => { throw new Error('unreadable'); }, addLabel: vi.fn() };
    const claim = vi.fn(() => true);
    expect(retriggerRequiredContext({ repo, pr: 1, head, context: 'merge-gate', io, ledger: { claim } }).ok).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(io.addLabel).not.toHaveBeenCalled();
  });

  it('bounds workflow evidence to two pages and refuses incomplete, deferred or failed reads', () => {
    for (const reply of [{ total_count: 31, workflow_runs: Array(30).fill({}) }, {},
      { outcome: 'deferred-low-budget' }]) {
      const exec = vi.fn(() => JSON.stringify(reply));
      expect(readHeadWorkflowRuns({ repo, pr: 1, head, exec })).toBeNull();
      expect(exec).toHaveBeenCalledTimes(1);
    }
    const exec = vi.fn(() => JSON.stringify({ total_count: 0, workflow_runs: [] }));
    expect(readHeadWorkflowRuns({ repo, pr: 1, head, exec })).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toEqual(['api', `repos/${repo}/actions/runs?head_sha=${head}`]);
    expect(readHeadWorkflowRuns({ repo, pr: 1, head, exec: () => { throw new Error('unreadable'); } })).toBeNull();
  });

  it('a live target run on a distinct base SHA falls through without labeling the PR head', () => {
    const base = 'b'.repeat(40);
    const liveRun = { ...startupFailure, head_sha: base, status: 'in_progress', conclusion: null,
      pull_requests: [{ number: 1, head: { sha: head }, base: { sha: base } }] };
    const exec = vi.fn((_command, args) => JSON.stringify(args[1].includes('head_sha=')
      ? { total_count: 0, workflow_runs: [] } : { total_count: 1, workflow_runs: [liveRun] }));
    const labelRetrigger = vi.fn();
    const claim = vi.fn();
    const trigger = vi.fn(() => ({ ok: false, deferred: true, error: 'existing recovery deferred' }));
    const result = sweepMissingRunRecovery({ repo, apply: true, mainRuns: [],
      now: Date.parse('2026-10-13T12:00:00Z'),
      readOpenPrs: () => [{ number: 1, headRefName: 'lane/1', headRefOid: head, baseRefName: 'main',
        mergeable: 'MERGEABLE', statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ] }],
      readRequiredContexts: () => ['test'], readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readHeadCommittedAt: () => '2026-10-12T00:00:00Z', readPush: () => null, readComments: () => [],
      readWorkflowRuns: options => readHeadWorkflowRuns({ ...options, exec }),
      labelRetrigger, trigger, retriggerLedger: { claim },
    });
    expect(exec.mock.calls.map(call => call[1])).toEqual([
      ['api', `repos/${repo}/actions/runs?head_sha=${head}`],
      ['api', `repos/${repo}/actions/workflows/merge-gate.yml/runs?event=pull_request_target&per_page=100`],
    ]);
    expect(labelRetrigger).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([expect.objectContaining({ deferred: true, error: 'existing recovery deferred' })]);
  });

  it('refuses incomplete target-run history or missing PR associations instead of inferring absence', () => {
    for (const target of [
      { total_count: 101, workflow_runs: [] },
      { total_count: 1, workflow_runs: [{ ...startupFailure, pull_requests: [] }] },
    ]) {
      const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ total_count: 0, workflow_runs: [] }))
        .mockReturnValueOnce(JSON.stringify(target));
      expect(readHeadWorkflowRuns({ repo, pr: 1, head, exec })).toBeNull();
      expect(exec).toHaveBeenCalledTimes(2);
    }
  });

  it('production IO uses bounded argv-based live-head and label endpoints', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ head: { sha: head } }))
      .mockReturnValueOnce(JSON.stringify([{ name: 'other' }]))
      .mockReturnValueOnce(JSON.stringify([{ name: 'review:merge-gate-retrigger' }])).mockReturnValueOnce('');
    const io = createRetriggerIo({ repo, pr: 1, exec });
    expect(io.readHead()).toBe(head);
    expect(io.readLabels()).toEqual(['other']);
    expect(io.addLabel('review:merge-gate-retrigger')).toEqual({ ok: true });
    io.removeLabel('review:merge-gate-retrigger');
    expect(exec.mock.calls.map(call => call[1])).toEqual([
      ['api', `repos/${repo}/pulls/1`],
      ['api', `repos/${repo}/issues/1/labels?per_page=100`],
      ['api', '-X', 'POST', `repos/${repo}/issues/1/labels`, '-f', 'labels[]=review:merge-gate-retrigger'],
      ['api', '-X', 'DELETE', `repos/${repo}/issues/1/labels/review%3Amerge-gate-retrigger`],
    ]);
    for (const call of exec.mock.calls) expect(call[2]).toEqual(expect.objectContaining({ timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }));
  });

  function sweepWithRuns(readWorkflowRuns, count = 1, overrides = {}) {
    const labelRetrigger = overrides.labelRetrigger ?? vi.fn(() => ({ ok: true }));
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
    const postComment = vi.fn();
    const clearLabel = vi.fn(() => true);
    const prs = Array.from({ length: count }, (_, i) => ({ number: i + 1, headRefName: `lane/${i}`,
      headRefOid: head, baseRefName: 'main', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const result = sweepMissingRunRecovery({ repo, apply: true, mainRuns: [],
      now: Date.parse('2026-10-13T12:00:00Z'), readOpenPrs: () => prs,
      readRequiredContexts: () => ['test'], readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readHeadCommittedAt: () => '2026-10-12T00:00:00Z', readPush: () => null, readComments: () => [],
      ...(readWorkflowRuns ? { readWorkflowRuns } : {}), labelRetrigger, trigger, postComment, clearLabel,
      retriggerLedger: { claim: vi.fn() }, ...overrides,
    });
    return { result, labelRetrigger, trigger, postComment, clearLabel };
  }

  it('labels only a missing context with an eligible startup failure', () => {
    const { result, labelRetrigger, trigger, postComment } = sweepWithRuns(() => [startupFailure]);
    expect(labelRetrigger).toHaveBeenCalledWith(expect.objectContaining({ repo, pr: 1, head, context: 'merge-gate' }));
    expect(trigger).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(1, expect.objectContaining({ headSha: head, action: 'label-event', ok: true }));
    expect(result.applied).toEqual([expect.objectContaining({ ok: true, action: 'label-retrigger' })]);
  });

  it('two sweeps resume existing recovery after a failed label attempt spends the unchanged head claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'merge-gate-retrigger-'));
    try {
      const path = join(root, 'state.json');
      const io = labelIo();
      io.readLabels.mockImplementation(() => { throw new Error('transient label-read failure'); });
      const labelRetrigger = vi.fn(options => retriggerRequiredContext({ ...options, io }));
      const first = sweepWithRuns(() => [startupFailure], 1, {
        labelRetrigger, retriggerLedger: createMergeGateRetriggerStore({ path }),
      });
      const second = sweepWithRuns(() => [startupFailure], 1, {
        labelRetrigger, retriggerLedger: createMergeGateRetriggerStore({ path }),
      });
      expect(labelRetrigger).toHaveBeenCalledTimes(2);
      expect(labelRetrigger.mock.results.map(row => row.value)).toEqual([
        expect.objectContaining({ ok: false, error: 'transient label-read failure' }),
        expect.objectContaining({ ok: false, deferred: true, error: 'retrigger already spent or claim unavailable' }),
      ]);
      expect(labelRetrigger.mock.calls.map(([options]) => options.head)).toEqual([head, head]);
      expect(io.readLabels).toHaveBeenCalledTimes(1);
      expect(io.addLabel).not.toHaveBeenCalled();
      expect(io.removeLabel).not.toHaveBeenCalled();
      for (const sweep of [first, second]) {
        expect(sweep.trigger).toHaveBeenCalledTimes(1);
        expect(sweep.postComment).toHaveBeenCalledTimes(2);
        expect(sweep.postComment).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({ headSha: head, action: 'label-event', ok: false }));
        expect(sweep.clearLabel).toHaveBeenCalledTimes(1);
        expect(sweep.result.applied).toEqual([
          expect.objectContaining({ prNumber: 1, ok: true, action: 'pull-request-push' }),
        ]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['failure', 'deferred', 'throw', 'unconfirmed'])('%s label result falls through to existing recovery', kind => {
    const labelRetrigger = vi.fn(() => {
      if (kind === 'throw') throw new Error('label attempt failed');
      if (kind === 'unconfirmed') return undefined;
      return { ok: false, deferred: kind === 'deferred', error: 'no label event submitted' };
    });
    const { result, trigger, postComment } = sweepWithRuns(() => [startupFailure], 1, { labelRetrigger });
    expect(labelRetrigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({ headSha: head, action: 'label-event', ok: false }));
    expect(postComment).toHaveBeenNthCalledWith(2, 1, expect.objectContaining({ action: 'pull-request-push', ok: true }));
    expect(result.applied).toEqual([expect.objectContaining({ ok: true, action: 'pull-request-push' })]);
  });

  it('submitted label event with failed cleanup completes recovery without an empty commit', () => {
    const io = labelIo();
    io.removeLabel.mockImplementation(() => { throw new Error('cleanup failed'); });
    const labelRetrigger = vi.fn(options => retriggerRequiredContext({ ...options, io }));
    const { result, trigger, postComment } = sweepWithRuns(() => [startupFailure], 1, {
      labelRetrigger, retriggerLedger: { claim: () => true },
    });
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(1, expect.objectContaining({ headSha: head, action: 'label-event', ok: true }));
    expect(result.applied).toEqual([expect.objectContaining({
      ok: true, action: 'label-retrigger', warning: expect.stringContaining('operator must remove'),
    })]);
  });

  it.each([
    ['no runs', () => []],
    ['unreadable evidence', () => null],
    ['failed read', () => { throw new Error('unreadable'); }],
    ['malformed evidence', () => [{}]],
    ['unrelated startup failure', () => [{ ...startupFailure, name: 'CI' }]],
    ['latest successful run', () => [startupFailure, { ...startupFailure, id: 102,
      created_at: '2026-10-13T12:00:00Z', conclusion: 'success' }]],
    ['live run beside startup failure', () => [startupFailure, { ...startupFailure, id: 102,
      status: 'in_progress', conclusion: null }]],
  ])('%s preserves the existing empty-commit recovery and bookkeeping', (_name, readWorkflowRuns) => {
    const { result, labelRetrigger, trigger, postComment, clearLabel } = sweepWithRuns(readWorkflowRuns);
    expect(labelRetrigger).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(clearLabel).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([expect.objectContaining({ ok: true, action: 'pull-request-push', labelCleared: true })]);
  });

  it('incomplete head SHA refuses workflow reads before invoking GitHub', () => {
    const exec = vi.fn();
    expect(readHeadWorkflowRuns({ repo, pr: 1, head: '9cb7cc0', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('default workflow reader without gh falls through to existing recovery', () => {
    vi.stubEnv('PATH', '');
    try {
      expect(readHeadWorkflowRuns({ repo, pr: 1, head })).toBeNull();
      const { labelRetrigger, trigger } = sweepWithRuns();
      expect(labelRetrigger).not.toHaveBeenCalled();
      expect(trigger).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it('bounds sweep evidence reads and falls through to existing recovery beyond the cap', () => {
    const readWorkflowRuns = vi.fn(() => [startupFailure]);
    const { result, labelRetrigger, trigger, postComment } = sweepWithRuns(readWorkflowRuns, 9);
    expect(readWorkflowRuns).toHaveBeenCalledTimes(8);
    expect(labelRetrigger).toHaveBeenCalledTimes(8);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(9);
    expect(result.applied.at(-1)).toEqual(expect.objectContaining({ prNumber: 9, action: 'pull-request-push' }));
  });

  function labelIo(labels = []) {
    return { readHead: vi.fn(() => head), readLabels: vi.fn(() => labels),
      addLabel: vi.fn(() => ({ ok: true })), removeLabel: vi.fn(() => ({ ok: true })) };
  }
  function retrigger(io) {
    return retriggerRequiredContext({ repo, pr: 1, head, context: 'merge-gate', io, ledger: { claim: () => true } });
  }

  it('stale sentinel label is removed before the fresh label transition', () => {
    const io = labelIo(['other', 'review:merge-gate-retrigger']);
    expect(retrigger(io)).toEqual({ ok: true, action: 'label-retrigger' });
    expect(io.removeLabel.mock.calls).toEqual([['review:merge-gate-retrigger'], ['review:merge-gate-retrigger']]);
    const order = [io.readHead.mock.invocationCallOrder[0], io.readLabels.mock.invocationCallOrder[0],
      io.removeLabel.mock.invocationCallOrder[0], io.addLabel.mock.invocationCallOrder[0],
      io.removeLabel.mock.invocationCallOrder[1]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each(['throw', 'unconfirmed'])('failed stale sentinel pre-removal (%s) refuses label addition', kind => {
    const io = labelIo(['review:merge-gate-retrigger']);
    io.removeLabel.mockImplementation(() => {
      if (kind === 'throw') throw new Error('removal rejected');
      return { ok: false };
    });
    expect(retrigger(io).ok).toBe(false);
    expect(io.removeLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel).not.toHaveBeenCalled();
  });

  it.each([null, {}, [null], [42]])('unreadable labels %j block label addition', labels => {
    const io = labelIo(labels);
    expect(retrigger(io)).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('operator inspection required') }));
    expect(io.addLabel).not.toHaveBeenCalled();
    expect(io.removeLabel).not.toHaveBeenCalled();
  });

  it('failed or missing label reader blocks label addition', () => {
    for (const readLabels of [undefined, () => { throw new Error('label read rejected'); }]) {
      const io = { ...labelIo(), readLabels };
      expect(retrigger(io).ok).toBe(false);
      expect(io.addLabel).not.toHaveBeenCalled();
    }
  });

  it('fresh sentinel addition follows label read and cleanup failure remains visible', () => {
    const io = labelIo();
    io.removeLabel.mockImplementation(() => { throw new Error('cleanup rejected'); });
    expect(retrigger(io)).toEqual(expect.objectContaining({ ok: true, warning: expect.stringContaining('operator must remove') }));
    expect(io.readLabels.mock.invocationCallOrder[0]).toBeLessThan(io.addLabel.mock.invocationCallOrder[0]);
    expect(io.addLabel.mock.invocationCallOrder[0]).toBeLessThan(io.removeLabel.mock.invocationCallOrder[0]);
  });

  it('oversized or incomplete production label reads require operator inspection before writes', () => {
    for (const labels of [Array.from({ length: 100 }, () => ({ name: 'other' })), {}, [{}]]) {
      const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ head: { sha: head } }))
        .mockReturnValueOnce(JSON.stringify(labels));
      expect(retrigger(createRetriggerIo({ repo, pr: 1, exec }))).toEqual(expect.objectContaining({
        ok: false, error: expect.stringContaining('operator inspection required'),
      }));
      expect(exec).toHaveBeenCalledTimes(2);
    }
  });
});
