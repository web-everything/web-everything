import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshMqFailureHead } from '../mq-failure-refresh.mjs';
import { createMqSameHeadRefreshStore, createMqSameHeadRefreshOptions, decideMqSameHead } from '../drain-queue-safety.mjs';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
const id = { repo: 'web-everything/web-everything', pr: 42, head: 'a'.repeat(40) };
const dirs = []; afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'mq-gates-')); dirs.push(dir);
  const store = createMqSameHeadRefreshStore({ path: join(dir, 'refresh.json') });
  return { ...id, store, allow: () => true,
    ledger: { claim: vi.fn(() => ({ claimed: true })), recordRefresh: vi.fn(), recordFixFallback: vi.fn() },
    io: { readHead: vi.fn(() => id.head), readLabels: vi.fn(() => ({ headRefOid: id.head, labels: ['ready-to-merge'] })),
      createCheckout: vi.fn(() => ({ cwd: 'fixture', branch: 'topic' })), removeCheckout: vi.fn(),
      git: vi.fn(({ args }) => args[0] === 'merge' ? { ok: true, head: 'b'.repeat(40) } : { ok: true }) } };
}
const pushes = o => o.io.git.mock.calls.filter(([c]) => c.args[0] === 'push');
describe('MQ recovery refresh gates', () => {
  it.each(['approval', 'enqueue', 'unreadable', 'missing'])('1 refuses %s authorization before merge or claim', async mode => {
    const o = fixture(), auth = createMqSameHeadRefreshOptions({ ...id, store: o.store,
      approvedHeadHold: () => mode === 'approval', enqueueAllowed: () => {
        if (mode === 'unreadable') throw Error('unknown'); return mode !== 'enqueue';
      } });
    const result = await refreshMqFailureHead({ ...o, allow: mode === 'missing' ? undefined : auth.allow });
    expect(result.action).toBe('stop'); expect(o.io.createCheckout).not.toHaveBeenCalled();
    expect(o.store.has(`${id.repo}#42@${id.head}`)).toBe(false);
  });
  it.each(['review:human', 'human-only', 'red-team:blocked', 'red-team:pending', 'unreadable', 'oversized'])('2 refuses a live %s label immediately before push', async label => {
    const o = fixture();
    o.io.git.mockImplementation(({ args }) => {
      if (args[0] === 'merge') {
        o.io.readLabels.mockImplementation(() => {
          if (label === 'unreadable') throw Error('unknown');
          return { headRefOid: id.head, labels: label === 'oversized' ? Array(101).fill('ready-to-merge') : ['ready-to-merge', label] };
        }); return { ok: true, head: 'b'.repeat(40) };
      } return { ok: true };
    });
    expect((await refreshMqFailureHead(o)).action).toBe('stop'); expect(pushes(o)).toHaveLength(0);
  });
  it.each(['queue', 'scope', 'stack', 'claim', 'fixer', 'fixer race'])('3 never refreshes before %s admission', mode => {
    const refresh = vi.fn(() => ({ action: 'refreshed', head: 'b'.repeat(40) }));
    let claimed = false;
    runReconcileFixDispatch({ root: 'fixture', repo: 'we', dryRun: false,
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefOid: id.head, headRefName: 'topic', files: ['src/a.mjs'],
        mqFailureRecovery: { ...id, recoveryAction: 'refresh', evidence: { complete: true, testFiles: ['tests/a.mjs'] } } }], refusals: [] }),
      refreshMqFailure: refresh, mqFailureLedger: { readFixFallback: () => false }, mqFailureIo: { readHead: () => id.head },
      fetchItemlessDiffPaths: () => ['src/a.mjs'], findItemFn: () => null, loadItems: () => [],
      listFixClaims: () => mode === 'scope' ? [{ meta: { repo: id.repo, pr: 99, scope: ['we:src/a.mjs'] } }] : [],
      listBuildClaims: () => [], priorityShadow: null, pickFreeLanes: () => [5],
      queueAdmission: { tryAdmit: () => ({ admit: mode !== 'queue' }) }, readPrComments: () => [], postQueueCapComment: () => {},
      prStack: mode === 'stack' ? () => ({ pairs: [{ top: 42, bottom: 99, bottomOpen: true, inSync: false }] }) : null,
      prStackSettings: { detect: true, bottomFirst: true, restack: true, restackMaxRounds: 3 },
      acquireClaim: () => { claimed = true; return { ok: mode !== 'claim' }; }, releaseClaim: () => {},
      readFixClaim: () => mode === 'fixer' || mode === 'fixer race' && claimed ? { owner: 'fixer' } : null,
      dispatch: () => ({}), tryResumeRound: null,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['authorized', 'unreadable', 'approval unreadable', 'workflow'])('production-default authorization integration: %s', async mode => {
    vi.stubEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE', 'false'); vi.stubEnv('WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE', 'on');
    const o = fixture(), exec = vi.fn((file, args) => {
      if (mode === 'unreadable' || mode === 'approval unreadable' && args.includes('headRefOid,labels,mergeable')) throw Error('unreadable authorization');
      if (file === 'git') return args[0] === 'merge-base' || args[0] === 'rev-parse' ? 'c'.repeat(40)
        : args[0] === 'diff' && args.includes('--name-only') ? mode === 'workflow' ? '.github/workflows/test.yml\0' : 'src/a.mjs\0' : '';
      if (args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 0 } } } } });
      if (args.includes('--paginate')) return '';
      return JSON.stringify({ headRefOid: id.head, baseRefName: 'main', labels: ['ready-to-merge'], mergeable: 'MERGEABLE' });
    });
    try {
      const result = runReconcileFixDispatch({ root: 'fixture', repo: 'we', dryRun: false,
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefOid: id.head, headRefName: 'topic', files: ['src/a.mjs'],
          mqFailureRecovery: { ...id, recoveryAction: 'refresh', evidence: { complete: true, testFiles: ['tests/a.mjs'] } } }], refusals: [] }),
        mqRefreshExec: exec, mqRefreshStore: o.store, mqFailureLedger: { ...o.ledger, readFixFallback: () => false }, mqFailureIo: o.io,
        fetchItemlessDiffPaths: () => ['src/a.mjs'], findItemFn: () => null, loadItems: () => [],
        listFixClaims: () => [], listBuildClaims: () => [], priorityShadow: null, pickFreeLanes: () => [5],
        acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, readFixClaim: () => null, tryResumeRound: null,
      });
      expect(pushes(o)).toHaveLength(mode === 'authorized' ? 1 : 0);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'mq-failure-refresh' }));
      if (mode !== 'authorized') expect(o.io.createCheckout).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it('4 conflict cap prevents failed-check recovery evidence', () => {
    const nodes = Array.from({ length: 10 }, () => ({ __typename: 'RemovedFromMergeQueueEvent', reason: 'merge_conflict' }));
    nodes.push({ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', beforeCommit: { parents: { nodes: [{}, { oid: id.head }] } } });
    expect(decideMqSameHead({ ...id, timeline: { nodes, hasPreviousPage: false } }).line).toMatch(/repeated merge_conflict/);
  });
  it('5 a failed recovery spends the shared claim used by the existing path', async () => {
    const o = fixture(); o.io.git.mockReturnValue({ ok: false });
    expect((await refreshMqFailureHead(o)).action).toBe('fix');
    expect(o.store.claim(`${id.repo}#42@${id.head}`)).toBe(false);
    expect((await refreshMqFailureHead(o)).action).toBe('stop');
    expect(o.io.createCheckout).toHaveBeenCalledTimes(1);
  });
  it('5 a consumed existing refresh claim prevents recovery, even after failure', async () => {
    const o = fixture(); o.store.claim(`${id.repo}#42@${id.head}`);
    expect((await refreshMqFailureHead(o)).action).toBe('stop'); expect(o.io.createCheckout).not.toHaveBeenCalled();
  });
});
