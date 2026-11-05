// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as queueSafety from '../drain-queue-safety.mjs';
import { readDrainQueueSafety, redTeamEnqueueHold, dequeueSentBack, sendBackReason, decideMqSameHead, readMqTimeline, mqSameHeadGuard, createMqSameHeadRefreshStore, createMqSameHeadRefreshOptions, mqSameHeadRefreshStatePath } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { parseRedTeamComment, redTeamGateMarker, redTeamMarker, redTeamResultId } from '../red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker, parseLatestHumanClearedSha } from '../review-escalation.mjs';
import { readStandingRuling, readOperatorIssues, headIsCardOnly, headBelongsToPr, readUneditedCommentIds } from '../../conveyor/standing-ruling-io.mjs';
import { readCompletePrComments } from '../../conveyor/pr-comments-complete.mjs';
import { proveHumanOnlyLicense } from '../human-only-enqueue-license.mjs';
import { enqueuePr, readPinnedChangedFiles, workflowEditHold } from '../merge-queue-enqueue.mjs';
import { resolveSkipRebaseApprovedHumanSurface, readApprovedHumanSurfaceHold } from '../approved-human-surface-hold.mjs';
import { decideDrainWorkflowEditHold } from '../drain-workflow-edit-hold.mjs';

const head = '5300b9ec377a' + '0'.repeat(28);
const prior = 'a'.repeat(40);

describe('shared same-head live reader', () => {
  it('strips both memo environments while preserving caller options and non-GitHub IO', () => {
    const exec = vi.fn(() => 'live');
    const reader = queueSafety.createMqLiveReader(exec);
    const opts = { env: { WE_GH_READ_MEMO_DIR: 'child-memo', PATH: 'child-path' },
      throttle: { env: { WE_GH_READ_MEMO_DIR: 'throttle-memo', GH_TOKEN: 'fixture' },
        personalRoute: false, maxAttempts: 1 }, timeout: 123, maxBuffer: 456 };
    expect(reader('gh', ['api', 'fixture'], opts)).toBe('live');
    expect(exec).toHaveBeenLastCalledWith('gh', ['api', 'fixture'], {
      ...opts, env: { PATH: 'child-path' },
      throttle: { ...opts.throttle, env: { GH_TOKEN: 'fixture' } },
    });
    expect(opts.env.WE_GH_READ_MEMO_DIR).toBe('child-memo');
    expect(opts.throttle.env.WE_GH_READ_MEMO_DIR).toBe('throttle-memo');
    reader('git', ['diff'], opts);
    expect(exec.mock.calls[1][2]).toBe(opts);
  });
});

