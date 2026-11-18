// @vitest-environment node
// R622: the review side saw "red-team result already on head" while the drain held the same head as
// unknown run evidence (review-unfinished / scan-capped). A trusted result comment bound to the exact
// head settles those two reasons; a recorded break still sends back; missing evidence still fails closed.
import { describe, expect, it, vi } from 'vitest';
import { readDrainRedTeamEvidence, settleUnknownEvidenceByComment, UNREAD_SETTLE_MARGIN_MS, RUN_MTIME_SLACK_MS } from '../drain-red-team-evidence.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

// The real operator feed and daemon event log are never written from this file.
vi.mock('../../operations/needs-you-feed.mjs', async importOriginal => ({ ...(await importOriginal()), publishAttention: vi.fn() }));
vi.mock('../daemon-events.mjs', () => ({ appendDaemonEvent: vi.fn().mockResolvedValue(true) }));
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40), pr = 6244;
const comment = (rev = head, findings = [], login = 'web-everything') => ({ author: { login }, createdAt: '2026-11-05T12:00:00Z',
  body: renderRedTeamComment({ pr, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
const T = Date.parse('2026-11-05T12:00:00Z');
// Fabricated bounds default to an undecided unfinished review (the settleable shape); the decided shape is pinned below.
// They also default to a reader that reported a COMPLETE same-PR, same-head read with nothing blocking; the
// complete-read requirement itself is pinned in its own describe below.
const cleanRead = () => ({ complete: true, blocked: false });
const unknown = (reason, bounds) => Object.defineProperty({ ok: false, reason }, 'settleBounds', { value: { unfinishedUndecided: true, unfinishedActiveAt: T - 3 * 3600e3, evaluatedAt: T, completeHeadRead: cleanRead, ...bounds }, enumerable: false });
// An unread record quiet for longer than the settle margin (slack + abandon horizon) before the comment.
const OLD = T - 3 * 3600e3;
const older = { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: OLD };
const holdFor = (evidence, comments) => redTeamEnqueueHold({ ...settleUnknownEvidenceByComment(evidence, comments, pr, head), comments, pr, head, env: {} });

describe('R622 unknown run evidence settled by a head-bound result comment', () => {
  for (const reason of ['review-unfinished', 'scan-capped']) {
    it(`${reason} with a trusted clean result on this head releases the hold`, () => {
      expect(holdFor(unknown(reason, older), [comment()])).toBeNull();
    });
    it(`${reason} with no result comment still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [])).toMatch(/evidence unknown/);
    });
    it(`${reason} with a result for ANOTHER head still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [comment(other)])).toMatch(/evidence unknown/);
    });
    it(`${reason} with an untrusted author's result still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [comment(head, [], 'someone-else')])).toMatch(/evidence unknown/);
    });
    it(`${reason} with a confirmed break on this head still sends back`, () => {
      expect(holdFor(unknown(reason, older), [comment(head, broken)])).toMatch(/break requiring send-back/);
    });
  }
  it('review-unfinished started AFTER the result comment (a later re-review) stays held', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
  });
  it('scan-capped is held by the complete same-head read, not by the unread boundary (an unread record cannot be a same-head blocker the complete read missed)', () => {
    const blocked = () => ({ complete: true, blocked: true });
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T + 60e3, unfinishedStartedAt: -Infinity, completeHeadRead: blocked }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T + 60e3, unfinishedStartedAt: -Infinity }), [comment()])).toBeNull(); // a clean complete read covers every unread record
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 1000, unfinishedStartedAt: -Infinity }), [comment()])).toBeNull();
  });
  it('scan-capped with an unfinished run that started after the comment, or whose start is unreadable, stays held', () => {
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 3600e3, unfinishedStartedAt: T + 3600e3 }), [comment()])).toMatch(/evidence unknown/); // a resumed unfinished run
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 3600e3, unfinishedStartedAt: NaN }), [comment()])).toMatch(/evidence unknown/);
  });
  it('missing bounds never settle', () => {
    for (const reason of ['review-unfinished', 'scan-capped']) expect(holdFor(unknown(reason, {}), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor({ ok: false, reason: 'scan-capped' }, [comment()])).toMatch(/evidence unknown/);
  });
  it('review-unfinished that is also capped needs the unread boundary beaten too', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: OLD }), [comment()])).toBeNull();
  });
  it('other unknown reasons are never settled by a comment', () => {
    for (const reason of ['run-start-missing', 'read-failed']) {
      expect(settleUnknownEvidenceByComment(unknown(reason, older), [comment()], pr, head)).toMatchObject({ ok: false, reason });
    }
  });
  it('known evidence passes through untouched', () => {
    const evidence = { scheduled: true, recorded: false };
    expect(settleUnknownEvidenceByComment(evidence, [comment()], pr, head)).toBe(evidence);
  });
  it('a resumed review stamps a later resume time: a comment older than the resume stays held', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
  });
});

describe('R622 the evidence reader bounds a resumed unfinished review by its resume stamp', () => {
  const rev = head;
  const run = extra => ({ op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev } } },
    stepTimings: [{ step: 'read', startedAt: new Date(T - 7200e3).toISOString() }], verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, ...extra });
  const read = r => readDrainRedTeamEvidence({ repo: 'o/r', pr, head: rev, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => ['review-pr-1'], stat: () => ({ mtimeMs: T - 2 * 3600e3 }), read: () => r, readScorecards: () => [], now: T });
  const settled = r => settleUnknownEvidenceByComment(read(r), [comment()], pr, head);
  it('plain unfinished run older than the comment settles', () => { expect(settled(run({}))).toMatchObject({ ok: true }); });
  it('a resume stamped after the comment stays held', () => {
    expect(settled(run({ resumeOf: 'x', resumedAt: new Date(T + 60e3).toISOString() }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  it('a resumed run with no readable stamp stays held', () => {
    expect(settled(run({ resumeOf: 'x' }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
});

describe('R622 a re-review that already decided is not released by an earlier job\'s clean comment', () => {
  // The break: a re-review started before the comment, recorded a rejection, and only its label effect is still open.
  const base = extra => ({ op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', startedAt: new Date(T - 3600e3).toISOString() }], ...extra });
  const read = (r, mtimeMs = T - 2 * 3600e3) => readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => ['review-pr-1'], stat: () => ({ mtimeMs }), read: () => r, readScorecards: () => [], now: T });
  const held = r => expect(holdFor(read(r), [comment()])).toMatch(/evidence unknown/);
  const openEffect = status => [{ status }];
  it('a rejection verdict with a pending or in-flight effect stays held through the real reader', () => {
    for (const status of ['pending', 'in-flight']) held(base({ verdict: { verdict: 'changes' }, effects: openEffect(status) }));
  });
  it('a rejection verdict held only by a pending step stays held', () => {
    held(base({ verdict: { verdict: 'changes' }, pending: { kind: 'effects' } }));
    held(base({ verdict: 'reject', pending: { kind: 'effects' } }));
  });
  it('a present verdict this reader does not recognise counts as decided (fails closed)', () => {
    for (const verdict of [{}, { decision: 'changes' }, { outcome: 'reject' }, [], 7, 'reject']) {
      held(base({ verdict, pending: { kind: 'effects' } }));
      held(base({ verdict, effects: openEffect('pending') }));
    }
  });
  it('an open label effect on an otherwise undecided run stays held', () => {
    held(base({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, effects: openEffect('pending') }));
  });
  it('the undecided shapes (no verdict, or needs-human awaiting its confirm) still settle', () => {
    expect(holdFor(read(base({ pending: { kind: 'confirm' } })), [comment()])).toBeNull();
    expect(holdFor(read(base({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } })), [comment()])).toBeNull();
  });
  it('the decided run is reported on the bounds, and a bound that does not say so never settles', () => {
    expect(read(base({ verdict: { verdict: 'changes' }, effects: openEffect('pending') })).settleBounds).toMatchObject({ unfinishedUndecided: false });
    const noFlag = Object.defineProperty({ ok: false, reason: 'review-unfinished' }, 'settleBounds', { value: { unfinishedStartedAt: T - 3600e3 }, enumerable: false });
    expect(holdFor(noFlag, [comment()])).toMatch(/evidence unknown/);
  });
  it('a decided unfinished run keeps a capped scan held too (the older-than-selected path)', () => {
    // 3 records, maxParses=2: the newest finished run and the decided unfinished one are read, the oldest stays unread.
    const finished = { op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev: other } } },
      stepTimings: [{ step: 'read', startedAt: new Date(T - 1800e3).toISOString() }], verdict: { verdict: 'accept' } };
    const runs = { 'review-pr-c': finished, 'review-pr-b': base({ findings: { read: { netBasis: { rev: other } } }, verdict: { verdict: 'changes' }, effects: openEffect('pending') }), 'review-pr-a': finished };
    const mtimes = { 'review-pr-c': T - 100e3, 'review-pr-b': T - 200e3, 'review-pr-a': T - 3600e3 };
    const evidence = readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' }, runsDir: '/runs', warn: () => {},
      scanSettings: { file: { runs: { scan: { maxParses: 2 } } }, platform: {}, env: {} },
      list: () => Object.keys(runs), stat: p => ({ mtimeMs: mtimes[p.split('/').pop().replace('.json', '')] }), read: id => runs[id], readScorecards: () => [], now: T });
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(evidence.settleBounds).toMatchObject({ unfinishedUndecided: false });
    expect(settleUnknownEvidenceByComment(evidence, [comment()], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
});

describe('R622 several unfinished reviews', () => {
  const mk = (id, startedAt, extra = {}) => ({ id, run: { op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }], verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, ...extra } });
  const settledFor = runs => settleUnknownEvidenceByComment(readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => runs.map(r => r.id), stat: () => ({ mtimeMs: T - 2 * 3600e3 }), read: id => runs.find(r => r.id === id).run, readScorecards: () => [], now: T }), [comment()], pr, head);
  it('an older run resumed after the comment holds even when a newer unfinished run started before it', () => {
    const a = mk('review-pr-a', T - 7200e3, { resumeOf: 'x', resumedAt: new Date(T + 3600e3).toISOString() });
    const b = mk('review-pr-b', T - 3600e3);
    expect(settledFor([a, b])).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  it('all unfinished runs older than the comment settle', () => {
    expect(settledFor([mk('review-pr-a', T - 7200e3), mk('review-pr-b', T - 3600e3)])).toMatchObject({ ok: true });
  });
});

describe('R622 capped scan settles from the reader\'s own boundary, not a fabricated one', () => {
  // maxParses=1 reads only the newest-mtime record; the other record stays unread, so the reader reports scan-capped.
  const finished = startedAt => ({ op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev: other } } },
    stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }], verdict: { verdict: 'accept' } });
  const scanSettings = { file: { runs: { scan: { maxParses: 1 } } }, platform: {}, env: {} };
  const capped = (unreadMtime, readMtime = unreadMtime + 60e3) => {
    const mtimes = { 'review-pr-new': readMtime, 'review-pr-old': unreadMtime };
    return readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' }, runsDir: '/runs', scanSettings, warn: () => {},
      list: () => Object.keys(mtimes), stat: p => ({ mtimeMs: mtimes[p.split('/').pop().replace('.json', '')] }),
      read: id => (id === 'review-pr-new' ? finished(T - 7200e3) : finished(T - 9000e3)), readScorecards: () => [], now: T });
  };
  it('the reader reports scan-capped with the first unread record\'s mtime as the boundary', () => {
    const evidence = capped(OLD);
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(evidence.settleBounds).toMatchObject({ unreadBoundaryAt: OLD });
  });
  it('an unread record older than the result comment (by the mtime slack) settles', () => {
    expect(settleUnknownEvidenceByComment(capped(OLD), [comment()], pr, head)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
  });
  it('an unread record of another head written after the result comment no longer holds: the complete read covers it', () => {
    expect(settleUnknownEvidenceByComment(capped(T + 60e3, T + 120e3), [comment()], pr, head)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
    expect(settleUnknownEvidenceByComment(capped(T - 1000, T - 500), [comment()], pr, head)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
    expect(settleUnknownEvidenceByComment(capped(T - 1800e3), [comment()], pr, head)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
  });
});

describe('R622 settlement uses the NEWEST trusted result comment for this head', () => {
  const at = (iso, rev = head, findings = [], login = 'web-everything') => ({ ...comment(rev, findings, login), createdAt: new Date(iso).toISOString() });
  const bounds = { unfinishedStartedAt: T - 1800e3, unreadBoundaryAt: OLD };
  const stale = at(T - 3600e3), fresh = at(T);
  it('an old comment alone (before the unfinished review) stays held', () => {
    expect(holdFor(unknown('review-unfinished', bounds), [stale])).toMatch(/evidence unknown/);
  });
  it('a newer comment settles whichever order the comments arrive in', () => {
    expect(holdFor(unknown('review-unfinished', bounds), [stale, fresh])).toBeNull();
    expect(holdFor(unknown('review-unfinished', bounds), [fresh, stale])).toBeNull();
  });
  it('an old comment never settles when the newest is untrusted, for another head, or lacks a time', () => {
    for (const noise of [at(T, head, [], 'someone-else'), at(T, other), { ...comment(), createdAt: undefined }]) {
      expect(holdFor(unknown('review-unfinished', bounds), [stale, noise])).toMatch(/evidence unknown/);
    }
  });
});

describe('R622 chronology bounds are strict: a result comment EQUAL to a bound never settles', () => {
  it('equal to the unfinished review start stays held', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T }), [comment()])).toMatch(/evidence unknown/);
  });
  it('equal to the unread boundary plus the margin stays held for review-unfinished (the margin no longer applies to scan-capped)', () => {
    const edge = T - UNREAD_SETTLE_MARGIN_MS;
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: edge }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: edge - 1 }), [comment()])).toBeNull();
  });
  it('equal to the unfinished start stays held on a capped scan too', () => {
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 3600e3, unfinishedStartedAt: T }), [comment()])).toMatch(/evidence unknown/);
  });
});

describe('R622 the strategy wires the settlement into BOTH admission paths (prestage and enqueue)', () => {
  const ACCEPTED = ['review:accepted', 'ready-to-merge'];
  const repo = 'web-everything/web-everything', headSha = 'b'.repeat(40), num = 5283;
  const result = { author: { login: 'web-everything' }, createdAt: '2026-11-05T12:00:00Z',
    body: renderRedTeamComment({ pr: num, rev: headSha, findings: [], provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'accept' }) };
  const harness = (thread, evidence) => {
    const calls = [];
    let labels = [...ACCEPTED];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('--slurp')) return JSON.stringify([thread]);
      if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : args[0] === 'ls-remote' ? `${'e'.repeat(40)}\t${args.at(-1)}\n` : args[0] === 'rev-parse' ? `${'e'.repeat(40)}\n` : '';
      if (args[0] === 'pr' && args[1] === 'edit') {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--remove-label') labels = labels.filter(l => l !== args[i + 1]);
          if (args[i] === '--add-label') labels = [...labels, args[i + 1]];
        }
        return '';
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'label') return '';
      if (args[0] === 'api' && args[1] === 'user') return 'drain-bot\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', id: 'PR_NODE', headRefOid: headSha, baseRefName: 'main', labels });
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: calls.some(c => c.some(a => String(a).includes('enqueuePullRequest'))), headRefOid: headSha } } } });
        if (args.some(a => a.includes('mergeQueue(branch:'))) return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
        return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
      }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    let stored = null;
    const s = createDrainMergeStrategy({
      dryRun: false, env: { WE_UNDER_TEST: '1' }, exec, isLocalRepo: () => true, localSlug: repo, statePath: '/x/state.json', writeFile: () => {},
      readRedTeamEvidence: () => evidence, cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
      resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null }, log: { write: () => {} },
      readFile: () => { if (stored == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return JSON.stringify(stored); },
      writeState: (_p, st) => { stored = JSON.parse(JSON.stringify(st)); },
    });
    return { s, calls, labels: () => labels };
  };
  const enqueued = h => h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')));
  for (const reason of ['review-unfinished', 'scan-capped']) {
    it(`prestage: ${reason} + a trusted head-bound result comment admits; without it, it holds`, () => {
      expect(harness([result], unknown(reason, older)).s.prestage({ num }, headSha)).toMatchObject({ allowed: true });
      expect(harness([], unknown(reason, older)).s.prestage({ num }, headSha)).toMatchObject({ allowed: false, reason: expect.stringMatching(/evidence unknown/) });
    });
    it(`enqueue: ${reason} + a trusted head-bound result comment enqueues and publishes red-team:clear; without it, nothing is enqueued`, () => {
      const settled = harness([result], unknown(reason, older));
      expect(settled.s.enqueue({ num }, headSha, { comments: [result] })).toMatchObject({ enqueued: true });
      expect(enqueued(settled)).toBe(true);
      expect(settled.labels()).toContain('red-team:clear');
      const held = harness([], unknown(reason, older));
      expect(held.s.enqueue({ num }, headSha, { comments: [] })).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
      expect(enqueued(held)).toBe(false);
      expect(held.labels()).not.toContain('red-team:clear');
    });
  }
});

describe('R622 settlement needs a COMPLETE same-PR, same-head read, whatever the bounded scan read', () => {
  it('bounds without a complete-read result, or with an incomplete or blocked one, never settle (both reasons)', () => {
    for (const reason of ['review-unfinished', 'scan-capped']) {
      const without = Object.defineProperty({ ok: false, reason }, 'settleBounds', { value: { unfinishedUndecided: true, ...older }, enumerable: false });
      expect(holdFor(without, [comment()])).toMatch(/evidence unknown/);
      for (const result of [{ complete: false, blocked: false }, { complete: true, blocked: true }, { blocked: false }, { complete: true }, null, undefined]) {
        expect(holdFor(unknown(reason, { ...older, completeHeadRead: () => result }), [comment()])).toMatch(/evidence unknown/);
      }
      expect(holdFor(unknown(reason, { ...older, completeHeadRead: () => { throw new Error('boom'); } }), [comment()])).toMatch(/evidence unknown/);
    }
  });
  it('the complete read is asked for THIS pr and head', () => {
    const asked = vi.fn(cleanRead);
    settleUnknownEvidenceByComment(unknown('scan-capped', { ...older, completeHeadRead: asked }), [comment()], pr, head);
    expect(asked).toHaveBeenCalledWith({ pr, head, at: T }); // and the settling comment's time, for the chronology check
  });

  const rec = ({ prNum = pr, rev = head, startedAt = T - 7200e3, repo = 'o/r', ...extra } = {}) => ({ op: 'review-pr', input: { repo, pr: prNum },
    findings: { read: { netBasis: { rev } } }, stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }], ...extra });
  const open = { effects: [{ status: 'pending' }] };
  const idOf = p => p.split('/').pop().replace('.json', '');
  const read = (runs, maxParses, read = id => { const r = runs[id].run; if (r instanceof Error) throw r; return r; }) => readDrainRedTeamEvidence({ repo: 'o/r', pr, head,
    env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' }, runsDir: '/runs', warn: () => {}, readScorecards: () => [], now: T,
    scanSettings: { file: maxParses ? { runs: { scan: { maxParses } } } : {}, platform: {}, env: {} },
    list: () => Object.keys(runs), stat: p => ({ mtimeMs: runs[idOf(p)].mtime }), read });
  const settle = evidence => settleUnknownEvidenceByComment(evidence, [comment()], pr, head);
  const HIDDEN = T - 5 * 3600e3; // quiet far longer than the settle margin: only the complete read can still catch it
  // The bounded scan reads `window` newer finished records of another head, then runs out of budget before `hidden`.
  const windowed = (hidden, window = 2) => ({
    ...Object.fromEntries(Array.from({ length: window }, (_, i) => [`review-pr-new${i}`, { mtime: T - 60e3 - i * 10, run: rec({ rev: other, startedAt: T - 7200e3 - i * 1000, verdict: { verdict: 'accept' } }) }])),
    'review-pr-hidden': { mtime: HIDDEN, run: hidden },
  });

  it('a rejecting re-review with pending effects OUTSIDE the read window keeps the hold (round 2 shape)', () => {
    const runs = windowed(rec({ verdict: { verdict: 'changes' }, ...open }));
    const evidence = read(runs, 2);
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
  });
  it('300 decoy records of other PRs ahead of an unread rejection keep the hold (default parse budget)', () => {
    const decoys = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`review-pr-decoy${String(i).padStart(3, '0')}`,
      { mtime: T - 60e3 - i * 10, run: rec({ prNum: pr + 1, verdict: { verdict: 'accept' } }) }]));
    const evidence = read({ ...decoys, 'review-pr-hidden': { mtime: HIDDEN, run: rec({ verdict: { verdict: 'changes' }, ...open }) } });
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('300 decoys of this PR but another head ahead of an unread rejection keep the hold (the complete read is not itself capped)', () => {
    const decoys = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`review-pr-decoy${String(i).padStart(3, '0')}`,
      { mtime: T - 60e3 - i * 10, run: rec({ rev: other, startedAt: T - 7200e3 - i * 1000, verdict: { verdict: 'accept' } }) }]));
    const evidence = read({ ...decoys, 'review-pr-hidden': { mtime: HIDDEN, run: rec({ verdict: { verdict: 'changes' }, ...open }) } });
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('an unread rejection behind a read unfinished review (review-unfinished that is also capped) keeps the hold', () => {
    const runs = windowed(rec({ verdict: { verdict: 'changes' }, ...open }), 1);
    runs['review-pr-new0'] = { mtime: T - 60e3, run: rec({ startedAt: T - 7200e3, verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }) };
    const evidence = read(runs, 1);
    expect(evidence).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(settle(evidence)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  it('an unread FINISHED same-head rejection (no open effect) and any unrecognised verdict also keep the hold', () => {
    for (const verdict of [{ verdict: 'changes' }, 'changes', {}, [], 7]) {
      expect(settle(read(windowed(rec({ verdict })), 2))).toMatchObject({ ok: false, reason: 'scan-capped' });
    }
  });
  it('an unread same-head record with an open or in-flight label effect keeps the hold, whatever its verdict', () => {
    for (const status of ['pending', 'in-flight']) {
      for (const verdict of [{ verdict: 'accept' }, { verdict: 'needs-human' }, undefined]) {
        expect(settle(read(windowed(rec({ ...(verdict ? { verdict } : {}), effects: [{ status }] })), 2))).toMatchObject({ ok: false, reason: 'scan-capped' });
      }
    }
  });
  it('an unread same-PR record whose head cannot be read, and a rejection of a head-less shape, keep the hold', () => {
    const headless = { op: 'review-pr', input: { repo: 'o/r', pr }, verdict: { verdict: 'changes' } };
    expect(settle(read(windowed(headless), 2))).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('an unreadable record, or one that cannot be attributed to a PR, fails closed', () => {
    expect(settle(read(windowed(new Error('torn record')), 2))).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settle(read(windowed({ op: 'review-pr', input: {}, verdict: { verdict: 'accept' } }), 2))).toMatchObject({ ok: false, reason: 'scan-capped' });
    const noMtime = windowed(rec({ verdict: { verdict: 'accept' } }));
    noMtime['review-pr-hidden'].mtime = NaN;
    expect(() => read(noMtime, 2)).toThrow(); // the finder itself already refuses an unreadable mtime
  });
  it('the clean path still settles: unread records that are accepts, undecided holds, other heads or other PRs', () => {
    for (const hidden of [rec({ verdict: { verdict: 'accept' } }), rec({ verdict: { verdict: 'prevention-outstanding' } }), rec({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }), rec(), rec({ rev: other, verdict: { verdict: 'changes' }, ...open }),
      rec({ prNum: pr + 1, verdict: { verdict: 'changes' }, ...open }), rec({ repo: 'o/other', verdict: { verdict: 'changes' }, ...open })]) {
      expect(settle(read(windowed(hidden), 2))).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
    }
  });
  it('only a settle attempt pays for the complete read, and a repeat over unchanged records does not re-parse them', () => {
    const runs = windowed(rec({ verdict: { verdict: 'accept' } }));
    const reads = vi.fn(id => runs[id].run);
    const evidence = read(runs, 2, reads);
    expect(reads).toHaveBeenCalledTimes(2); // the bounded scan alone
    expect(settleUnknownEvidenceByComment(evidence, [], pr, head)).toBe(evidence); // no result comment: cheap checks fail first
    expect(reads).toHaveBeenCalledTimes(2);
    expect(settle(evidence)).toMatchObject({ ok: true });
    expect(reads).toHaveBeenCalledTimes(2 + 3);
    expect(settle(read(runs, 2, reads))).toMatchObject({ ok: true }); // a second tick: only its own bounded scan re-reads
    expect(reads).toHaveBeenCalledTimes(2 + 3 + 2);
  });
  it('a record rewritten after it was cached (new mtime) is re-read and its new rejection holds', () => {
    const runs = windowed(rec({ verdict: { verdict: 'accept' } }));
    const reads = vi.fn(id => runs[id].run);
    expect(settle(read(runs, 2, reads))).toMatchObject({ ok: true }); // cached as a clean accept
    runs['review-pr-hidden'] = { mtime: HIDDEN + 1, run: rec({ verdict: { verdict: 'changes' }, ...open }) };
    expect(settle(read(runs, 2, reads))).toMatchObject({ ok: false, reason: 'scan-capped' }); // new mtime: re-parsed
    runs['review-pr-hidden'] = { mtime: HIDDEN + 2, run: rec({ verdict: { verdict: 'accept' } }) };
    expect(settle(read(runs, 2, reads))).toMatchObject({ ok: true }); // the entry was replaced, not appended: clean again
  });
  // Identity variants of the same defect class: an unread blocking record that the complete read must still attribute.
  const reject = { verdict: { verdict: 'changes' }, ...open };
  const heldBy = hidden => settle(read(windowed(hidden), 2));
  it('an unread review-pr- record whose op is not review-pr is ignored', () => {
    expect(heldBy({ op: 'file-item', input: { repo: 'o/r', pr }, ...reject })).toMatchObject({ ok: true });
  });
  it('an unread rejection whose PR number is null, empty, false, zero or a non-numeric string keeps the hold', () => {
    for (const bad of [null, '', false, 0, 'x', [], {}, -1, 1.5]) {
      expect(heldBy({ ...rec(reject), input: { repo: 'o/r', pr: bad } })).toMatchObject({ ok: false, reason: 'scan-capped' });
    }
    expect(heldBy(rec({ prNum: String(pr), ...reject }))).toMatchObject({ ok: false, reason: 'scan-capped' }); // a digit string is still this PR
  });
  it('an unread rejection with a damaged head matches every head, and a repo written in another case is still this repo', () => {
    for (const rev of ['', ` ${head}`, head.slice(0, 7), 'zz'.repeat(20), 42, null]) {
      expect(heldBy(rec({ rev, ...reject }))).toMatchObject({ ok: false, reason: 'scan-capped' });
    }
    expect(heldBy(rec({ rev: head.toUpperCase(), ...reject }))).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(heldBy(rec({ repo: ' O/R ', ...reject }))).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(heldBy(rec({ repo: 'o/other', ...reject }))).toMatchObject({ ok: true }); // a genuinely different repo is still ignored
  });
});

describe('R622 abandoned startable crashes after the result comment', () => {
  const HOUR = 3600e3, now = T + 24 * HOUR;
  it.each([
    { name: 'quiet verdictless terminal crash settles without a head', extra: {}, mtime: T + 12 * HOUR, ok: true },
    { name: 'crash quiet for less than the horizon stays held', extra: {}, mtime: now - HOUR + 1, ok: false },
    { name: 'crash with a pending step stays held', extra: { pending: { kind: 'confirm' } }, ok: false },
    { name: 'crash with resumeOf stays held', extra: { resumeOf: 'review-pr-original' }, ok: false },
    { name: 'crash with resumedAt stays held', extra: { resumedAt: new Date(T + 11 * HOUR).toISOString() }, ok: false },
    { name: 'crash with an open pending effect stays held', extra: { effects: [{ status: 'pending' }] }, ok: false },
    { name: 'changes verdict after the comment stays held', extra: { verdict: 'changes' }, ok: false },
    { name: 'needs-human after the comment stays held', extra: { verdict: 'needs-human' }, ok: false },
  ])('$name', ({ extra, mtime = T + 12 * HOUR, ok }) => {
    // The bounded scan sees only decoys; the complete read must classify the later, head-less crash.
    const runs = {
      'review-pr-decoy1': { mtime: now - 60e3, run: { op: 'review-pr', input: { repo: 'o/r', pr: pr + 1 } } },
      'review-pr-decoy2': { mtime: now - 120e3, run: { op: 'review-pr', input: { repo: 'o/r', pr: pr + 1 } } },
      'review-pr-crash': { mtime, run: { op: 'review-pr', input: { repo: 'o/r', pr }, pending: null, effects: [],
        stepTimings: [{ step: 'read', startedAt: new Date(T + 10 * HOUR).toISOString() }], ...extra } },
    };
    const evidence = readDrainRedTeamEvidence({ repo: 'o/r', pr, head, now, runsDir: '/runs',
      env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' }, warn: () => {}, readScorecards: () => [],
      scanSettings: { file: { runs: { scan: { maxParses: 1 } } }, platform: {}, env: {} },
      list: () => Object.keys(runs), read: id => runs[id].run,
      stat: path => ({ mtimeMs: runs[path.split('/').pop().replace('.json', '')].mtime }) });
    expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(evidence.settleBounds.completeHeadRead({ pr, head, at: T })).toEqual({ complete: true, blocked: !ok });
    expect(settleUnknownEvidenceByComment(evidence, [comment()], pr, head)).toMatchObject({ ok });
  });
});

describe('R622 review follow-ups: decided-run guard, liveness, id universe, cache size key, complete-read failures', () => {
  const HOUR = 3600e3;
  const rec = ({ rev = head, startedAt = T - 7200e3, ...extra } = {}) => ({ op: 'review-pr', input: { repo: 'o/r', pr },
    findings: { read: { netBasis: { rev } } }, stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }], ...extra });
  const open = { effects: [{ status: 'pending' }] };
  const reject = { verdict: { verdict: 'changes' }, ...open };
  const idOf = p => p.split('/').pop().replace('.json', '');
  // `io` lets a test change what the store reports between the bounded scan and the settle attempt.
  const reader = (runs, { maxParses, size = () => undefined, list = () => Object.keys(runs), stat, reads, readFn } = {}) => readDrainRedTeamEvidence({ repo: 'o/r', pr, head,
    env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' }, runsDir: '/runs', warn: () => {}, readScorecards: () => [], now: T,
    scanSettings: { file: maxParses ? { runs: { scan: { maxParses } } } : {}, platform: {}, env: {} },
    list, stat: stat ?? (p => ({ mtimeMs: runs[idOf(p)].mtime, size: size(idOf(p)) })), read: readFn ?? (id => { reads?.(id); return runs[id].run; }) });
  const settle = evidence => settleUnknownEvidenceByComment(evidence, [comment()], pr, head);
  const finished = (i, mtime) => [`review-pr-new${i}`, { mtime, run: rec({ rev: other, startedAt: T - 7200e3 - i * 1000, verdict: { verdict: 'accept' } }) }];
  const windowed = hidden => ({ ...Object.fromEntries([finished(0, T - 60e3), finished(1, T - 70e3)]), 'review-pr-hidden': { mtime: T - 5 * HOUR, run: hidden } });

  it('the decided-run guard holds on its own: a decided unfinished run of ANOTHER head (complete read sees nothing) is not released', () => {
    // Guard removed => this settles, because the complete read only blocks same-head (or head-less) records.
    expect(settle(Object.defineProperty({ ok: false, reason: 'review-unfinished' }, 'settleBounds', { value: { unfinishedStartedAt: T - HOUR, unfinishedUndecided: false,
      unfinishedActiveAt: T - 3 * HOUR, evaluatedAt: T, completeHeadRead: () => ({ complete: true, blocked: false }) }, enumerable: false }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
    const runs = { 'review-pr-other': { mtime: T - 3 * HOUR, run: rec({ rev: other, ...reject }) } };
    const evidence = reader(runs);
    expect(evidence).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(evidence.settleBounds).toMatchObject({ unfinishedUndecided: false });
    expect(settle(evidence)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });

  describe('a review still running is not released by a clean comment posted after its start', () => {
    const live = mtime => ({ 'review-pr-live': { mtime, run: rec() } }); // no verdict yet, started 2h before the comment
    it('written within the abandon horizon stays held; quiet for the whole horizon settles; the boundary is inclusive', () => {
      expect(settle(reader(live(T - 60e3)))).toMatchObject({ ok: false, reason: 'review-unfinished' });
      expect(settle(reader(live(T - HOUR + 1)))).toMatchObject({ ok: false, reason: 'review-unfinished' });
      expect(settle(reader(live(T - HOUR)))).toMatchObject({ ok: true, settledByComment: 'review-unfinished' });
      expect(settle(reader(live(T - 3 * HOUR)))).toMatchObject({ ok: true });
    });
    it('one recently written unfinished run among quiet ones keeps the hold', () => {
      expect(settle(reader({ ...live(T - 3 * HOUR), 'review-pr-live2': { mtime: T - 30e3, run: rec({ startedAt: T - 7000e3 }) } }))).toMatchObject({ ok: false });
    });
    it('a live unfinished run inside a capped read window keeps the capped hold too', () => {
      const runs = { ...windowed(rec({ verdict: { verdict: 'accept' } })), 'review-pr-live': { mtime: T - 20e3, run: rec({ startedAt: T - 9000e3 }) } };
      const evidence = reader(runs, { maxParses: 3 });
      expect(evidence).toMatchObject({ ok: false });
      expect(settle(evidence)).toMatchObject({ ok: false });
    });
    it('scan-capped carries the liveness bound too: a live unfinished run that started BEFORE the newest finished run (no exact-head run read) still holds', () => {
      // 4 records, maxParses=2: the live run (newest mtime) and the newest finished run are read, two older ones stay unread.
      const runs = { 'review-pr-live': { mtime: T - 20e3, run: rec({ rev: other, startedAt: T - 9000e3 }) },
        'review-pr-done': { mtime: T - 60e3, run: rec({ rev: other, startedAt: T - 7200e3, verdict: { verdict: 'accept' } }) },
        'review-pr-old0': { mtime: T - 5 * HOUR, run: rec({ rev: other, startedAt: T - 20000e3, verdict: { verdict: 'accept' } }) },
        'review-pr-old1': { mtime: T - 6 * HOUR, run: rec({ rev: other, startedAt: T - 21000e3, verdict: { verdict: 'accept' } }) } };
      const evidence = reader(runs, { maxParses: 2 });
      expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(evidence.settleBounds).toMatchObject({ unfinishedActiveAt: T - 20e3, evaluatedAt: T });
      expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
      runs['review-pr-live'].mtime = T - 2 * HOUR; // quiet for the horizon: the same shape now settles
      expect(settle(reader(runs, { maxParses: 2 }))).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
    });
    it('a bound with no read time, no write time, or an unreadable (NaN) write time never settles', () => {
      const base = { unfinishedStartedAt: T - HOUR, unreadBoundaryAt: T - 3 * HOUR, unfinishedUndecided: true, completeHeadRead: () => ({ complete: true, blocked: false }) };
      const go = extra => settle(Object.defineProperty({ ok: false, reason: 'review-unfinished' }, 'settleBounds', { value: { ...base, ...extra }, enumerable: false }));
      expect(go({ unfinishedActiveAt: T - 3 * HOUR, evaluatedAt: T })).toMatchObject({ ok: true });
      for (const extra of [{}, { evaluatedAt: T }, { unfinishedActiveAt: T - 3 * HOUR }, { unfinishedActiveAt: NaN, evaluatedAt: T }, { unfinishedActiveAt: T - 3 * HOUR, evaluatedAt: NaN }]) {
        expect(go(extra)).toMatchObject({ ok: false, reason: 'review-unfinished' });
      }
    });
  });

  it('the complete read covers review-pr-* ids only: a rejecting run under a custom --run-id is invisible and does not block (same id universe as the bounded scan)', () => {
    const runs = { ...windowed(rec({ verdict: { verdict: 'accept' } })), 'custom-reject': { mtime: T - 5 * HOUR, run: rec(reject) } };
    expect(settle(reader(runs, { maxParses: 2 }))).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
    runs['review-pr-reject'] = { mtime: T - 5 * HOUR, run: rec(reject) }; // the same record under the minted id blocks
    expect(settle(reader(runs, { maxParses: 2 }))).toMatchObject({ ok: false, reason: 'scan-capped' });
  });

  it('cache invalidation also keys on SIZE: a rewrite with the same mtime but a different size is re-read', () => {
    const runs = windowed(rec({ verdict: { verdict: 'accept' } }));
    let hiddenSize = 100;
    const readFn = vi.fn(id => runs[id].run); // one stable reader: the summary cache is keyed by it
    const reads = readFn;
    const go = () => settle(reader(runs, { maxParses: 2, size: id => (id === 'review-pr-hidden' ? hiddenSize : 1), readFn }));
    expect(go()).toMatchObject({ ok: true });
    expect(go()).toMatchObject({ ok: true });
    const parsed = reads.mock.calls.filter(([id]) => id === 'review-pr-hidden').length;
    runs['review-pr-hidden'].run = rec(reject); // same mtime
    expect(go()).toMatchObject({ ok: true }); // same mtime AND size: the cached summary is (by design) still used
    expect(reads.mock.calls.filter(([id]) => id === 'review-pr-hidden').length).toBe(parsed);
    hiddenSize = 101;
    expect(go()).toMatchObject({ ok: false, reason: 'scan-capped' }); // size changed: re-parsed, the rejection holds
  });

  describe('complete-read failures fail closed (listing, stat, read), even though the bounded scan read fine', () => {
    const attempt = failing => {
      const runs = windowed(rec({ verdict: { verdict: 'accept' } }));
      let settling = false;
      const evidence = reader(runs, { maxParses: 2,
        list: () => { if (settling && failing === 'list') throw new Error('EIO'); return Object.keys(runs); },
        stat: p => { if (settling && failing === 'stat-throw') throw new Error('EIO'); if (settling && failing === 'stat-nan') return { mtimeMs: NaN }; return { mtimeMs: runs[idOf(p)].mtime }; } });
      expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
      settling = true;
      return settle(evidence);
    };
    it('control: the same store settles when nothing fails', () => { expect(attempt('none')).toMatchObject({ ok: true }); });
    for (const failing of ['list', 'stat-throw', 'stat-nan']) {
      it(`${failing} keeps the hold`, () => { expect(attempt(failing)).toMatchObject({ ok: false, reason: 'scan-capped' }); });
    }
    it('a record that cannot be parsed keeps the hold', () => {
      const runs = windowed(rec({ verdict: { verdict: 'accept' } }));
      let settling = false;
      const evidence = reader(runs, { maxParses: 2, reads: id => { if (settling && id === 'review-pr-hidden') throw new Error('torn'); } });
      settling = true;
      expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
    });
  });
});

describe('R639 present-verdict check, capped-scan settlement through the complete read, newest completed review per head', () => {
  const HOUR = 3600e3;
  const rec = ({ rev = head, prNum = pr, startedAt = T - 7200e3, withStart = true, ...extra } = {}) => ({ op: 'review-pr', input: { repo: 'o/r', pr: prNum },
    findings: { read: { netBasis: { rev } } }, ...(withStart ? { stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }] } : {}), ...extra });
  const open = { effects: [{ status: 'pending' }] };
  const idOf = p => p.split('/').pop().replace('.json', '');
  const reader = (runs, maxParses, nowAt = T) => readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r639' }, runsDir: '/runs',
    warn: () => {}, readScorecards: () => [], now: nowAt, scanSettings: { file: maxParses ? { runs: { scan: { maxParses } } } : {}, platform: {}, env: {} },
    list: () => Object.keys(runs), stat: p => ({ mtimeMs: runs[idOf(p)].mtime }), read: id => runs[id].run });
  const settle = evidence => settleUnknownEvidenceByComment(evidence, [comment()], pr, head);
  // 300 newer records of ANOTHER PR (past the default parse budget), all written after `newerThan`.
  const decoys = (newerThan = T - 60e3) => Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`review-pr-decoy${String(i).padStart(3, '0')}`,
    { mtime: newerThan + 1000 + i * 10, run: rec({ prNum: pr + 1, startedAt: T - 3 * HOUR - i * 1000, verdict: { verdict: 'accept' } }) }]));

  describe('a present verdict is anything but undefined/null: false, 0 and "" are malformed, not absent', () => {
    for (const verdict of [false, 0, '']) {
      const label = JSON.stringify(verdict);
      it(`verdict ${label} on an unread same-head record keeps a capped read held (real reader + settlement + enqueue hold)`, () => {
        const evidence = reader({ ...decoys(T - 5 * HOUR), 'review-pr-hidden': { mtime: T - 5 * HOUR, run: rec({ verdict }) } });
        expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
      });
      it(`verdict ${label} on a read same-head record is decided, so a clean comment does not release it`, () => {
        const evidence = reader({ 'review-pr-1': { mtime: T - 3 * HOUR, run: rec({ verdict }) } });
        expect(evidence).toMatchObject({ ok: false, reason: 'review-unfinished' });
        expect(evidence.settleBounds).toMatchObject({ unfinishedUndecided: false });
        expect(settle(evidence)).toMatchObject({ ok: false, reason: 'review-unfinished' });
        expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
      });
    }
    it('control: an absent verdict (undefined, null) is still the undecided shape and settles once quiet', () => {
      for (const extra of [{}, { verdict: null }]) {
        expect(settle(reader({ 'review-pr-1': { mtime: T - 3 * HOUR, run: rec(extra) } }))).toMatchObject({ ok: true });
      }
    });
  });

  describe('scan-capped settles through the complete same-head read, not the unread-boundary margin', () => {
    it('a review that finished 1 min before the comment, behind 300 newer other-PR records, settles and the enqueue hold releases', () => {
      const runs = { ...decoys(), 'review-pr-done': { mtime: T - 60e3, run: rec({ startedAt: T - 2 * HOUR, verdict: { verdict: 'accept' } }) } };
      const evidence = reader(runs);
      expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(evidence.settleBounds.unreadBoundaryAt).toBeGreaterThan(T - 2 * 60e3); // inside the old margin: the old rule held forever
      expect(settle(evidence)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
      expect(holdFor(evidence, [comment()])).toBeNull();
    });
    it('the same shape with a rejection that still has an open effect (or a finished rejection) holds', () => {
      for (const extra of [{ verdict: { verdict: 'changes' }, ...open }, { verdict: { verdict: 'changes' } }]) {
        const evidence = reader({ ...decoys(), 'review-pr-rej': { mtime: T - 60e3, run: rec({ startedAt: T - 2 * HOUR, ...extra }) } });
        expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
      }
    });
    it('an unread same-head review that may still be running (no verdict, written inside the abandon horizon) holds; once quiet it settles', () => {
      expect(settle(reader({ ...decoys(), 'review-pr-live': { mtime: T - 60e3, run: rec() } }))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(reader({ ...decoys(), 'review-pr-live': { mtime: T - HOUR + 1, run: rec() } }))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(reader({ ...decoys(), 'review-pr-live': { mtime: T - HOUR, run: rec() } }))).toMatchObject({ ok: true });
    });
    it('review-unfinished keeps its own unread-boundary margin', () => {
      const bounds = { unfinishedStartedAt: T - HOUR, unreadBoundaryAt: T - 30 * 60e3 };
      expect(holdFor(unknown('review-unfinished', bounds), [comment()])).toMatch(/evidence unknown/);
    });
  });

  describe('per head, only the NEWEST completed review decides; open effects and unrecognised verdicts always hold', () => {
    const changes = { verdict: { verdict: 'changes' } }, accept = { verdict: { verdict: 'accept' } };
    // Both records sit far behind 300 newer decoys; the comment is a clean red-team result for the head.
    const behind = (older, newer, { olderMtime = T - 6 * HOUR, newerMtime = T - 5 * HOUR } = {}) =>
      reader({ ...decoys(T - 5 * HOUR), 'review-pr-a-old': { mtime: olderMtime, run: older }, 'review-pr-b-new': { mtime: newerMtime, run: newer } });
    it('a completed rejection (no open effect) followed by a newer completed accept of the same head does not hold', () => {
      const evidence = behind(rec({ startedAt: T - 6 * HOUR, ...changes }), rec({ startedAt: T - 5 * HOUR, ...accept }));
      expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(evidence)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
      expect(holdFor(evidence, [comment()])).toBeNull();
    });
    it('the order is by read-step start, not by id or arrival: an accept that STARTED earlier does not supersede a later rejection', () => {
      const evidence = behind(rec({ startedAt: T - 5 * HOUR, ...changes }), rec({ startedAt: T - 6 * HOUR, ...accept }));
      expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
    });
    it('a record with no read-step start cannot be ordered (mtime moves on a rewrite): its rejection holds, its accept supersedes nothing', () => {
      const bare = extra => rec({ withStart: false, ...extra });
      expect(settle(behind(bare(changes), bare(accept)))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(behind(bare(accept), bare(changes)))).toMatchObject({ ok: false, reason: 'scan-capped' });
      // a late-touched start-less accept does not erase a started rejection; a start-less accept beside an accept is harmless
      expect(settle(behind(rec({ startedAt: T - 5 * HOUR, ...changes }), bare(accept), { newerMtime: T - 10e3 }))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(behind(rec({ startedAt: T - 5 * HOUR, ...accept }), bare(accept)))).toMatchObject({ ok: true });
    });
    it('a start in the future cannot order a record: an accept stamped 2999 does not supersede a rejection', () => {
      const future = new Date('2999-01-01T00:00:00Z').getTime();
      expect(settle(behind(rec({ startedAt: T - 6 * HOUR, ...changes }), rec({ startedAt: future, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(behind(rec({ startedAt: future, ...changes }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
    });
    it('a rewound-and-resumed rejection is ordered by its resume stamp, not its original start', () => {
      // R1 read-started first but resumed (and finished) AFTER the accept started: the rejection is the newest.
      const resumed = rec({ startedAt: T - 7 * HOUR, resumeOf: 'review-pr-x', resumedAt: new Date(T - 4 * HOUR).toISOString(), ...changes });
      expect(settle(behind(resumed, rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(settle(behind(rec({ ...resumed, resumedAt: new Date(T - 6 * HOUR).toISOString() }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: true });
      expect(settle(behind(rec({ ...resumed, resumedAt: 'garbage' }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
    });
    describe('the complete read enforces comment chronology for unread unfinished same-head reviews', () => {
      // The drain read happens long after the comment (nowAt), and the unread review has been quiet for hours, yet it STARTED
      // after the trusted result comment (T): a later re-review the comment cannot answer. Quiet-for-the-horizon is not enough.
      const NOW = T + 4 * HOUR;
      const unread = run => reader({ ...decoys(T + 50 * 60e3), 'review-pr-hidden': { mtime: T + 40 * 60e3, run } }, undefined, NOW);
      const afterComment = startedAt => ({ startedAt });
      it('control: a quiet unread review that started BEFORE the comment settles (capped read)', () => {
        const evidence = unread(rec(afterComment(T - HOUR)));
        expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(settle(evidence)).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
      });
      it('started after the comment: holds (no verdict; needs-human awaiting confirm; accept with a pending step)', () => {
        for (const extra of [{}, { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }, { verdict: { verdict: 'accept' }, pending: { kind: 'confirm' } }]) {
          const evidence = unread(rec({ ...afterComment(T + 30 * 60e3), ...extra }));
          expect(evidence).toMatchObject({ ok: false, reason: 'scan-capped' });
          expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
          expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
        }
      });
      it('the chronology is strict: started exactly at the comment holds, one ms earlier settles', () => {
        expect(settle(unread(rec(afterComment(T))))).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(settle(unread(rec(afterComment(T - 1))))).toMatchObject({ ok: true });
      });
      it('an unreadable start (no read step) holds: it cannot be placed before the comment', () => {
        expect(settle(unread(rec({ withStart: false })))).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(settle(unread(rec({ stepTimings: [{ step: 'read', startedAt: 'garbage' }] })))).toMatchObject({ ok: false, reason: 'scan-capped' });
      });
      it('a quiet start-less record (crash before the read step) is bounded by its own mtime: written before the comment settles, never held forever', () => {
        const crashed = mtime => reader({ ...decoys(T + 50 * 60e3), 'review-pr-hidden': { mtime, run: rec({ withStart: false }) } }, undefined, NOW);
        expect(settle(crashed(T - 2 * 24 * HOUR))).toMatchObject({ ok: true, settledByComment: 'scan-capped' });
        expect(settle(crashed(T - RUN_MTIME_SLACK_MS - HOUR))).toMatchObject({ ok: true });
        expect(settle(crashed(T - 1000))).toMatchObject({ ok: false, reason: 'scan-capped' }); // inside the mtime slack of the comment
        expect(settle(crashed(T + 30 * 60e3))).toMatchObject({ ok: false, reason: 'scan-capped' }); // written after the comment
      });
      it('the NEWEST trusted comment is the chronology: a review between an old and a new comment settles only on the new one', () => {
        const evidence = unread(rec(afterComment(T - 60e3)));
        const old = { ...comment(), createdAt: new Date(T - 3 * HOUR).toISOString() }, fresh = comment();
        expect(settleUnknownEvidenceByComment(evidence, [old], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(settleUnknownEvidenceByComment(evidence, [old, fresh], pr, head)).toMatchObject({ ok: true });
      });
    });
    it('an unread rewound-and-resumed review with no verdict holds however quiet it is (the loop may still reject)', () => {
      for (const extra of [{ resumeOf: 'review-pr-x' }, { resumedAt: new Date(T - 4 * HOUR).toISOString() }, { verdict: { verdict: 'needs-human' }, resumeOf: 'review-pr-x' }]) {
        expect(settle(reader({ ...decoys(T - 5 * HOUR), 'review-pr-hidden': { mtime: T - 5 * HOUR, run: rec(extra) } }))).toMatchObject({ ok: false, reason: 'scan-capped' });
      }
    });
    it('a malformed verdict on a terminal old record is not dropped as abandoned: the bounded scan and the complete read agree it is decided', () => {
      for (const verdict of [false, 0, '']) {
        const evidence = reader({ 'review-pr-1': { mtime: T - 5 * HOUR, run: rec({ verdict, effects: [] }) } });
        expect(evidence).toMatchObject({ ok: false, reason: 'review-unfinished' });
        expect(settle(evidence)).toMatchObject({ ok: false, reason: 'review-unfinished' });
      }
    });
    it('an unrecognised verdict STRING (case, whitespace, another word) is hard, not a supersedable rejection', () => {
      for (const verdict of ['Accept', 'accept ', 'rejected', 'bogus', 'reject', 'CHANGES']) {
        expect(settle(behind(rec({ startedAt: T - 6 * HOUR, verdict }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
      }
    });
    it('a tie on the order key keeps the rejection (fail closed)', () => {
      const same = extra => rec({ startedAt: T - 6 * HOUR, ...extra });
      expect(settle(behind(same(changes), same(accept)))).toMatchObject({ ok: false, reason: 'scan-capped' });
    });
    it('a rejection with an open effect holds even when a newer completed accept exists', () => {
      for (const status of ['pending', 'in-flight']) {
        const evidence = behind(rec({ startedAt: T - 6 * HOUR, ...changes, effects: [{ status }] }), rec({ startedAt: T - 5 * HOUR, ...accept }));
        expect(settle(evidence)).toMatchObject({ ok: false, reason: 'scan-capped' });
        expect(holdFor(evidence, [comment()])).toMatch(/evidence unknown/);
      }
    });
    it('an unrecognised or malformed verdict older than a newer accept still holds', () => {
      for (const verdict of [{}, [], 7, false, 0, '']) {
        expect(settle(behind(rec({ startedAt: T - 6 * HOUR, verdict }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false, reason: 'scan-capped' });
      }
    });
    it('a rejection waiting on a pending step holds even when a newer accept exists', () => {
      expect(settle(behind(rec({ startedAt: T - 6 * HOUR, ...changes, pending: { kind: 'effects' } }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false });
    });
    it('a newer accept of ANOTHER head does not supersede a rejection of this head', () => {
      expect(settle(behind(rec({ startedAt: T - 6 * HOUR, ...changes }), rec({ rev: other, startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false });
    });
    it('a head-less rejection is never superseded; a head-less accept supersedes nothing', () => {
      expect(settle(behind(rec({ rev: null, startedAt: T - 6 * HOUR, ...changes }), rec({ startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false });
      expect(settle(behind(rec({ startedAt: T - 6 * HOUR, ...changes }), rec({ rev: null, startedAt: T - 5 * HOUR, ...accept })))).toMatchObject({ ok: false });
    });
  });
});