describe('merge-queue same-head failure admission', () => {
  const pr = 6215, repo = 'fixture/drain';
  const removed = (reason = 'failed_checks', testedHead = head) => ({
    __typename: 'RemovedFromMergeQueueEvent', reason, createdAt: '2026-11-01T12:00:00Z',
    // beforeCommit is the merge-group commit: only its SECOND parent binds the tested PR head.
    beforeCommit: { oid: 'b'.repeat(40), parents: { nodes: [{ oid: prior }, { oid: testedHead }] } },
  });
  const added = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T13:00:00Z' };
  const pushed = (after = head, createdAt = '2026-11-01T13:00:00Z') => ({
    __typename: 'HeadRefForcePushedEvent', createdAt, beforeCommit: { oid: prior }, afterCommit: { oid: after },
  });
  const timeline = (...nodes) => ({ nodes, hasPreviousPage: false });
  const decide = (evidence, mergeState = 'CLEAN') => decideMqSameHead({ pr, head, timeline: evidence, mergeState });
  const released = { hold: false, line: null };
  const expectHold = (decision, detail) => {
    expect(decision.hold).toBe(true);
    expect(decision.line).toEqual(expect.stringContaining(`mq-same-head-failed: #${pr} head ${head} — `));
    expect(decision.line.split(' — ')[1]?.trim().length).toBeGreaterThan(0);
    expect(decision.line).toMatch(detail);
  };
  const response = evidence => JSON.stringify({ data: { repository: { pullRequest: {
    timelineItems: { nodes: evidence.nodes, pageInfo: { hasPreviousPage: evidence.hasPreviousPage } },
  } } } });
  const queueResponse = (inQueue = false, queueHead = head) => JSON.stringify({ data: { repository: {
    pullRequest: { isInMergeQueue: inQueue, headRefOid: queueHead },
  } } });
  const withQueue = read => vi.fn((command, args) => args.some(arg => arg.includes('isInMergeQueue'))
    ? queueResponse() : read(command, args));

  describe('once-per-head refresh', () => {
    function fixture(test) {
      const dir = mkdtempSync(join(process.env.TMPDIR, 'mq-refresh-'));
      const path = join(dir, 'state.json');
      const store = createMqSameHeadRefreshStore({ path });
      const f = { path, store, labels: ['ready-to-merge'], live: {
        headRefOid: head, mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }, log: vi.fn(), approvedHeadHold: vi.fn(() => false), enqueueAllowed: vi.fn(() => true) };
      f.workflowRuns = new Map();
      f.exec = vi.fn((_command, args) => {
        const runPath = args.find(arg => /^repos\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(arg));
        if (runPath) {
          const result = f.workflowRuns.get(runPath.split('/').at(-1));
          if (result instanceof Error) throw result;
          return result ?? JSON.stringify({ workflow_id: 900 });
        }
        if (args.includes('PUT')) {
          if (f.refused) throw new Error('HTTP 422: head moved');
          return '{}';
        }
        if (args.includes('labels,headRefOid')) {
          if (f.labels === null) throw new Error('offline');
          return JSON.stringify({ labels: f.labels, headRefOid: f.labelHead ?? head });
        }
        if (args.includes('mergeStateStatus,headRefOid,statusCheckRollup')) return JSON.stringify(f.live);
        if (args.some(arg => arg.includes('isInMergeQueue'))) return queueResponse(false, f.guardHead ?? head);
        if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ mergeStateStatus: f.live.mergeStateStatus, headRefOid: head });
        return response(f.timeline ?? timeline(removed('failed_checks', f.guardHead ?? head)));
      });
      f.run = (selectedStore = store, identity = {}) => {
        f.guardHead = identity.head ?? head;
        return mqSameHeadGuard({ repo, pr, head, ...identity, exec: f.exec, log: f.log,
          refresh: createMqSameHeadRefreshOptions({ store: selectedStore, approvedHeadHold: f.approvedHeadHold,
            enqueueAllowed: f.enqueueAllowed, repo, pr, head, ...identity }) });
      };
      f.requests = () => f.exec.mock.calls.filter(([, args]) => args.includes('PUT'));
      try { test(f); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    it.each(['allowed', 'moved base/head', 'unreadable evidence', 'red-team hold', 'workflow hold', 'license disabled', 'approval hold'])(
      'whole production refresh path ignores seeded stale memo: %s', outcome => fixture(f => {
        const memoDir = mkdtempSync(join(process.env.TMPDIR, 'refresh-memo-'));
        const memoPath = join(memoDir, 'stale.json');
        // The spy models gh-throttle's memo lookup independently of the child environment.
        const stale = { headRefOid: prior, baseRefName: 'obsolete-base' };
        writeFileSync(memoPath, JSON.stringify(stale));
        const previous = process.env.WE_GH_READ_MEMO_DIR;
        process.env.WE_GH_READ_MEMO_DIR = memoDir;
        f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
        const calls = [], stages = [];
        const original = f.exec.getMockImplementation();
        const exec = vi.fn((file, args, opts) => {
          if (file === 'git') {
            if (args[0] === 'ls-tree') return '';
            if (args[0] === 'merge-base' || args[0] === 'rev-parse') return prior;
            if (args.includes('--name-only')) return args.includes('--end-of-options')
              ? '.github/workflows/test.yml\0' : outcome === 'approval hold' ? '.github/workflows/test.yml\0' : 'README.md\0';
            return '';
          }
          const cached = (opts?.throttle?.env ?? process.env).WE_GH_READ_MEMO_DIR;
          calls.push({ args, opts, cached });
          if (args.includes('headRefOid,baseRefName')) {
            stages.push('head/base');
            return cached ? readFileSync(memoPath, 'utf8') : JSON.stringify({
              headRefOid: outcome === 'moved base/head' ? prior : head, baseRefName: 'main',
            });
          }
          if (args.includes('headRefOid,labels,mergeable') || args.includes('headRefOid,labels')) {
            stages.push('approval');
            return JSON.stringify({ headRefOid: head, labels: ['review:accepted'], mergeable: 'MERGEABLE' });
          }
          if (args.some(a => a.includes('commits/') && a.endsWith('/pulls'))) return String(pr);
          if (args.some(a => a.includes('issues(first:100'))) return JSON.stringify({ data: { repository: {
            issues: { nodes: [], pageInfo: { hasNextPage: false } },
          } } });
          if (args.some(a => a.includes('lastEditedAt'))) return JSON.stringify({ data: { repository: { pullRequest: {
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
          } } } });
          if (args.includes('--paginate')) return `<!-- reviewed-sha: ${outcome === 'workflow hold' ? prior : head} -->\\n<!-- cleared-human: operator -->\t2026-11-01T12:00:00Z\tchalbert\tIC_fixture\thttps://example.test/comment\n`;
          if (args.some(a => a.includes('comments{totalCount}'))) return JSON.stringify({
            data: { repository: { pullRequest: { comments: { totalCount: 1 } } } },
          });
          return original(file, args, opts);
        });
        const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
        const holdStart = source.indexOf('  const approvedHeadHold = ');
        const holdEnd = source.indexOf('  const prestageSetting = ', holdStart);
        const dependencies = {
          approvedHeadSetting: { value: 'on', source: 'settings' },
          mergeStrategy: { queueOwnsFreshness: () => true }, isLocalRepo: () => true,
          siblingCloneDir: () => null, readApprovedHumanSurfaceHold, AS_JSON: false,
          process: { cwd: () => '/fixture', stderr: { write: vi.fn() } },
          repoTag: () => '', localSlug: repo, readGh: (args, opts) => exec('gh', args, opts),
          execFileSync: exec, ...queueSafety,
        };
        const approvedHeadHold = new Function(...Object.keys(dependencies),
          source.slice(holdStart, holdEnd) + '\nreturn approvedHeadHold;')(...Object.values(dependencies));
        const start = source.indexOf('  function enqueueWithSameHeadGuard(');
        const end = source.indexOf('  // xym8nt4 — post-approval', start);
        const wiring = { ...dependencies, DRY_RUN: false, mqSameHeadRefreshStore: f.store,
          execFileSyncThrottled: exec, createMqLiveReader: (reader = exec) => queueSafety.createMqLiveReader(reader),
          readCompletePrComments, readPinnedChangedFiles,
          readDrainQueueSafety: () => ({ value: { waitForRedTeamBeforeEnqueue: true } }),
          readDrainRedTeamEvidence: () => {
            stages.push('red-team');
            if (outcome === 'unreadable evidence') throw Error('red-team evidence unreadable');
            return { scheduled: outcome === 'red-team hold', skipCardOnly: false };
          },
          // Exercise all nested standing-ruling read adapters even without a grant in this thread.
          readStandingRuling, readOperatorIssues, headBelongsToPr, readUneditedCommentIds,
          headIsCardOnly: (target, options) => headIsCardOnly(target, {
            ...options, readNet: () => ({ ok: true, files: ['backlog/123-fixture.md'] }),
          }),
          standingRulingScope: (target, readers) => {
            stages.push('standing ruling');
            readers.readRuling(repo);
            readers.cardOnly({ repo, number: pr, head });
            readers.unedited({ repo, number: pr });
            return null;
          }, redTeamEnqueueHold: evidence => redTeamEnqueueHold({ ...evidence, env: {} }),
          resolveDrainWorkflowEditHuman: () => { stages.push('workflow setting'); return { value: 'on', source: 'settings' }; },
          decideDrainWorkflowEditHold, parseLatestHumanClearedSha, workflowEditHold,
          resolveApprovalLicensesEnqueue: () => { stages.push('license setting'); return { value: outcome !== 'license disabled', source: 'settings' }; },
          proveHumanOnlyLicense,
          mqSameHeadGuard: opts => mqSameHeadGuard({ ...opts, exec, log: f.log }),
        };
        try {
          const enqueue = new Function(...Object.keys(wiring), source.slice(start, end)
            + '\nreturn enqueueWithSameHeadGuard;')(...Object.values(wiring));
          expect(enqueue({ repo, num: pr }, head, {}, approvedHeadHold).kind).toBe('mq-same-head-failed');
          expect(calls.length).toBeGreaterThan(3);
          expect(calls.filter(({ args }) => args.some(arg => /actions\/runs\/(100|101)$/.test(arg))))
            .toHaveLength(2);
          for (const { opts, cached } of calls) {
            expect(cached).toBeUndefined();
            expect(opts.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
            expect(opts.throttle.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
          }
          expect(stages).toContain('red-team');
          if (outcome === 'allowed') {
            expect(stages).toEqual(expect.arrayContaining(['head/base', 'workflow setting', 'license setting', 'approval', 'standing ruling']));
            expect(calls.filter(c => c.args.includes('PUT'))).toHaveLength(1);
          } else {
            expect(calls.filter(c => c.args.includes('PUT'))).toHaveLength(0);
            expect(existsSync(f.path)).toBe(false);
          }
          expect(JSON.parse(readFileSync(memoPath, 'utf8'))).toEqual(stale);
          expect(process.env.WE_GH_READ_MEMO_DIR).toBe(memoDir);
        } finally {
          if (previous === undefined) delete process.env.WE_GH_READ_MEMO_DIR;
          else process.env.WE_GH_READ_MEMO_DIR = previous;
          rmSync(memoDir, { recursive: true, force: true });
        }
      }));
    it.each([undefined, null, '', '   ', 'future_failure', 'ALREADY_MERGED'])(
      'unconfirmed removal reason %s stays operator-only without refresh or ledger spend', reason => fixture(f => {
        const event = { ...removed(), reason };
        for (const nodes of [[event], [event, removed()], [removed(), event]]) {
          f.timeline = timeline(...nodes);
          expect(f.run().hold).toBe(true);
        }
        expect(f.requests()).toHaveLength(0);
        expect(existsSync(f.path)).toBe(false);
        expect(f.approvedHeadHold).not.toHaveBeenCalled();
        expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/operator.*inspect/i));
      }));
    it.each(['CI_FAILURE', 'FAILED_CHECKS', 'BRANCH_PROTECTION_FAILURE', 'INVALID_MERGE_COMMIT'])(
      'explicit failure %s bound to the current head permits one refresh', reason => fixture(f => {
        f.timeline = timeline(removed(reason));
        expect(f.run().hold).toBe(true);
        expect(f.requests()).toHaveLength(1);
      }));
    it.each(['queue', 'checks', 'labels'])(
      'refresh authorizing %s read bypasses a configured memo and observes live refusal', stage => fixture(f => {
        const previousMemo = process.env.WE_GH_READ_MEMO_DIR;
        process.env.WE_GH_READ_MEMO_DIR = join(process.env.TMPDIR, 'stale-read-memo');
        const originalExec = f.exec.getMockImplementation();
        const liveReads = [];
        f.exec.mockImplementation((command, args, opts) => {
          const target = stage === 'queue' ? args.some(arg => arg.includes('isInMergeQueue'))
            : args.includes(stage === 'checks' ? 'mergeStateStatus,headRefOid,statusCheckRollup' : 'labels,headRefOid');
          if (target) {
            // Match gh-throttle: memo configuration comes from throttle.env, not child env.
            const memoEnv = opts?.throttle?.env ?? process.env;
            liveReads.push({ opts, memoEnv });
            if (!memoEnv.WE_GH_READ_MEMO_DIR) {
              if (stage === 'queue') return queueResponse(false, prior);
              if (stage === 'checks') return JSON.stringify({ ...f.live, mergeStateStatus: 'BEHIND' });
              return JSON.stringify({ headRefOid: head, labels: ['review:human'] });
            }
          }
          return originalExec(command, args, opts);
        });
        try {
          expect(f.run().hold).toBe(true);
          expect(f.requests()).toHaveLength(0);
          expect(existsSync(f.path)).toBe(false);
          expect(liveReads).toHaveLength(1);
          expect(liveReads[0].memoEnv).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
          expect(liveReads[0].opts.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
          expect(liveReads[0].opts.env.PATH).toBe(process.env.PATH);
          expect(process.env.WE_GH_READ_MEMO_DIR).toContain('stale-read-memo');
        } finally {
          if (previousMemo === undefined) delete process.env.WE_GH_READ_MEMO_DIR;
          else process.env.WE_GH_READ_MEMO_DIR = previousMemo;
        }
      }));
    it.each(['labels', 'comments', 'unreadable'])(
      'strict production approvedHeadHold bypasses stale approval %s memo and refuses refresh', stage => fixture(f => {
        const previousMemo = process.env.WE_GH_READ_MEMO_DIR;
        process.env.WE_GH_READ_MEMO_DIR = join(process.env.TMPDIR, 'stale-approval-memo');
        const reads = [];
        const readGh = vi.fn((args, opts) => {
          const memoEnv = opts?.throttle?.env ?? process.env;
          const cached = Boolean(memoEnv.WE_GH_READ_MEMO_DIR);
          reads.push({ opts, cached });
          if (!cached && stage === 'unreadable') throw new Error('approval offline');
          const approved = !cached || stage === 'labels';
          if (args.includes('headRefOid,labels,mergeable')) return JSON.stringify({
            headRefOid: head, labels: cached && stage === 'labels' ? [] : ['review:accepted'], mergeable: 'MERGEABLE',
          });
          if (args.includes('--paginate')) return approved
            ? `<!-- reviewed-sha: ${head} -->\\n<!-- cleared-human: operator -->\t2026-11-01T12:00:00Z\tchalbert\tIC_fixture\thttps://example.test/comment\n` : '';
          if (args.some(arg => arg.includes('comments{totalCount}'))) return JSON.stringify({
            data: { repository: { pullRequest: { comments: { totalCount: approved ? 1 : 0 } } } },
          });
          throw new Error('unexpected approval read');
        });
        const git = vi.fn((file, args) => {
          expect(file).toBe('git');
          if (args[0] === 'merge-base') return prior;
          if (args[0] === 'ls-tree') return '';
          if (args.includes('--name-only')) return '.github/workflows/test.yml\0';
          return '';
        });
        const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
        const start = source.indexOf('  const approvedHeadHold = ');
        const end = source.indexOf('  const prestageSetting = ', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const stderr = { write: vi.fn() };
        const makeHold = new Function('approvedHeadSetting', 'mergeStrategy', 'isLocalRepo', 'siblingCloneDir',
          'readApprovedHumanSurfaceHold', 'AS_JSON', 'process', 'repoTag', 'localSlug', 'readGh', 'execFileSync', 'createMqLiveReader',
          source.slice(start, end) + '\nreturn approvedHeadHold;');
        f.approvedHeadHold = makeHold({ value: 'on', source: 'settings' }, { queueOwnsFreshness: () => true },
          () => true, () => null, readApprovedHumanSurfaceHold, false, { cwd: () => '/fixture', stderr },
          () => '', repo, readGh, git, queueSafety.createMqLiveReader);
        try {
          // Legacy callers still see the memo's missing approval, with unchanged read options.
          expect(f.approvedHeadHold({ repo, num: pr }, head)).toBe(false);
          expect(reads).toHaveLength(3);
          expect(reads.every(read => read.cached)).toBe(true);
          expect(reads.every(read => !read.opts.env && !read.opts.throttle)).toBe(true);
          reads.length = 0;
          f.run(f.store, { repo: `fixture/stale-approval-${stage}` });
          expect(f.requests()).toHaveLength(0);
          expect(existsSync(f.path)).toBe(false);
          expect(f.exec.mock.calls.some(([, args]) => args.includes('labels,headRefOid'))).toBe(false);
          expect(reads).toHaveLength(stage === 'unreadable' ? 1 : 3);
          for (const { opts, cached } of reads) {
            expect(cached).toBe(false);
            expect(opts.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
            expect(opts.throttle.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
            expect(opts.env.PATH).toBe(process.env.PATH);
          }
          expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/authorization refused or unreadable.*inspect/));
          if (stage === 'unreadable') expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/approval offline.*not requesting same-head refresh/));
          expect(process.env.WE_GH_READ_MEMO_DIR).toContain('stale-approval-memo');
        } finally {
          if (previousMemo === undefined) delete process.env.WE_GH_READ_MEMO_DIR;
          else process.env.WE_GH_READ_MEMO_DIR = previousMemo;
        }
      }));
    it.each(['unreadable', 'malformed', 'unresolvable'])(
      'strict production approvedHeadHold refuses %s settings before refresh', kind => fixture(f => {
        const setting = resolveSkipRebaseApprovedHumanSurface({ env: {}, readFile: () => {
          if (kind === 'unreadable') throw new Error('offline');
          return kind === 'malformed' ? '{' : JSON.stringify({ mergeQueue: { skipRebaseApprovedHumanSurface: 'unknown' } });
        } });
        expect(setting).toEqual({ value: 'off', source: 'default' });
        const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
        const start = source.indexOf('  const approvedHeadHold = ');
        const end = source.indexOf('  const prestageSetting = ', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const readHold = vi.fn(() => ({ hold: false }));
        const stderr = { write: vi.fn() };
        // Execute the production closure with hermetic dependencies; importing the CLI runs its driver.
        const makeHold = new Function('approvedHeadSetting', 'mergeStrategy', 'isLocalRepo', 'siblingCloneDir',
          'readApprovedHumanSurfaceHold', 'AS_JSON', 'process', 'repoTag', 'localSlug',
          source.slice(start, end) + '\nreturn approvedHeadHold;');
        f.approvedHeadHold = makeHold(setting, { queueOwnsFreshness: () => true }, () => true, () => null,
          readHold, false, { cwd: () => '/fixture', stderr }, () => '', repo);
        expect(f.approvedHeadHold({ repo, num: pr }, head)).toBe(false);
        readHold.mockClear();
        expect(f.approvedHeadHold({ repo, num: pr }, head, { strict: true })).toBe(true);
        f.run();
        expect(f.requests()).toHaveLength(0);
        expect(existsSync(f.path)).toBe(false);
        expect(readHold).not.toHaveBeenCalled();
        expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/unreadable.*not requesting same-head refresh/));
      }));
    it('logs each different skip reason once on the same repository/PR/head', () => fixture(f => {
      const identity = { repo: 'fixture/changed-skip-reason' };
      f.live.mergeStateStatus = 'BEHIND';
      f.run(f.store, identity); f.run(f.store, identity);
      f.live.mergeStateStatus = 'CLEAN';
      f.live.statusCheckRollup = [];
      f.run(f.store, identity); f.run(f.store, identity);
      f.live.mergeStateStatus = 'BEHIND';
      f.run(f.store, identity);
      expect(f.log.mock.calls.map(([line]) => line).filter(line => line.startsWith('mq-same-head-refresh:')))
        .toEqual(['not CLEAN', 'checks not green'].map(reason =>
          `mq-same-head-refresh: #${pr} head ${head} — skipped (${reason})`));
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['SKIPPED', 'NEUTRAL'])('later %s never masks a completed failure', conclusion => fixture(f => {
      f.live.statusCheckRollup = [
        { name: 'gate', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-02T10:00:00Z' },
        { name: 'gate', workflowName: 'CI', status: 'COMPLETED', conclusion, startedAt: '2026-11-02T10:05:00Z' },
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'])('later SUCCESS never masks %s anywhere in the rollup', status => fixture(f => {
      f.live.statusCheckRollup = [
        { name: 'gate', workflowName: 'CI', status, startedAt: '2026-11-02T10:00:00Z' },
        { name: 'gate', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-02T10:05:00Z' },
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    const runCheck = (run, conclusion, minute, extra = {}) => ({
      __typename: 'CheckRun', name: 'review-gate', workflowName: 'CI', status: 'COMPLETED', conclusion,
      startedAt: `2026-11-02T10:${minute}:00Z`, completedAt: `2026-11-02T10:${minute}:30Z`,
      detailsUrl: `https://github.com/fixture/drain/actions/runs/${run}/job/${run}01`, ...extra,
    });
    it('distinct workflow_ids with identical workflow and job names stay blocking', () => fixture(f => {
      f.workflowRuns.set('100', JSON.stringify({ workflow_id: 900 }));
      f.workflowRuns.set('101', JSON.stringify({ workflow_id: 901 }));
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['100', '101'])('unreadable or missing workflow_id for run %s fails closed', run => fixture(f => {
      const invalid = [new Error('lookup offline'), 'not JSON', '{}', 'null', '{"workflow_id":null}',
        '{"workflow_id":""}', '{"workflow_id":0}'];
      for (const result of invalid) {
        f.workflowRuns.set(run, result);
        f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
        f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
      }
    }));
    it('same live workflow_id across different runs supersedes regardless of display workflow name', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'),
        runCheck(101, 'SUCCESS', '05', { workflowName: 'renamed' })];
      f.run(); expect(f.requests()).toHaveLength(1);
    }));
    it('workflow lookups are cached once per distinct run only within a decision', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(100, 'FAILURE', '01'),
        runCheck(101, 'SUCCESS', '05')];
      f.approvedHeadHold.mockReturnValue(true); // Refuse after judging checks so a second decision is possible.
      const lookups = () => f.exec.mock.calls.filter(([, args]) => args.some(arg => /actions\/runs\/\d+$/.test(arg)));
      f.run(); expect(lookups()).toHaveLength(2);
      f.workflowRuns.set('101', JSON.stringify({ workflow_id: 901 }));
      f.approvedHeadHold.mockReturnValue(false);
      f.run(); expect(lookups()).toHaveLength(4);
      expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each([false, true])('same-name jobs in one run retain failure despite later SUCCESS: reversed=%s', reverse => fixture(f => {
      const rows = [runCheck(100, 'FAILURE', '00'), runCheck(100, 'SUCCESS', '05', {
        detailsUrl: 'https://github.com/fixture/drain/actions/runs/100/job/10002',
      })];
      f.live.statusCheckRollup = reverse ? rows.reverse() : rows;
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it('same workflow and name with valid distinct run URLs allows a later SUCCESS', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      f.run(); expect(f.requests()).toHaveLength(1); expect(existsSync(f.path)).toBe(true);
    }));
    it('workflow B failure stays blocking when workflow A succeeds with the same check name', () => fixture(f => {
      f.workflowRuns.set('101', JSON.stringify({ workflow_id: 901 }));
      f.live.statusCheckRollup = [
        runCheck(100, 'FAILURE', '00', { workflowName: 'B' }),
        runCheck(101, 'SUCCESS', '05', { workflowName: 'A' }),
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['failure', 'success'])('missing detailsUrl on %s stays blocking', missing => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      delete f.live.statusCheckRollup[missing === 'failure' ? 0 : 1].detailsUrl;
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each([
      'https://github.com/other/drain/actions/runs/101/job/10101',
      'https://github.com/fixture/other/actions/runs/101/job/10101',
      'https://example.com/fixture/drain/actions/runs/101/job/10101',
      'https://github.com/fixture/drain/actions/runs/not-an-id/job/10101',
      'https://github.com/fixture/drain/actions/runs/101/job/not-an-id',
      'https://github.com/fixture/drain/actions/workflows/ci.yml',
      '',
    ])('unrelated or unparseable run URL stays blocking: %s', detailsUrl => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05', { detailsUrl })];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['failure', 'success'])('missing workflowName on %s uses live workflow_id despite valid run URLs', missing => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      delete f.live.statusCheckRollup[missing === 'failure' ? 0 : 1].workflowName;
      f.run(); expect(f.requests()).toHaveLength(1); expect(existsSync(f.path)).toBe(true);
    }));
    it('run URLs without job IDs still identify runs', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')]
        .map(row => ({ ...row, detailsUrl: row.detailsUrl.replace(/\/job\/\d+$/, '') }));
      f.run(); expect(f.requests()).toHaveLength(1);
    }));
    it.each(['failure', 'success'])('missing check name on %s stays blocking', missing => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      delete f.live.statusCheckRollup[missing === 'failure' ? 0 : 1].name;
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it('different check names in the same workflow cannot supersede', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05', { name: 'other' })];
      f.run(); expect(f.requests()).toHaveLength(0);
    }));
    it.each(['failure', 'success'])('missing completedAt on %s stays blocking', missing => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05')];
      delete f.live.statusCheckRollup[missing === 'failure' ? 0 : 1].completedAt;
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it('tied completion times stay blocking despite valid later-starting run identity', () => fixture(f => {
      f.live.statusCheckRollup = [runCheck(100, 'FAILURE', '00'), runCheck(101, 'SUCCESS', '05', {
        completedAt: '2026-11-02T10:00:30Z',
      })];
      f.run(); expect(f.requests()).toHaveLength(0);
    }));
    // Trimmed from #6287's rollup: preserve the actual run timestamps and mixed outcomes.
    const rollup6287 = [
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE', state: null, startedAt: '2026-11-02T23:06:39Z', completedAt: '2026-11-02T23:06:42Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'CANCELLED', state: null, startedAt: '2026-11-02T23:06:35Z', completedAt: '2026-11-02T23:06:35Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'CANCELLED', state: null, startedAt: '2026-11-02T23:15:28Z', completedAt: '2026-11-02T23:15:28Z' },
      { name: 'merge-gate', status: 'COMPLETED', conclusion: 'SUCCESS', state: null, startedAt: '2026-11-02T22:52:02Z', completedAt: '2026-11-02T22:59:48Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS', state: null, startedAt: '2026-11-02T22:52:04Z', completedAt: '2026-11-02T22:52:27Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS', state: null, startedAt: '2026-11-02T23:26:39Z', completedAt: '2026-11-02T23:26:43Z' },
      { name: 'visual', status: 'COMPLETED', conclusion: 'SKIPPED', state: null, startedAt: '2026-11-02T22:52:03Z', completedAt: '2026-11-02T22:52:02Z' },
    ].map((row, index) => ({ ...row, __typename: 'CheckRun', workflowName: 'CI',
      // Preserve observed outcomes/times; representative IDs model the full rollup URL shape.
      detailsUrl: `https://github.com/fixture/drain/actions/runs/${300 + index}/job/${400 + index}`,
    }));
    it.each(['SUCCESS', 'FAILURE'])('#6287-shaped rollup judges latest review-gate %s', conclusion => fixture(f => {
      f.live.statusCheckRollup = rollup6287.map(row => ({ ...row, workflowName: 'CI',
        ...(row.completedAt === '2026-11-02T23:26:43Z' ? { conclusion } : {}),
      }));
      f.run();
      expect(f.requests()).toHaveLength(conclusion === 'SUCCESS' ? 1 : 0);
      expect(existsSync(f.path)).toBe(conclusion === 'SUCCESS');
    }));
    it.each([
      ['completed failure', { status: 'COMPLETED', conclusion: 'FAILURE' }],
      ['cancelled', { status: 'COMPLETED', conclusion: 'CANCELLED' }],
      ['running', { status: 'IN_PROGRESS', conclusion: null }],
      ['pending context', { name: '', context: 'review-gate', state: 'PENDING' }],
    ])('latest %s blocks an older success', (_name, latest) => fixture(f => {
      f.live.statusCheckRollup = [{ ...rollup6287[5], workflowName: 'CI' }, { name: 'review-gate', workflowName: 'CI', ...latest, startedAt: '2026-11-02T23:27:00Z' }];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each([
      ['running', { status: 'IN_PROGRESS', conclusion: null }],
      ['failed', { status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-02T10:06:00Z' }],
    ])('newer %s attempt blocks an older success that finishes later', (_kind, newer) => fixture(f => {
      f.live.statusCheckRollup = [
        { ...runCheck(100, 'SUCCESS', '00'), completedAt: '2026-11-02T10:10:00Z' },
        { ...runCheck(101, 'FAILURE', '05'), ...newer },
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['success', 'failure'])('missing %s start time keeps overlapping failure blocking', missing => fixture(f => {
      const success = { ...runCheck(100, 'SUCCESS', '00'), completedAt: '2026-11-02T10:10:00Z' };
      const failure = { ...runCheck(101, 'FAILURE', '05'), completedAt: '2026-11-02T10:06:00Z' };
      if (missing !== 'failure') delete success.startedAt;
      if (missing !== 'success') delete failure.startedAt;
      f.live.statusCheckRollup = [success, failure];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])(
      'missing start times retain %s despite a success completing later with shared workflow identity', conclusion => fixture(f => {
        f.live.statusCheckRollup = [
          { name: 'gate', workflow: 'CI', status: 'COMPLETED', conclusion, completedAt: '2026-11-02T10:00:00Z' },
          { name: 'gate', workflow: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-02T10:05:00Z' },
        ];
        // Completion order cannot distinguish an older overlapping success from a retry.
        f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
      }));
    it('workflow URL without a run identity cannot supersede failure', () => fixture(f => {
      const identity = { name: 'gate', context: 'checks', app: { id: 123 }, detailsUrl: 'https://github.com/fixture/drain/actions/workflows/ci.yml' };
      f.live.statusCheckRollup = [
        { ...identity, status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-02T10:00:00Z' },
        { ...identity, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-02T10:05:00Z' },
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['other workflow', 'missing workflow', 'blank workflow'])(
      'a later success from another workflow cannot hide a same-name failure: %s', source => fixture(f => {
        f.live.statusCheckRollup = [
          { name: 'test', workflowName: 'Security', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-02T10:00:00Z' },
          { name: 'test', workflowName: source === 'other workflow' ? 'CI' : source === 'blank workflow' ? '' : undefined,
            status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-02T10:05:00Z' },
        ];
        f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
      }));
    it('missing workflow identity cannot prove that a success supersedes a failure', () => fixture(f => {
      f.live.statusCheckRollup = rollup6287.map(({ workflowName, ...row }) => row);
      for (let index = 0; index < rollup6287.length; index++) f.workflowRuns.set(String(300 + index), '{}');
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each([false, true])('unordered duplicates fail closed regardless of order: reversed=%s', reverse => fixture(f => {
      const rows = [{ context: 'gate', state: 'SUCCESS' }, { context: 'gate', state: 'FAILURE' }];
      f.live.statusCheckRollup = reverse ? rows.reverse() : rows;
      f.run(); expect(f.requests()).toHaveLength(0);
    }));
    it.each(['tied', 'undated'])('%s failure cannot be superseded by a dated success', kind => fixture(f => {
      f.live.statusCheckRollup = [{ ...rollup6287[5], workflowName: 'CI' }, {
        name: 'review-gate', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE',
        ...(kind === 'tied' ? { startedAt: rollup6287[5].startedAt, completedAt: rollup6287[5].completedAt } : {}),
      }];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it('state-only StatusContext rows cannot supersede failures', () => fixture(f => {
      f.live.statusCheckRollup = [
        { __typename: 'StatusContext', context: 'gate', workflowName: 'CI', status: 'COMPLETED', state: 'FAILURE', startedAt: '2026-11-02T23:06:39Z' },
        { name: '', context: 'gate', workflowName: 'CI', status: 'COMPLETED', state: 'SUCCESS', startedAt: '2026-11-02T23:26:39Z' },
      ];
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it.each([[], null])('empty/missing rollup fails closed: %s', rollup => fixture(f => {
      f.live.statusCheckRollup = rollup; f.run(); expect(f.requests()).toHaveLength(0);
    }));
    it.each([
      ['head moved', f => { f.live.headRefOid = prior; }],
      ['not CLEAN', f => { f.live.mergeStateStatus = 'BEHIND'; }],
      ['checks not green', f => { f.live.statusCheckRollup = []; }],
      ['blocking label', f => { f.labels.push('review:changes'); }],
      ['authorization refused or unreadable', f => { f.approvedHeadHold.mockReturnValue(true); }],
      ['labels unreadable', f => { f.labels = null; }],
      ['claim lost', f => { f.store.claim = vi.fn(() => false); }],
      ['state unavailable', f => { f.store.has = () => { throw Error('offline'); }; }],
      ['already requested', f => { f.store.has = () => true; }],
    ])('logs %s once per repository/PR/head/reason without writing skips', (reason, arrange) => fixture(f => {
      arrange(f);
      const identity = { repo: `fixture/skip-${reason}` };
      f.run(f.store, identity); f.run(f.store, identity);
      const lines = () => f.log.mock.calls.map(([line]) => line).filter(line => line.startsWith('mq-same-head-refresh:'));
      expect(lines()).toEqual([`mq-same-head-refresh: #${pr} head ${head} — skipped (${reason}${reason === 'state unavailable' ? '; inspect shared refresh ledger and lock before retrying' : reason === 'authorization refused or unreadable' ? '; inspect red-team evidence and workflow/human approval before retrying' : ''})`]);
      f.run(f.store, { ...identity, head: 'c'.repeat(40) });
      f.run(f.store, { ...identity, pr: pr + 1 });
      f.run(f.store, { repo: `${identity.repo}-other` });
      expect(lines()).toHaveLength(4);
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
    }));
    it('uses shared home state with an explicit test override', () => {
      expect(mqSameHeadRefreshStatePath({})).toBe(join(homedir(), '.claude', 'conveyor', 'mq-same-head-refresh-state.json'));
      expect(mqSameHeadRefreshStatePath({ WE_DRAIN_MQ_REFRESH_STATE_PATH: '/fixture/state.json' })).toBe('/fixture/state.json');
    });
    it('held CLEAN green requests exactly once across passes and a second store instance', () => fixture(f => {
      expect(f.run().hold).toBe(true);
      f.run();
      f.run(createMqSameHeadRefreshStore({ path: f.path }));
      expect(f.requests().map(([, args]) => args)).toEqual([['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`, '-f', `expected_head_sha=${head}`]]);
      expect(f.log).toHaveBeenCalledWith(`mq-same-head-refresh: #${pr} head ${head} — update-branch requested`);
    }));
    it('head-bound red-team refusal prevents update-branch, live label read and ledger spend', () => fixture(f => {
      f.enqueueAllowed.mockImplementation(() => redTeamEnqueueHold({
        repo, pr, head, comments: [], scheduled: true, skipCardOnly: false, env: {},
      }) === null);
      f.run();
      expect(f.requests()).toHaveLength(0);
      expect(f.exec.mock.calls.some(([, args]) => args.includes('labels,headRefOid'))).toBe(false);
      expect(existsSync(f.path)).toBe(false);
      f.enqueueAllowed.mockReturnValue(true);
      f.run();
      expect(f.requests()).toHaveLength(1);
    }));
    it('workflow-edit refusal prevents update-branch, live label read and ledger spend', () => fixture(f => {
      f.enqueueAllowed.mockImplementation(() => decideDrainWorkflowEditHold({
        files: ['.github/workflows/ci.yml'], filesComplete: true, headSha: head, setting: 'on',
      }).hold === false);
      f.run();
      expect(f.requests()).toHaveLength(0);
      expect(f.exec.mock.calls.some(([, args]) => args.includes('labels,headRefOid'))).toBe(false);
      expect(existsSync(f.path)).toBe(false);
    }));
    it('incomplete workflow evidence prevents update-branch and ledger spend', () => fixture(f => {
      f.enqueueAllowed.mockImplementation(() => decideDrainWorkflowEditHold({
        files: ['scripts/safe.mjs'], filesComplete: false, headSha: head, setting: 'on',
      }).hold === false);
      f.run(f.store, { repo: 'fixture/incomplete-workflow' });
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
      expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/authorization refused or unreadable; inspect.*approval before retrying/));
    }));
    it.each(['unreadable', 'incomplete', 'missing'])('enqueue evidence %s fails closed before labels or ledger spend', kind => fixture(f => {
      if (kind === 'missing') f.enqueueAllowed = undefined;
      else f.enqueueAllowed.mockImplementation(() => { if (kind === 'unreadable') throw Error('offline'); });
      f.run(f.store, { repo: `fixture/enqueue-${kind}` });
      expect(f.requests()).toHaveLength(0);
      expect(f.exec.mock.calls.some(([, args]) => args.includes('labels,headRefOid'))).toBe(false);
      expect(existsSync(f.path)).toBe(false);
      expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/authorization refused or unreadable; inspect.*approval before retrying/));
    }));
    it.each([
      ['unbound removal', { ...removed(), beforeCommit: null }],
      ['invalid bound oid', removed('failed_checks', 'invalid')],
      ['unreadable event', null],
      ['unknown event type', { __typename: 'UnknownEvent' }],
    ])('%s alongside a bound failure keeps operator-only quarantine without update-branch', (_name, event) => fixture(f => {
      f.timeline = timeline(event, removed());
      expect(f.run().hold).toBe(true);
      f.timeline = timeline(removed(), event);
      expect(f.run().hold).toBe(true);
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
      expect(f.approvedHeadHold).not.toHaveBeenCalled();
    }));
    it('readable additions, force pushes and manual/merged or bound removals permit refresh of a bound failure', () => fixture(f => {
      f.timeline = timeline(added, pushed(), { ...removed(' MANUAL '), beforeCommit: null },
        { ...removed(' MERGED '), beforeCommit: null }, removed('failed_checks', prior.toUpperCase()), removed());
      expect(f.run().hold).toBe(true);
      expect(f.requests()).toHaveLength(1);
    }));
    it.each(['review:changes', 'red-team:blocked', 'review:human', 'review:pending', 'red-team:pending', 'missing-ready', null, [null]])(
      'live label hold/unreadable %s does not spend state or request', label => fixture(f => {
        // A send-back arriving during the approved-head read must win.
        f.approvedHeadHold.mockImplementation(() => {
          f.labels = label === null ? null : Array.isArray(label) ? label : label === 'missing-ready' ? [] : ['ready-to-merge', label];
          return false;
        });
        f.run();
        expect(f.requests()).toHaveLength(0);
        expect(existsSync(f.path)).toBe(false);
        f.approvedHeadHold.mockReturnValue(false);
        f.labels = ['ready-to-merge'];
        f.run();
        expect(f.requests()).toHaveLength(1);
      }));
    it.each([
      ['red checks', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }],
      ['missing checks', { statusCheckRollup: null }],
      ['pending checks', { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }],
      ['not CLEAN', { mergeStateStatus: 'BEHIND' }],
      ['moved head', { headRefOid: prior }],
    ])('%s refuses without spending state', (_name, live) => fixture(f => {
      Object.assign(f.live, live); f.run();
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
    }));
    it('head moving at the live label read refuses without a claim', () => fixture(f => {
      f.labelHead = prior; f.run();
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
    }));
    it.each(['held', 'unreadable'])('approved-head %s refuses without spending state', kind => fixture(f => {
      f.approvedHeadHold.mockImplementation(() => { if (kind === 'unreadable') throw new Error('offline'); return true; });
      f.run(); expect(f.requests()).toHaveLength(0); expect(existsSync(f.path)).toBe(false);
    }));
    it('a competing claim after the initial ledger read prevents a second request', () => fixture(f => {
      f.approvedHeadHold.mockImplementation(() => {
        expect(createMqSameHeadRefreshStore({ path: f.path }).claim(`${repo}#${pr}@${head}`)).toBe(true);
        return false;
      });
      f.run(); expect(f.requests()).toHaveLength(0);
    }));
    it('an unbound merge_conflict cannot confirm a same-head failure, so no refresh is spent', () => fixture(f => {
      f.timeline = timeline({ ...removed('merge_conflict'), beforeCommit: null }, removed());
      expectHold(f.run(), /— failed_checks$/);
      expect(f.requests()).toHaveLength(0);
    }));
    it('a merge_conflict removal on a PR that is not CLEAN holds, and an unreadable state fails closed', () => fixture(f => {
      f.timeline = timeline({ ...removed('merge_conflict'), beforeCommit: null });
      f.live.mergeStateStatus = 'UNSTABLE';
      expectHold(f.run(), /merge_conflict removal and the PR is not CLEAN \(UNSTABLE\)/);
      f.live.mergeStateStatus = 'CLEAN';
      expect(f.run()).toEqual({ hold: false, line: null });
    }));
    it('repeated merge_conflict alone cannot confirm a failure or spend a refresh', () => fixture(f => {
      f.timeline = timeline(...Array.from({ length: 3 }, () => removed('merge_conflict')));
      expectHold(f.run(), /repeated merge_conflict ejection \(3 times\)/);
      expect(f.requests()).toHaveLength(0);
      expect(existsSync(f.path)).toBe(false);
    }));
    it('422 is logged and never retried, including by another store', () => fixture(f => {
      f.refused = true; f.run(); f.run(createMqSameHeadRefreshStore({ path: f.path }));
      expect(f.requests()).toHaveLength(1);
      expect(f.log).toHaveBeenCalledWith(`mq-same-head-refresh: #${pr} head ${head} — update-branch refused (HTTP 422: head moved); not retrying at this head`);
    }));
    it('claim re-reads shared state and returns true for exactly one store', () => fixture(f => {
      const other = createMqSameHeadRefreshStore({ path: f.path });
      const key = `${repo}#${pr}@${head}`;
      expect(f.store.claim(key)).toBe(true);
      expect(other.claim(key)).toBe(false);
      expect(other.claim(`${repo}#${pr}@${prior}`)).toBe(true);
      expect(f.store.claim(`${repo}#${pr + 1}@${head}`)).toBe(true);
      expect(f.store.claim(`other/repo#${pr}@${head}`)).toBe(true);
    }));
    it.each(['locked', 'malformed'])('%s ledger refuses with operator fallback', kind => fixture(f => {
      writeFileSync(kind === 'locked' ? `${f.path}.lock` : f.path, kind === 'locked' ? `${process.pid}\n` : '{}');
      f.run(f.store, { repo: `fixture/ledger-${kind}` }); expect(f.requests()).toHaveLength(0);
      expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/state unavailable;.*inspect.*ledger/));
    }));
  });

  describe('bounded failed_checks infrastructure retry', () => {
    const perfect = { mainGreen: true, infra: 'infra', mergeState: 'CLEAN' };
    const retryDecision = (retryEvidence = perfect, events = [removed()]) =>
      decideMqSameHead({ pr, head, timeline: timeline(...events), retryEvidence });
    const holdLine = `mq-same-head-failed: #${pr} head ${head} — failed_checks`;
    const retryLine = why => `mq-same-head-retry: #${pr} head ${head} — failed_checks infra retry 1/1 (main green, PR CLEAN, ${why})`;

    it.each(['infra', 'main-red'])('releases one same-head failed_checks removal with main green, CLEAN and %s evidence', infra => {
      expect(retryDecision({ ...perfect, infra }).hold).toBe(false);
    });
    it.each([false, null, undefined])('holds when latest main CI success is absent or unknown (%s)', mainGreen => {
      expect(retryDecision({ ...perfect, mainGreen })).toEqual({ hold: true, line: holdLine });
    });
    it('holds real test failures when main was not red at removal time', () => {
      expect(retryDecision({ ...perfect, infra: null })).toEqual({ hold: true, line: holdLine });
    });
    it.each(['BEHIND', null, undefined])('holds when the same-head live PR is not known CLEAN (%s)', mergeState => {
      expect(retryDecision({ ...perfect, mergeState })).toEqual({ hold: true, line: holdLine });
    });
    it.each([2, 3, 100])('holds %i same-head failed_checks removals even with perfect evidence and names the count', count => {
      const result = retryDecision(perfect, Array.from({ length: count }, () => removed()));
      expectHold(result, new RegExp(`failed_checks.*\\b${count}\\b`));
    });
    it.each(['ci_failure', 'branch_protection_failure', 'invalid_merge_commit'])(
      'another same-head %s removal prevents the retry in either timeline order', reason => {
        for (const events of [[removed(), removed(reason)], [removed(reason), removed()]]) {
          expectHold(retryDecision(perfect, events), /failed_checks|ci_failure|branch_protection_failure|invalid_merge_commit/);
        }
      });
    it('counts only failures bound to the current head', () => {
      expect(retryDecision(perfect, [removed('failed_checks', prior), removed('ci_failure', prior), removed()]).hold).toBe(false);
    });
    it('perfect retry evidence cannot release a truncated timeline', () => {
      expectHold(decideMqSameHead({ pr, head, retryEvidence: perfect,
        timeline: { nodes: [removed()], hasPreviousPage: true } }), /inspect.*history/i);
    });

    function fixture(test) {
      const run = (id, conclusion, created_at) => ({ id, conclusion, created_at, updated_at: created_at, status: 'completed',
        path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' });
      const f = { log: vi.fn(), events: [removed()], live: { headRefOid: head, mergeStateStatus: 'CLEAN' },
        runs: [run(12, 'success', '2026-11-01T13:00:00Z'), run(11, 'success', '2026-11-01T11:00:00Z')],
        checks: [{ id: 21, status: 'completed', conclusion: 'timed_out', output: { title: '', summary: '' } }] };
      f.exec = vi.fn((command, args) => {
        if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
        if (args.some(arg => arg.includes('isInMergeQueue'))) return queueResponse();
        if (args.some(arg => arg.includes('timelineItems'))) return response(timeline(...f.events));
        if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify(f.live);
        const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
        if (endpoint?.includes('/check-runs')) {
          f.checkReads = (f.checkReads ?? 0) + 1;
          if (f.checkError) throw new Error('check-runs unavailable');
          if (f.checkPages) return JSON.stringify({ total_count: f.checkTotal,
            check_runs: f.checkPages[f.checkReads - 1] });
          if (f.checkReads > 1) throw new Error('next check-runs page unavailable');
          return f.checkJson ?? JSON.stringify({ total_count: f.checkTotal ?? f.checks.length, check_runs: f.checks });
        }
        if (endpoint?.includes('/actions/') || (args[0] === 'run' && args[1] === 'list')) {
          f.mainReads = (f.mainReads ?? 0) + 1;
          if (f.mainError) throw new Error('main runs unavailable');
          if (f.mainPages) return JSON.stringify({ total_count: f.mainTotal,
            workflow_runs: f.mainPages[f.mainReads - 1] });
          const runs = endpoint?.includes('status=completed')
            ? f.runs.filter(run => run.status === 'completed') : f.runs;
          return f.mainJson ?? JSON.stringify(args[0] === 'run'
            ? f.runs.map(r => ({ ...r, databaseId: r.id, createdAt: r.created_at, headBranch: r.head_branch,
              workflowName: 'CI' }))
            : { total_count: runs.length, workflow_runs: runs });
        }
        throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
      });
      f.guard = () => mqSameHeadGuard({ repo, pr, head, exec: f.exec, log: f.log });
      f.expectHeld = () => {
        expect(f.guard()).toEqual({ hold: true, line: holdLine });
        expect(f.log.mock.calls[0]).toEqual([holdLine]);
        // Only a decline-reason line may follow the unchanged hold line.
        for (const [line] of f.log.mock.calls.slice(1)) expect(line).toMatch(/^mq-same-head-retry-declined: #6215 head \w+ — \S/);
      };
      test(f);
    }

    it.each(['cancelled', 'timed_out', 'startup_failure'])('guard logs retry 1/1 for infrastructure check conclusion %s', conclusion => fixture(f => {
      f.checks[0].conclusion = conclusion;
      expect(f.guard().hold).toBe(false);
      expect(f.log.mock.calls).toEqual([[retryLine('infra')]]);
      expect(f.checkReads).toBeGreaterThan(0);
      expect(f.mainReads).toBeGreaterThan(0);
      expect(f.exec.mock.calls.some(([, args]) => args.some(arg =>
        arg.includes(`/commits/${removed().beforeCommit.oid}/check-runs`)))).toBe(true);
      expect(f.exec.mock.calls.some(([, args]) => args.includes('mergeStateStatus,headRefOid'))).toBe(true);
    }));
    it.each([['title', 'Runner disconnected'], ['summary', 'Lost communication with worker'],
      ['summary', 'SELF-HOSTED RUNNER went away']])('guard treats runner loss in output.%s as infrastructure (%s)', (field, text) => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure', output: { [field]: text } };
      expect(f.guard().hold).toBe(false);
      expect(f.log.mock.calls).toEqual([[retryLine('infra')]]);
    }));
    it('guard holds when any failed check is a real test failure', () => fixture(f => {
      f.checks.push({ id: 22, status: 'completed', conclusion: 'failure', output: { title: 'Assertion failed', summary: 'expected 1 to equal 2' } });
      f.expectHeld();
    }));
    it.each(['title', 'summary'])('guard holds ordinary test-runner assertion failures in output.%s', field => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure',
        output: { [field]: 'Test runner reported failing assertions' } };
      f.expectHeld();
    }));
    it.each(['Self-hosted runner reported failing assertions', 'Runner failed assertions',
      'Test runner failed to execute assertions'])('guard holds real test failures mentioning runners: %s', text => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure', output: { summary: text } };
      f.expectHeld();
    }));
    it.each(['failure', 'cancelled', 'timed_out'])('guard permits main-red retry when latest CI before removal was %s and main is now green', conclusion => fixture(f => {
      f.runs[1].conclusion = conclusion;
      f.checks[0] = { ...f.checks[0], conclusion: 'failure', output: { title: 'Assertion failed' } };
      expect(f.guard().hold).toBe(false);
      expect(f.log.mock.calls).toEqual([[retryLine('main-red')]]);
    }));
    it('an older red main run cannot override a newer green run before removal', () => fixture(f => {
      f.runs.push({ ...f.runs[1], id: 10, conclusion: 'failure', created_at: '2026-11-01T10:00:00Z' });
      f.checks[0].conclusion = 'failure';
      f.expectHeld();
    }));
    it('a red main run created before but completed after removal is not evidence main was red at removal', () => fixture(f => {
      f.runs[1] = { ...f.runs[1], conclusion: 'failure', created_at: '2026-11-01T11:00:00Z', updated_at: '2026-11-01T13:00:00Z' };
      f.checks[0] = { ...f.checks[0], conclusion: 'failure', output: { title: 'Assertion failed' } };
      f.expectHeld();
    }));
    it('an assertion failure that mentions a runner disconnect is a real failure, not infrastructure', () => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure',
        output: { title: 'Failed', summary: 'AssertionError: Expected error "Runner disconnected" but received "assertion failed"' } };
      f.runs[1].conclusion = 'success';
      f.expectHeld();
    }));
    it('assertion text in output.text vetoes a runner-loss title', () => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure',
        output: { title: 'Runner disconnected', summary: '', text: 'AssertionError: expected 1 to be 2' } };
      f.runs[1].conclusion = 'success';
      f.expectHeld();
    }));
    it('failing-test wording in output.text vetoes a runner-loss title', () => fixture(f => {
      f.checks[0] = { ...f.checks[0], conclusion: 'failure', output: { title: 'Runner disconnected', summary: '', text: '1 failing test' } };
      f.expectHeld();
    }));
    it('a spent retry (re-enqueued after the failed removal, then manually removed) stays held', () => fixture(f => {
      f.events = [removed(), { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T12:30:00Z' },
        { __typename: 'RemovedFromMergeQueueEvent', reason: 'MANUAL', createdAt: '2026-11-01T12:40:00Z' }];
      const result = f.guard();
      expect(result.hold).toBe(true);
      expect(result.line).toMatch(/already spent/);
    }));
    it('logs why the retry was declined: a non-infrastructure failed check and main not red at removal', () => fixture(f => {
      f.checks = [{ id: 21, status: 'completed', conclusion: 'cancelled', name: 'test', output: {} },
        { id: 22, status: 'completed', conclusion: 'failure', name: 'merge-gate', output: { title: '', summary: '' } }];
      f.expectHeld();
      expect(f.log.mock.calls[1][0]).toBe(`mq-same-head-retry-declined: #${pr} head ${head} — non-infrastructure failed check(s): merge-gate; main was not red at removal`);
    }));
    it('logs why the retry was declined: main CI not green', () => fixture(f => {
      f.runs[0].conclusion = 'failure';
      f.expectHeld();
      expect(f.log.mock.calls[1][0]).toBe(`mq-same-head-retry-declined: #${pr} head ${head} — main CI is not green`);
    }));
    it('logs why the retry was declined: PR not CLEAN', () => fixture(f => {
      f.live.mergeStateStatus = 'BEHIND';
      f.expectHeld();
      expect(f.log.mock.calls[1][0]).toBe(`mq-same-head-retry-declined: #${pr} head ${head} — PR is not CLEAN (BEHIND)`);
    }));
    it('logs why the retry was declined: unreadable evidence', () => fixture(f => {
      f.checkError = true;
      f.expectHeld();
      expect(f.log.mock.calls[1][0]).toBe(`mq-same-head-retry-declined: #${pr} head ${head} — retry evidence unreadable or incomplete`);
    }));
    it('a main run with unreadable completion time keeps the hold', () => fixture(f => {
      delete f.runs[0].updated_at;
      f.runs[1].conclusion = 'failure';
      f.checks[0].conclusion = 'failure';
      f.expectHeld();
    }));
    it('a red main run created at removal time is not evidence main was red before removal', () => fixture(f => {
      f.runs[1] = { ...f.runs[1], conclusion: 'failure', created_at: removed().createdAt };
      f.checks[0].conclusion = 'failure';
      f.expectHeld();
    }));
    it.each(['failure', null, undefined])('guard holds when latest completed main CI conclusion is %s', conclusion => fixture(f => {
      f.runs[0].conclusion = conclusion;
      f.expectHeld();
    }));
    it.each(['queued', 'in_progress'])('guard holds for a newer %s main push despite older successful CI', status => fixture(f => {
      f.runs.push({ ...f.runs[0], id: 13, created_at: '2026-11-01T14:00:00Z', status, conclusion: null });
      f.expectHeld();
      const mainArgs = f.exec.mock.calls.find(([, args]) => args.some(arg => arg.includes('/actions/')))[1];
      expect(mainArgs.join(' ')).not.toContain('status=completed');
    }));
    it('guard holds at the five-page check-run cap without reading main or merge state', () => fixture(f => {
      f.checkTotal = 501;
      f.checkPages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 100 }, (_, index) =>
        ({ ...f.checks[0], id: page * 100 + index + 1 })));
      f.expectHeld();
      expect(f.checkReads).toBe(5);
      expect(f.mainReads ?? 0).toBe(0);
      expect(f.exec).toHaveBeenCalledTimes(7); // Queue, timeline, then five REST pages.
    }));
    it('guard holds after ten shared REST pages when main history remains incomplete', () => fixture(f => {
      f.checkTotal = 500;
      f.checkPages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 100 }, (_, index) =>
        ({ ...f.checks[0], id: page * 100 + index + 1 })));
      f.mainTotal = 501;
      f.mainPages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 100 }, (_, index) =>
        ({ ...f.runs[0], id: page * 100 + index + 1 })));
      f.expectHeld();
      expect(f.checkReads).toBe(5);
      expect(f.mainReads).toBe(5);
      expect(f.exec).toHaveBeenCalledTimes(12); // Queue, timeline, then ten shared REST pages.
      for (const kind of ['/check-runs', '/actions/']) {
        const endpoints = f.exec.mock.calls.flatMap(([, args]) => args.filter(arg => arg.includes(kind)));
        expect(endpoints.map(endpoint => new URLSearchParams(endpoint.split('?')[1]).get('page')))
          .toEqual(['1', '2', '3', '4', '5']);
      }
    }));
    it.each(['check-runs throws', 'check-runs bad JSON', 'main runs throws', 'main runs bad JSON',
      'missing check conclusion', 'no check-runs', 'no failed check-runs', 'truncated check-runs',
      'missing main conclusion', 'no main runs', 'head moved', 'unknown merge state', 'BEHIND'])(
      'guard fails closed with the existing hold line: %s', kind => fixture(f => {
        if (kind === 'check-runs throws') f.checkError = true;
        if (kind === 'check-runs bad JSON') f.checkJson = '{';
        if (kind === 'main runs throws') f.mainError = true;
        if (kind === 'main runs bad JSON') f.mainJson = '{';
        if (kind === 'missing check conclusion') delete f.checks[0].conclusion;
        if (kind === 'no check-runs') f.checks = [];
        if (kind === 'no failed check-runs') f.checks[0].conclusion = 'success';
        if (kind === 'truncated check-runs') f.checkTotal = 100_000;
        if (kind === 'missing main conclusion') delete f.runs[0].conclusion;
        if (kind === 'no main runs') f.runs = [];
        if (kind === 'head moved') f.live.headRefOid = prior;
        if (kind === 'unknown merge state') delete f.live.mergeStateStatus;
        if (kind === 'BEHIND') f.live.mergeStateStatus = 'BEHIND';
        f.expectHeld();
      }));
  });

  it('#6215 pattern: removed for failed_checks at H holds at H, using the second parent', () => {
    expect(decide(timeline(removed()))).toEqual({ hold: true, line: `mq-same-head-failed: #6215 head ${head} — failed_checks` });
  });
  it.each(['branch_protection_failure', 'invalid_merge_commit', 'ci_failure'])('removal for %s holds the tested head', reason => {
    expect(decide(timeline(removed(reason)))).toEqual({ hold: true, line: `mq-same-head-failed: #6215 head ${head} — ${reason}` });
  });
  it.each(['manual', 'merged', ' MANUAL ', ' MERGED ', 'merge_conflict', ' MERGE_CONFLICT '])('removed with release reason %s permits re-enqueue regardless of binding', reason => {
    for (const beforeCommit of [removed(reason).beforeCommit, null, { parents: { nodes: [] } }]) {
      expect(decide(timeline({ ...removed(reason), beforeCommit }))).toEqual(released);
    }
  });
  it.each([['UNSTABLE'], ['DIRTY'], [null]])('merge_conflict removal holds unless the live PR is CLEAN (%s)', state => {
    expect(decide(timeline({ ...removed('merge_conflict'), beforeCommit: null }), state).hold).toBe(true);
  });
  it('#6288: merge_conflict with null commit binding releases a CLEAN candidate', () => {
    expect(decide(timeline({ ...removed('merge_conflict'), beforeCommit: null }))).toEqual(released);
  });
  it('two merge_conflict removals release regardless of head binding', () => {
    expect(decide(timeline(removed('merge_conflict'),
      { ...removed('merge_conflict', prior), beforeCommit: null }))).toEqual(released);
  });
  it.each([3, 4, 100])('R466: %i merge_conflict removals hold with an operator fallback', count => {
    const events = Array.from({ length: count }, (_, i) => ({
      ...removed(i % 2 ? ' MERGE_CONFLICT ' : 'merge_conflict', prior), beforeCommit: null,
    }));
    expect(decide(timeline(...events))).toEqual({ hold: true,
      line: `mq-same-head-failed: #${pr} head ${head} — repeated merge_conflict ejection (${count} times); operator must inspect history and enqueue manually` });
  });
  it.each([false, true])('merge_conflict preserves failed_checks head binding (same head: %s)', sameHead => {
    const conflict = { ...removed('merge_conflict'), beforeCommit: null };
    const failure = removed('failed_checks', sameHead ? head : prior);
    for (const events of [[conflict, failure], [failure, conflict]]) {
      const decision = decide(timeline(...events));
      if (sameHead) expectHold(decision, /— failed_checks$/);
      else expect(decision).toEqual(released);
    }
  });
  it('removed with merge-group parent pointing at an OLDER head releases the new head', () => {
    const event = removed('failed_checks', prior);
    event.beforeCommit.oid = head;
    event.beforeCommit.parents.nodes[0].oid = head;
    expect(decide(timeline(event))).toEqual(released);
  });
  it('an earlier failed removal at an old head releases a current head with no removal', () => {
    expect(decide(timeline(removed('failed_checks', prior), added))).toEqual(released);
  });
  it('a PR with no removals releases', () => {
    expect(decide(timeline())).toEqual(released);
    expect(decide(timeline(added))).toEqual(released);
  });
  it('a later addition or manual removal cannot erase any failure at the same head', () => {
    expectHold(decide(timeline(removed(), added, removed('manual'))), /failed_checks/);
  });
  it.each(['future_failure', undefined, null, ''])('unknown or missing reason %s holds the same head', reason => {
    expectHold(decide(timeline({ ...removed(), reason })), /.+/);
  });
  it('compares reasons case-insensitively and trims whitespace', () => {
    expect(decide(timeline(removed(' FaIlEd_ChEcKs ')))).toEqual({ hold: true, line: `mq-same-head-failed: #6215 head ${head} — failed_checks` });
  });
  it.each([[head.toUpperCase(), head], [head, head.toUpperCase()], [head.toUpperCase(), head.toUpperCase()]])(
    'compares tested OID %s and current OID %s case-insensitively', (testedHead, currentHead) => {
      expect(decideMqSameHead({ pr, head: currentHead, timeline: timeline(removed('failed_checks', testedHead)) }).hold).toBe(true);
    });
  // Prevention owed: add recorded GitHub branch_protection_failure payloads here.
  // These null-beforeCommit fixtures are synthetic; this repair runs without live GitHub access.
  it('a server-timestamped force push cannot bind an old unbound failure to a different head', () => {
    for (const reason of ['ci_failure', 'branch_protection_failure', 'invalid_merge_commit']) {
      expectHold(decide(timeline({ ...removed(reason), beforeCommit: null }, pushed())), /no commit binding/i);
    }
  });
  it('property: any number of failures bound to older heads cannot hold a different current head', () => {
    // Deterministically vary heads, event counts, timestamps and payload order.
    for (let seed = 1; seed <= 64; seed++) {
      const currentHead = seed.toString(16).padStart(40, '0');
      const events = Array.from({ length: seed % 20 + 1 }, (_, i) => ({
        ...removed(i % 2 ? 'ci_failure' : 'branch_protection_failure', prior),
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      }));
      events.push(pushed(currentHead));
      if (seed % 2) events.reverse();
      expect(decideMqSameHead({ pr, head: currentHead, timeline: timeline(...events) })).toEqual(released);
    }
  });
  it.each([
    ['other head', pushed(prior)],
    ['same timestamp', pushed(head, '2026-11-01T12:00:00Z')],
    ['earlier push', pushed(head, '2026-11-01T11:00:00Z')],
    ['invalid push time', pushed(head, 'invalid')],
    ['missing prior binding', { ...pushed(), beforeCommit: null }],
    ['unchanged head', { ...pushed(), beforeCommit: { oid: head } }],
  ])('an unbound failure still holds with insufficient head-change proof: %s', (_label, event) => {
    expectHold(decide(timeline({ ...removed(), beforeCommit: null }, event)), /no commit binding/i);
  });
  it.each([undefined, 'invalid', '2026-11-01T14:00:00Z'])('an unbound failure with missing/invalid/newer time %s still holds', createdAt => {
    expectHold(decide(timeline({ ...removed(), beforeCommit: null, createdAt }, pushed())), /no commit binding/i);
  });
  it('a head-change event cannot erase a bound failure on this head or a later unbound failure', () => {
    expectHold(decide(timeline(pushed(), removed())), /failed_checks/);
    expectHold(decide(timeline({ ...removed(), beforeCommit: null }, pushed(),
      { ...removed(), beforeCommit: null, createdAt: '2026-11-01T14:00:00Z' })), /no commit binding/i);
    expectHold(decide(timeline(pushed(head.toUpperCase()), { ...removed(), beforeCommit: null })), /no commit binding/i);
  });
  it('restoring a previously failed head does not erase its unbound failure', () => {
    const away = { ...pushed(prior, '2026-11-01T12:30:00Z'), beforeCommit: { oid: head } };
    const failure = { ...removed(), beforeCommit: null };
    // An already-observed head at failure time is not a new head when it is restored later.
    expectHold(decide(timeline(pushed(head, '2026-11-01T11:00:00Z'), failure, away, pushed())), /no commit binding/i);
    // Nor can the first observation being a push AWAY from this head prove it was new later.
    expectHold(decide(timeline(failure, away, pushed())), /no commit binding/i);
    // A failure between the first introduction and a later restoration also stays held.
    expectHold(decide(timeline(pushed(head, '2026-11-01T11:00:00Z'), failure, pushed())), /no commit binding/i);
  });
  it('restoring a failed head after an invisible fast-forward detour retains its hold', () => {
    // H -> J is a fast-forward, so the filtered timeline only records J -> H.
    const failure = { ...removed('failed_checks'), beforeCommit: null };
    expectHold(decide(timeline(failure, pushed())), /no commit binding/i);
  });
  it.each([null, { error: 'API unavailable' }, {}, { nodes: null }, { nodes: {} }])('unreadable timeline %j holds', evidence => {
    expectHold(decide(evidence), /unreadable/i);
  });
  it('hasPreviousPage holds at the 100-event cap and exposes the incomplete timeline', () => {
    expectHold(decide({ nodes: Array.from({ length: 100 }, () => added), hasPreviousPage: true }), /cap|truncat|incomplete|previous/i);
  });
  it.each([null, { parents: { nodes: [] } }, { parents: { nodes: [{ oid: head }] } }])('an unbound failure removal holds with no commit binding (%j)', beforeCommit => {
    expectHold(decide(timeline({ ...removed(), beforeCommit })), /no commit binding/i);
  });
  it.each(['', undefined, null, 'invalid', 'g'.repeat(40), `${head}\n`])('an empty, missing or malformed head %s holds', missingHead => {
    const result = decideMqSameHead({ pr, head: missingHead, timeline: timeline() });
    expect(result.hold).toBe(true);
    expect(result.line).toMatch(/head/i);
  });

  it('readMqTimeline issues exactly one gh graphql call with last:100 and reads the second-parent binding and cap', () => {
    const evidence = { nodes: [removed(), added, pushed()], hasPreviousPage: true };
    const exec = vi.fn(() => response(evidence));
    expect(readMqTimeline({ repo, pr, exec })).toEqual(evidence);
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, opts] = exec.mock.calls[0];
    expect(command).toBe('gh');
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).not.toContain('--paginate');
    const query = args.find(arg => arg.startsWith('query='));
    expect(query).toBeDefined();
    const compact = query.replace(/\s+/g, '');
    expect(compact).toMatch(/timelineItems\(last:100,itemTypes:\[REMOVED_FROM_MERGE_QUEUE_EVENT,ADDED_TO_MERGE_QUEUE_EVENT,HEAD_REF_FORCE_PUSHED_EVENT\]\)/);
    expect(compact).toContain('pageInfo{hasPreviousPage}');
    expect(compact).toMatch(/\.\.\.onRemovedFromMergeQueueEvent\{/);
    expect(compact).toContain('beforeCommit{oidparents(first:2){nodes{oid}}}');
    expect(compact).toContain('reason');
    expect(compact).toContain('createdAt');
    expect(compact).toContain('...onHeadRefForcePushedEvent{createdAtbeforeCommit{oid}afterCommit{oid}}');
    // Arguments may use GraphQL variables or literals, but must identify this repo and PR.
    expect(args.join(' ')).toContain('fixture');
    expect(args.join(' ')).toContain('drain');
    expect(args.join(' ')).toContain('6215');
    expect(opts.encoding).toBe('utf8');
    expect(opts.timeout).toBeGreaterThan(0);
  });
  it.each([
    ['exec throws', () => { throw new Error('offline'); }],
    ['bad JSON', () => '{'],
    ['GraphQL errors with partial data', () => JSON.stringify({ ...JSON.parse(response(timeline())), errors: [{ message: 'denied' }] })],
    ['missing pull request', () => JSON.stringify({ data: { repository: { pullRequest: null } } })],
    ['malformed timeline nodes', () => response({ nodes: null, hasPreviousPage: false })],
  ])('unreadable timeline (%s) returns an error and the guard holds and logs it', (_label, read) => {
    const exec = withQueue(read);
    expect(readMqTimeline({ repo, pr, exec })).toEqual({ error: expect.any(String) });
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockClear();
    const log = vi.fn();
    const result = mqSameHeadGuard({ repo, pr, head, exec, log });
    expectHold(result, /unreadable/i);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual([[result.line]]);
  });
  it('mqSameHeadGuard composes the read and decision and logs the exact hold line', () => {
    const exec = withQueue(() => response(timeline(removed()))), log = vi.fn();
    const result = mqSameHeadGuard({ repo, pr, head, exec, log });
    expect(result).toEqual(decide(timeline(removed())));
    expect(exec).toHaveBeenCalledTimes(3); // Queue, timeline, then the unreadable infra-retry evidence read (fails closed).
    expect(log.mock.calls).toEqual([[result.line]]);
  });
  it('mqSameHeadGuard releases manual removal without logging a hold', () => {
    const exec = withQueue(() => response(timeline(removed('manual')))), log = vi.fn();
    expect(mqSameHeadGuard({ repo, pr, head, exec, log })).toEqual(released);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });
  it('a manual same-head retry already in the live queue bypasses historical failures', () => {
    const exec = vi.fn((_command, args) => args.some(arg => arg.includes('isInMergeQueue'))
      ? queueResponse(true) : response(timeline(removed()))), log = vi.fn();
    expect(mqSameHeadGuard({ repo, pr, head, exec, log })).toEqual(released);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1].join(' ')).toContain('isInMergeQueue');
    expect(log).not.toHaveBeenCalled();
  });
  it('fresh admission cannot bypass failures even when another membership read reports queued', () => {
    const exec = vi.fn((_command, args) => args.some(arg => arg.includes('isInMergeQueue'))
      ? queueResponse(true) : response(timeline(removed()))), log = vi.fn();
    expectHold(mqSameHeadGuard({ repo, pr, head, exec, log, allowAlreadyQueued: false }), /failed_checks/);
    expect(exec).toHaveBeenCalledTimes(3); // Queue, timeline, then the unreadable infra-retry evidence read.
    expect(log).toHaveBeenCalledTimes(1);
  });
  it.each([true, null, undefined, 'throws'])('mutation admission fails closed for decision %s', decision => {
    const sameHeadAdmission = vi.fn(() => {
      if (decision === 'throws') throw new Error('offline');
      return decision === true ? { hold: true, line: 'mq-same-head-failed: failed_checks' } : decision;
    });
    const exec = vi.fn((command, args) => {
      if (command === 'git') return `${prior}\trefs/heads/main\n`;
      if (args.includes('view')) return JSON.stringify({ id: 'P', headRefOid: head, baseRefName: 'main' });
      if (args.some(arg => arg.includes('isInMergeQueue'))) return queueResponse(false);
      throw new Error('unexpected mutation');
    });
    const result = enqueuePr({ repo, num: pr, headSha: head, cwd: '/fixture', exec, sameHeadAdmission,
      preparedSurface: { headSha: head, base: 'main', baseSha: prior, files: ['README.md'] } });
    expect(result).toMatchObject({ ok: false, held: true, reason: 'mq-same-head-failed' });
    expect(sameHeadAdmission).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.some(([, args]) => args.some(arg => arg.includes('enqueuePullRequest')))).toBe(false);
  });
  it('stable queued membership permits bookkeeping without consulting fresh mutation admission', () => {
    const sameHeadAdmission = vi.fn(() => { throw new Error('must not run for bookkeeping'); });
    const exec = vi.fn((command, args) => {
      if (command === 'git') return `${prior}\trefs/heads/main\n`;
      if (args.includes('view')) return JSON.stringify({ id: 'P', headRefOid: head, baseRefName: 'main' });
      if (args.some(arg => arg.includes('isInMergeQueue'))) return queueResponse(true);
      throw new Error('unexpected mutation');
    });
    expect(enqueuePr({ repo, num: pr, headSha: head, cwd: '/fixture', exec, sameHeadAdmission,
      preparedSurface: { headSha: head, base: 'main', baseSha: prior, files: ['README.md'] } })).toEqual({ ok: true, already: true });
    expect(sameHeadAdmission).not.toHaveBeenCalled();
  });
  it.each([
    ['moved head', () => queueResponse(true, prior)],
    ['missing head', () => queueResponse(true, null)],
    ['malformed membership', () => queueResponse(null)],
    ['failed read', () => { throw new Error('offline'); }],
  ])('unreadable or mismatched live queue state holds: %s', (_label, read) => {
    const exec = vi.fn(read), log = vi.fn();
    expectHold(mqSameHeadGuard({ repo, pr, head, exec, log }), /live.*queue|queue.*state/i);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
const bot = { author: { login: 'web-everything' } };
const clean = (rev = head, login = 'web-everything', findings = []) => ({ author: { login }, body: renderRedTeamComment({ pr: 5283, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const hold = (over = {}) => redTeamEnqueueHold({ scheduled: over.loopPayload !== null && over.loopPayload?.verdict?.verdict !== 'needs-human', loopPayload: { verdict: { verdict: 'accept' } }, labels: ['review:accepted'], comments: [], pr: 5283, head, env: {}, ...over });
const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
const gate = (sha, outcome) => ({ ...bot, body: redTeamGateMarker(5283, sha, outcome) });
// The comment shapes review-set-label renders: `clear-human` (heading first, markers last), `restamp`, plain accept.
const human = { author: { login: 'chalbert' } };
const accept = (sha, cleared = false, who = cleared ? human : bot) => ({ ...who, body: cleared
  ? ['✅ review — `review:human` cleared via the sanctioned path', '', 'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '', buildReviewedShaMarker(sha), buildClearedHumanMarker('operator')].join('\n')
  : ['✅ review — accepted', '', buildReviewedShaMarker(sha)].join('\n') });
const restamp = sha => ({ ...bot, body: ['📌 review — acceptance re-stamped after a rebase (no new review)', '', buildReviewedShaMarker(sha), buildClearedHumanMarker('operator')].join('\n') });
// The exact body review-job.mjs posts when carryAcrossRebase moves a verdict from `from` to `to`.
const carry = ({ from = prior, to = head, findings = [], gates = [], author = bot.author } = {}) => ({ author, body: [
  ...gates.map(o => redTeamGateMarker(5283, to, o)),
  buildVerdictCarriedMarker({ fromSha: from, toSha: to, patchId: 'c'.repeat(40) }),
  'Review verdict carried across an identical contribution.',
  clean(from, 'web-everything', findings).body.replace(redTeamMarker(5283, from), redTeamMarker(5283, to))].join('\n') });

describe('carried red-team result (review-job carryAcrossRebase)', () => {
  it('a trusted carried clean result releases the new head', () => {
    expect(hold({ comments: [clean(prior), carry()] })).toBeNull();
  });
  it('ignores an untrusted carry and a carry keyed to another head', () => {
    expect(hold({ comments: [carry({ author: { login: 'attacker' } })] })).toMatch(/no recorded result/);
    expect(hold({ comments: [carry({ to: 'd'.repeat(40) })] })).toMatch(/no recorded result/);
  });
  it('a carried sent-back break still holds', () => {
    expect(hold({ comments: [carry({ findings: broken, gates: ['sent-back'] })] })).toMatch(/requiring send-back/);
  });
  it('normalizes CRLF and recognizes matching gate preambles', () => {
    const record = carry({ gates: ['card-queued', 'round-cap'] });
    expect(hold({ comments: [{ ...record, body: record.body.replaceAll('\n', '\r\n') }] })).toBeNull();
  });
  it.each([
    ['quoted', record => `quoting:\n${record.body}`],
    ['missing producer prose', record => record.body.replace('Review verdict carried across an identical contribution.\n', '')],
    ['interposed prose', record => record.body.replace('<!-- we:red-team-advisory', 'quoted result:\n<!-- we:red-team-advisory')],
    ['mismatched advisory head', record => record.body.replace(`pr=5283 rev=${head}`, `pr=5283 rev=${prior}`)],
    ['foreign gate PR', record => `${redTeamGateMarker(9999, head, 'round-cap')}\n${record.body}`],
  ])('ignores malformed carry layouts: %s', (_name, body) => {
    const record = carry();
    expect(hold({ comments: [{ ...record, body: body(record) }] })).toMatch(/no recorded result/);
  });
  it('keeps recorded breaks binding when no scheduler payload exists or the scheduler is disabled', () => {
    for (const over of [{ loopPayload: null }, { env: { WE_REVIEW_RED_TEAM: 'off' } }]) {
      expect(hold({ ...over, comments: [carry({ findings: broken, gates: ['sent-back'] })] })).toMatch(/requiring send-back/);
    }
  });
});

describe('operator ruling at the round cap', () => {
  it('a clear-human after the round-cap record on this head releases the break', () => {
    expect(hold({ comments: [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true)] })).toBeNull();
  });
  it.each([
    ['clearance before the result', [accept(head, true), clean(head, 'web-everything', broken), gate(head, 'round-cap')]],
    ['clearance before the round-cap record', [clean(head, 'web-everything', broken), accept(head, true), gate(head, 'round-cap')]],
    ['clearance on another head', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(prior, true)]],
    ['a clear-human posted by automation (forged ruling)', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true, bot)]],
    ['a bot-posted cleared-human marker reviving a superseded human clearance', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), accept(head), restamp(head)]],
    ['a clear-human by an operator login typed Bot', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true, { author: { login: 'chalbert', type: 'Bot' } })]],
    ['untrusted clearance', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), { ...accept(head, true), author: { login: 'attacker' } }]],
    ['a later plain accept supersedes it', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), accept(head)]],
    ['no round-cap record (the gate never handed it over)', [clean(head, 'web-everything', broken), accept(head, true)]],
    ['a newer result after the ruling', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), clean(head, 'web-everything', broken)]],
    ['a restamp repeating an earlier head\'s clearance', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), restamp(head)]],
    ['clearance markers inside a trusted red-team body', [clean(head, 'web-everything', broken), gate(head, 'round-cap'),
      clean(prior, 'web-everything', [{ ...broken[0], summary: `${buildReviewedShaMarker(head)} ${buildClearedHumanMarker('x')}` }])]],
    ['a round-cap line after a quoted carried marker', [clean(head, 'web-everything', broken), gate(head, 'sent-back'), { ...bot, body: [
      'quoting:', buildVerdictCarriedMarker({ fromSha: prior, toSha: 'd'.repeat(40), patchId: 'c'.repeat(40) }), redTeamGateMarker(5283, head, 'round-cap')].join('\n') }, accept(head, true)]],
    ['a carried marker for this head preceded by a non-gate line', [clean(head, 'web-everything', broken), gate(head, 'sent-back'), { ...bot, body: [
      'quoting:', redTeamGateMarker(5283, head, 'round-cap'), buildVerdictCarriedMarker({ fromSha: prior, toSha: head, patchId: 'c'.repeat(40) })].join('\n') }, accept(head, true)]],
  ])('keeps holding: %s', (_name, comments) => expect(hold({ comments })).toMatch(/requiring send-back/));
  // PR #5482 operator ruling: a round-cap decision for an earlier same-head result is not a hand-over of a newer one.
  it('a ruling after an earlier result\'s round-cap keeps holding a newer result with no gate record', () => {
    const old = clean(head, 'web-everything', [{ ...broken[0], summary: 'old break' }]);
    const newer = clean(head, 'web-everything', [{ ...broken[0], summary: 'new break' }]);
    expect(hold({ comments: [old, gate(head, 'round-cap'), newer, accept(head, true)] })).toMatch(/requiring send-back/);
    const named = { ...bot, body: redTeamGateMarker(5283, head, 'round-cap', redTeamResultId(parseRedTeamComment(old.body))) };
    expect(hold({ comments: [old, newer, named, accept(head, true)] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [old, newer, { ...named, body: redTeamGateMarker(5283, head, 'round-cap', redTeamResultId(parseRedTeamComment(newer.body))) }, accept(head, true)] })).toBeNull();
  });
  it('two raced gate runs (sent-back and round-cap on one result): the cap wins and the ruling releases it', () => {
    const result = clean(head, 'web-everything', broken);
    const sent = { ...bot, body: `${redTeamGateMarker(5283, head, 'sent-back')}\n- 1 confirmed break(s) sent back to the fixer (#1).` };
    expect(hold({ comments: [result, gate(head, 'round-cap'), sent] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [result, gate(head, 'round-cap'), sent, accept(head, true)] })).toBeNull();
  });
  it('a carry hop applies prior-head decisions only when the prior result is the one carried', () => {
    const findings = [{ ...broken[0], impactIfUnfixed: 'degraded' }, { ...broken[0], summary: 'carried break' }];
    const priorOther = clean(prior, 'web-everything', [broken[0], { ...broken[0], summary: 'another break' }]);
    const advisory = { ...bot, body: `${redTeamGateMarker(5283, prior, 'card-queued')}\n- 2 finding(s) left advisory (#1, #2).` };
    expect(hold({ comments: [clean(prior, 'web-everything', findings), advisory, restamp(head), carry({ findings, gates: ['card-queued'] })] })).toBeNull();
    expect(hold({ comments: [priorOther, advisory, restamp(head), carry({ findings, gates: ['card-queued'] })] })).toMatch(/requiring send-back/);
    const ruled = [priorOther, gate(prior, 'round-cap'), accept(prior, true), restamp(head), carry({ findings, gates: ['round-cap'] })];
    expect(hold({ comments: ruled })).toMatch(/requiring send-back/);
  });
  it('a ruling on the prior head survives a proven carry (restamped clearance, carried round-cap and result)', () => {
    const ruledOnPrior = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true)];
    expect(hold({ comments: [...ruledOnPrior, restamp(head), carry({ findings: broken, gates: ['round-cap'] })] })).toBeNull();
  });
  it('a plain accept of the carried head supersedes the prior head ruling; a bot cleared-human marker cannot revive it', () => {
    const ruledOnPrior = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true)];
    const carried = [...ruledOnPrior, restamp(head), carry({ findings: broken, gates: ['round-cap'] })];
    expect(hold({ comments: carried })).toBeNull();
    expect(hold({ comments: [...carried, accept(head), restamp(head)] })).toMatch(/requiring send-back/);
  });
  it('a carry cannot revive a ruling superseded by a plain accept on its original head', () => {
    const h1 = 'b'.repeat(40);
    const comments = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true), accept(prior)];
    expect(hold({ head: prior, comments })).toMatch(/requiring send-back/);
    comments.push(restamp(h1));
    expect(hold({ head: h1, comments })).toMatch(/no recorded result/);
    comments.push(carry({ to: h1, findings: broken, gates: ['round-cap'] }));
    expect(hold({ head: h1, comments })).toMatch(/requiring send-back/);
  });
  it.each([
    ['original head before its carry', prior, 3],
    ['original head after its carry', prior, 5],
    ['original head after all carries', prior, 7],
    ['intermediate head before its carry', 'e'.repeat(40), 5],
    ['intermediate head after its carry', 'e'.repeat(40), 7],
    ['live head after all carries', head, 7],
  ])('keeps a superseded ruling held across a carry chain: %s', (_name, acceptedSha, at) => {
    const intermediate = 'e'.repeat(40);
    const comments = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true),
      restamp(intermediate), carry({ to: intermediate, findings: broken, gates: ['round-cap'] }),
      restamp(head), carry({ from: intermediate, findings: broken, gates: ['round-cap'] })];
    comments.splice(at, 0, accept(acceptedSha));
    comments.push(restamp(head));
    expect(hold({ comments })).toMatch(/requiring send-back/);
    expect(hold({ comments: [...comments, gate(head, 'round-cap'), accept(head, true)] })).toBeNull();
  });
  // The marker builder/parser accept abbreviated SHAs (7–40 hex), so an abbreviated plain accept supersedes too.
  it.each([
    ['7-char', 7], ['12-char', 12], ['39-char', 39], ['upper-case 12-char', 12, true],
  ])('an abbreviated (%s) plain accept supersedes the ruling; a bot restamp cannot revive it', (_name, len, upper) => {
    const short = sha => (upper ? sha.slice(0, len).toUpperCase() : sha.slice(0, len));
    const ruled = [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true)];
    expect(hold({ comments: [...ruled, accept(short(head))] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [...ruled, accept(short(head)), restamp(head)] })).toMatch(/requiring send-back/);
    const carried = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true), accept(short(prior)),
      restamp(head), carry({ findings: broken, gates: ['round-cap'] }), restamp(head)];
    expect(hold({ comments: carried })).toMatch(/requiring send-back/);
  });
  it('a plain accept with an upper-case marker name still supersedes the ruling', () => {
    const upperName = { ...bot, body: `✅ review — accepted\n\n<!-- REVIEWED-SHA: ${head} -->` };
    expect(hold({ comments: [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), upperName, restamp(head)] }))
      .toMatch(/requiring send-back/);
  });
  it('an abbreviated plain accept of an unrelated head does not supersede a ruling', () => {
    const comments = [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), accept('f'.repeat(12)), restamp(head)];
    expect(hold({ comments })).toBeNull();
  });
  it('a plain accept on an unrelated head does not supersede a carried ruling', () => {
    const comments = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true),
      accept('f'.repeat(40)), restamp(head), carry({ findings: broken, gates: ['round-cap'] })];
    expect(hold({ comments })).toBeNull();
  });
  it('a ruling survives a chain of carries (H0 → H1 → head)', () => {
    const h0 = 'e'.repeat(40);
    const ruledOnH0 = [clean(h0, 'web-everything', broken), gate(h0, 'round-cap'), accept(h0, true)];
    const toPrior = [restamp(prior), carry({ from: h0, to: prior, findings: broken, gates: ['round-cap'] })];
    expect(hold({ comments: [...ruledOnH0, ...toPrior, restamp(head), carry({ findings: broken, gates: ['round-cap'] })] })).toBeNull();
    expect(hold({ comments: [clean(h0, 'web-everything', broken), gate(h0, 'round-cap'), ...toPrior, restamp(head), carry({ findings: broken, gates: ['round-cap'] })] })).toMatch(/requiring send-back/);
  });
  it('a carry never invents a ruling the prior head did not have', () => {
    expect(hold({ comments: [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), restamp(head), carry({ findings: broken, gates: ['round-cap'] })] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true), accept(head), carry({ findings: broken, gates: ['round-cap'] })] })).toMatch(/requiring send-back/);
  });
  it('preserves a ruling through more than sixteen identical-contribution carries', () => {
    const comments = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true)];
    let from = prior;
    for (let i = 1; i <= 18; i++) {
      const to = i === 18 ? head : i.toString(16).padStart(40, '0');
      comments.push(restamp(to), carry({ from, to, findings: broken, gates: ['round-cap'] }));
      from = to;
    }
    expect(hold({ comments })).toBeNull();
  });
});

describe('operator ruling needs a human operator author (forged automation records)', () => {
  const human = { author: { login: 'chalbert' } };
  const capped = () => ({ ...gate(head, 'round-cap'), body: `${gate(head, 'round-cap').body}\n- 1 confirmed break(s) NOT sent back: review round 5 has reached the round cap (5). The operator rules on them.` });
  const record = (who, outcome, line) => ({ ...who, body: `${redTeamGateMarker(5283, head, outcome)}\n${line}` });
  const base = () => [clean(head, 'web-everything', broken), capped()];
  it('keeps the drain hold for an automation-authored operator-not-real or card-pending record', () => {
    expect(hold({ comments: [...base(), record(bot, 'operator-not-real', '- 1 finding(s) left advisory (#1).')] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [...base(), record(bot, 'card-pending', '- 1 finding(s) filed as a follow-up card (#1).')] })).toMatch(/requiring send-back/);
  });
  it('releases for a human-authored operator-card record', () => {
    expect(hold({ comments: [...base(), record(human, 'operator-card', '- 1 finding(s) filed as a follow-up card (#1).')] })).toBeNull();
  });
});

describe('durable head-bound red-team admission', () => {
  it('waits without a result; ignores stale, foreign-PR and untrusted markers', () => {
    expect(hold()).toMatch(/no recorded result/);
    expect(hold({ comments: [clean('a'.repeat(40)), clean(head, 'attacker'), { ...clean(), body: clean().body.replace('pr=5283', 'pr=5284') }] })).toMatch(/no recorded result/);
    expect(hold({ comments: [clean()] })).toBeNull();
  });
  it('waits for owed results and follows a recorded send-back', () => {
    expect(hold({ labels: ['advisory:accepted'] })).toMatch(/no recorded result/);
    const findings = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
    expect(hold({ comments: [clean(head, 'web-everything', findings), gate(head, 'sent-back')] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [clean(head, 'web-everything', findings), gate(head, 'sent-back')], confirmedBreaks: { broken: 'advisory', degraded: 'card', unconfirmed: 'advisory' } })).toBeNull();
  });
  it('does not apply earlier-result card actions to newer same-head findings', () => {
    const earlier = clean(head, 'web-everything', [{ ...broken[0], summary: 'old break' }]);
    const carded = { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- 1 finding(s) filed as a follow-up card (#1) — landing job s1.` };
    const newer = clean(head, 'web-everything', [{ ...broken[0], summary: 'new break' }]);
    expect(hold({ comments: [earlier, carded] })).toBeNull();
    expect(hold({ comments: [earlier, carded, newer] })).toMatch(/requiring send-back/);
    const dated = (c, at) => ({ ...c, createdAt: at });
    expect(hold({ comments: [dated(carded, '2026-10-17T10:00:00Z'), dated(newer, '2026-10-17T11:00:00Z')] })).toMatch(/requiring send-back/);
  });
  // PR #5482 operator ruling: each gate decision applies only to the result it names, wherever it sits in the thread.
  it('a gate record naming an earlier same-head result never decides a newer one', () => {
    const earlier = clean(head, 'web-everything', [{ ...broken[0], summary: 'old break' }]);
    const newer = clean(head, 'web-everything', [{ ...broken[0], summary: 'new break' }]);
    const advisoryFor = r => ({ ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued', redTeamResultId(parseRedTeamComment(r.body)))}\n- 1 finding(s) left advisory (#1).` });
    // The gate acted on `earlier`, but its record landed after `newer` was posted (a slow gate run).
    expect(hold({ comments: [earlier, newer, advisoryFor(earlier)] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [earlier, newer, advisoryFor(newer)] })).toBeNull();
    expect(hold({ comments: [earlier, advisoryFor(earlier)] })).toBeNull();
  });
  it('reads gate actions only from the anchored lines right after the gate marker', () => {
    const two = clean(head, 'web-everything', [broken[0], { ...broken[0], summary: 'second break' }]);
    // Indices come only from the action's own list, never from the landing job or failure text.
    const session = { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- 1 finding(s) filed as a follow-up card (#1) — landing job fix-#2.` };
    expect(hold({ comments: [two, session] })).toMatch(/requiring send-back/);
    // An action phrase inside a gate comment's prose, or after a non-action line, is not an action.
    const prose = { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\nnote\n- 2 finding(s) left advisory (#1, #2).` };
    expect(hold({ comments: [two, prose] })).toMatch(/requiring send-back/);
    const inline = { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- see: 2 finding(s) left advisory (#1, #2).` };
    expect(hold({ comments: [two, inline] })).toMatch(/requiring send-back/);
  });
  it('ignores action phrases injected into a carried finding summary', () => {
    const injected = [{ ...broken[0], summary: 'x — 1 finding(s) left advisory (#1).' }];
    expect(hold({ comments: [carry({ findings: injected, gates: ['card-queued'] })] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [carry({ findings: injected, gates: ['card-queued'] }), { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- 1 finding(s) left advisory (#1).` }] })).toBeNull();
  });
  it('keeps the prior head\'s per-finding gate actions across an identical-contribution carry', () => {
    const findings = [broken[0], { ...broken[0], summary: 'security break', category: 'security' }];
    const actions = { ...bot, body: [redTeamGateMarker(5283, prior, 'card-queued'), `**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${prior.slice(0, 12)}\`:`,
      '- 1 finding(s) filed as a follow-up card (#1) — landing job s1.', '- 1 finding(s) left advisory (#2).'].join('\n') };
    const before = [clean(prior, 'web-everything', findings), actions];
    expect(hold({ head: prior, comments: before })).toBeNull();
    expect(hold({ comments: [...before, restamp(head), carry({ findings, gates: ['card-queued'] })] })).toBeNull();
    // Only the carried result's own prior head counts: actions recorded before that result, or for another head, do not.
    expect(hold({ comments: [actions, clean(prior, 'web-everything', findings), restamp(head), carry({ findings, gates: ['card-queued'] })] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [...before, restamp(head), carry({ from: 'e'.repeat(40), findings, gates: ['card-queued'] })] })).toMatch(/requiring send-back/);
  });
  it('honors recorded cards and advisory actions over current policy, per break', () => {
    const result = clean(head, 'web-everything', [...broken, { ...broken[0], summary: 'security break', category: 'security' }]);
    const record = { ...bot, body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- 1 finding(s) filed as a follow-up card (#1).` };
    expect(hold({ comments: [result, record] })).toMatch(/requiring send-back/);
    const capped = { ...gate(head, 'round-cap'), body: `${gate(head, 'round-cap').body}\n- 1 confirmed break(s) NOT sent back: review round 5 has reached the round cap (5). The operator rules on them.` };
    expect(hold({ comments: [result, capped, record] })).toMatch(/requiring send-back/);
    const advisory = { ...record, body: `${record.body}\n- 1 finding(s) left advisory (#2).` };
    expect(hold({ comments: [result, advisory] })).toBeNull();
    expect(hold({ comments: [result, capped, advisory] })).toBeNull();
  });
  it.each([
    ['no gate record', []],
    ['a gate record for another head', [gate(prior, 'card-queued')]],
    ['a gate record for another PR', [{ ...gate(head, 'card-queued'), body: redTeamGateMarker(9999, head, 'card-queued') }]],
    ['an untrusted gate record', [{ ...gate(head, 'card-queued'), author: { login: 'attacker' } }]],
    ['a gate outcome without per-finding actions', [gate(head, 'card-queued')]],
    ['a failed card action', [{ ...gate(head, 'card-queued'), body: `${redTeamGateMarker(5283, head, 'card-queued')}\n- 1 finding(s) filed as a follow-up card (#1). FILING FAILED` }]],
  ])('holds a confirmed break with no recorded action: %s', (_name, gates) => {
    expect(hold({ comments: [clean(head, 'web-everything', broken), ...gates] })).toMatch(/requiring send-back/);
  });
  it('holds a carried confirmed break without a recorded gate action, even when no run is owed', () => {
    for (const over of [{}, { scheduled: false, loopPayload: null }, { env: { WE_REVIEW_RED_TEAM: 'off' } }]) {
      expect(hold({ ...over, comments: [carry({ findings: broken })] })).toMatch(/requiring send-back/);
    }
  });
  it.each([undefined, 'unknown'])('holds a confirmed security break with %s impact and no gate action', impactIfUnfixed => {
    const findings = [{ ...broken[0], category: 'security', impactIfUnfixed }];
    expect(hold({ comments: [clean(head, 'web-everything', findings)] })).toMatch(/requiring send-back/);
  });
  it.each(['WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])('does not owe a pass with %s off', key => {
    expect(hold({ scheduled: false, env: { [key]: '0' } })).toBeNull();
    expect(hold({ scheduled: true, env: { [key]: '0' } })).toMatch(/no recorded result/);
  });
  it.each([5439, 5443])('labels alone do not schedule a red team for #%s', pr => {
    expect(hold({ pr, loopPayload: null, labels: ['review:accepted', 'ready-to-merge'] })).toBeNull();
    expect(hold({ pr, loopPayload: { verdict: { verdict: 'needs-human' } } })).toBeNull();
  });
  it('does not owe a pass without a panel accept', () => expect(hold({ loopPayload: null, labels: ['ready-to-merge'] })).toBeNull());
  // PR #5482 red team: the card-only exemption ignored WE_RED_TEAM_SKIP_CARD_ONLY=false and a pass already running.
  it('exempts a card-only head only while the producer skips it; a started pass is always awaited', () => {
    const loopPayload = { verdict: { verdict: 'accept' }, findings: { read: { netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] } } };
    expect(hold({ loopPayload })).toBeNull();
    expect(hold({ loopPayload, env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' } })).toMatch(/no recorded result/);
    expect(hold({ loopPayload, env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, inFlight: true })).toMatch(/no recorded result/);
    expect(hold({ loopPayload, scheduled: false, inFlight: true })).toMatch(/no recorded result/);
    expect(hold({ loopPayload, scheduled: false, recorded: true })).toMatch(/no recorded result/);
    expect(hold({ loopPayload, env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, comments: [clean()] })).toBeNull();
  });
});

describe('drain policy cascade', () => {
  it('defaults queueRebuildMax to three and logs standard provenance', () => {
    const lines = [];
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log: l => lines.push(l) });
    expect(r.value.queueRebuildMax).toBe(3);
    expect(r.sources.queueRebuildMax).toBe('standard');
    expect(lines.join('')).toContain('queueRebuildMax=3 (standard)');
  });
  it('resolves queueRebuildMax through platform, tool and environment and logs the effective source', () => {
    const lines = [];
    const platform = { queueRebuildMax: 5 };
    const tool = { queueRebuildMax: 4 };
    const r = readDrainQueueSafety({ env: { WE_DRAIN_QUEUE_REBUILD_MAX: '2' }, tool, platform, log: l => lines.push(l) });
    expect(r.value.queueRebuildMax).toBe(2);
    expect(r.sources.queueRebuildMax).toBe('env');
    expect(lines.join('')).toContain('queueRebuildMax=2 (env)');
    expect(readDrainQueueSafety({ env: {}, tool, platform })).toMatchObject({ value: { queueRebuildMax: 4 }, sources: { queueRebuildMax: 'tool' } });
    expect(readDrainQueueSafety({ env: {}, tool: {}, platform })).toMatchObject({ value: { queueRebuildMax: 5 }, sources: { queueRebuildMax: 'platform' } });
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', 'typo'])('invalid queue rebuild env %s falls back to the next valid layer', value => {
    const env = { WE_DRAIN_QUEUE_REBUILD_MAX: value };
    expect(readDrainQueueSafety({ env, tool: { queueRebuildMax: 4 }, platform: {} }))
      .toMatchObject({ value: { queueRebuildMax: 4 }, sources: { queueRebuildMax: 'tool' } });
    expect(readDrainQueueSafety({ env, tool: {}, platform: {} }))
      .toMatchObject({ value: { queueRebuildMax: 3 }, sources: { queueRebuildMax: 'standard' } });
  });
  it('defaults both safeguards on and logs their sources', () => {
    const lines = [];
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log: l => lines.push(l) });
    expect(r.value).toMatchObject({ waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true });
    expect(r.sources).toMatchObject({ waitForRedTeamBeforeEnqueue: 'standard', dequeueOnSendBack: 'standard' });
    expect(lines.join('')).toContain('dequeueOnSendBack=true (standard)');
    expect(r.value).toMatchObject({ redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 });
    // Retired: no standard value lets a deadline enqueue an owed head without a red-team result.
    expect(r.value.enqueueWhenRedTeamNeverScheduled).toBeUndefined();
    expect(lines.join('')).not.toContain('enqueueWhenRedTeamNeverScheduled');
    expect(lines.join('')).toContain('redTeamPendingBackoffSec=300 (standard)');
    expect(lines.join('')).toContain('redTeamPendingMaxMin=45 (standard)');
  });
  it('names a leftover enqueueWhenRedTeamNeverScheduled (env or setting) as retired and ignored', () => {
    const lines = [];
    readDrainQueueSafety({ env: { WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'true' }, tool: { enqueueWhenRedTeamNeverScheduled: true }, platform: {}, log: l => lines.push(l) });
    expect(lines.join('')).toContain('env WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED and drain.enqueueWhenRedTeamNeverScheduled setting is retired and ignored');
  });
  it('resolves pending timing and provenance independently, rejecting invalid timings', () => {
    const r = readDrainQueueSafety({ env: { WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC: '600', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: 'NaN' },
      platform: { redTeamPendingBackoffSec: 120, redTeamPendingMaxMin: 90 },
      tool: { redTeamPendingBackoffSec: 180, redTeamPendingMaxMin: 60 } });
    expect(r.value).toMatchObject({ redTeamPendingBackoffSec: 600, redTeamPendingMaxMin: 60 });
    expect(r.sources).toMatchObject({ redTeamPendingBackoffSec: 'env', redTeamPendingMaxMin: 'tool' });
    expect(r.invalid).toHaveLength(1);
    const invalid = readDrainQueueSafety({ env: {}, tool: { redTeamPendingBackoffSec: 0, redTeamPendingMaxMin: -1 }, platform: {} });
    expect(invalid.value).toMatchObject({ redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 });
    expect(invalid.invalid).toHaveLength(2);
    expect(readDrainQueueSafety({ env: {}, tool: {}, platform: { redTeamPendingMaxMin: 90 } }).sources.redTeamPendingMaxMin).toBe('platform');
  });
  it('resolves platform then tool then env independently, rejecting invalid values', () => {
    const r = readDrainQueueSafety({ env: { WE_DRAIN_DEQUEUE_ON_SEND_BACK: 'off', WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'typo' }, platform: { waitForRedTeamBeforeEnqueue: false }, tool: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: 'invalid' } });
    expect(r.value).toMatchObject({ waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: false });
    expect(r.sources).toMatchObject({ waitForRedTeamBeforeEnqueue: 'tool', dequeueOnSendBack: 'env' });
    expect(r.invalid).toHaveLength(2);
    expect(readDrainQueueSafety({ env: {}, tool: {}, platform: { dequeueOnSendBack: false } }).sources.dequeueOnSendBack).toBe('platform');
  });
});

function queueIo({ confirm = true, errors = false, membershipError = false } = {}) {
  let queued = true;
  const calls = [], logs = [];
  const exec = (_cmd, args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ id: 'PR_5283' });
    if (args[1] === 'comment') return '';
    if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify(membershipError ? { errors: [{ message: 'unavailable' }] } : { data: { repository: { pullRequest: { isInMergeQueue: queued, headRefOid: head } } } });
    if (args.some(a => a.includes('dequeuePullRequest'))) {
      if (confirm) queued = false;
      return JSON.stringify(errors ? { errors: [{ message: 'refused' }] } : { data: { dequeuePullRequest: { clientMutationId: null } } });
    }
    throw new Error(`unexpected args ${args}`);
  };
  return { calls, logs, remove: () => dequeueSentBack({ repo: 'web-everything/web-everything', pr: 5283, reason: 'state is review:changes', exec, log: l => logs.push(l) }) };
}

describe('confirmed dequeue', () => {
  it('mutates once, confirms membership, logs and comments once across retries', () => {
    const q = queueIo();
    expect(q.remove()).toEqual({ dequeued: true });
    expect(q.remove()).toEqual({ dequeued: false });
    expect(q.calls.filter(a => a.some(v => v.includes('dequeuePullRequest')))).toHaveLength(1);
    const comment = q.calls.findIndex(a => a[1] === 'comment');
    expect(q.calls[comment - 1].join(' ')).toContain('isInMergeQueue');
    expect(q.calls.filter(a => a[1] === 'comment')).toHaveLength(1);
    expect(q.calls[comment].join(' ')).toContain('review:changes');
    expect(q.logs.join('')).toContain('isInMergeQueue=false');
  });
  it.each([{ confirm: false }, { errors: true }, { membershipError: true }])('never claims success on refusal or unreadable/unconfirmed membership: %j', opts => {
    const q = queueIo(opts);
    expect(() => q.remove()).toThrow();
    expect(q.calls.some(a => a[1] === 'comment')).toBe(false);
    expect(q.logs).toHaveLength(0);
  });
  it.each(['review:changes', 'review:human', 'review:pending'])('recognizes %s even if ready remains', label => expect(sendBackReason([label, 'ready-to-merge'])).toContain(label));
  it('recognizes red-team:blocked even if ready remains', () => expect(sendBackReason(['red-team:blocked', 'ready-to-merge'])).toContain('red-team:blocked'));
  it('pending alone is an admission hold rather than a send-back', () => {
    expect(sendBackReason(['red-team:pending', 'ready-to-merge'])).toBeNull();
    expect(sendBackReason(['red-team:pending'])).toContain('ready-to-merge');
    expect(sendBackReason(['red-team:pending', 'ready-to-merge', 'review:changes'])).toContain('review:changes');
  });
  it('allows ready-to-merge with red-team:clear', () => {
    expect(sendBackReason(['ready-to-merge', 'red-team:clear'])).toBeNull();
  });
  it('recognizes ready removal and leaves ready accepted PRs alone', () => {
    expect(sendBackReason([])).toContain('ready-to-merge');
    expect(sendBackReason(['review:accepted', 'ready-to-merge'])).toBeNull();
  });
});
