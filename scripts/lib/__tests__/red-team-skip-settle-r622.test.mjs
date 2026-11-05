// @vitest-environment node
// R622: the review side saw "red-team result already on head" while the drain held the same head as
// unknown run evidence (review-unfinished / scan-capped). A trusted result comment bound to the exact
// head settles those two reasons; a recorded break still sends back; missing evidence still fails closed.
import { describe, expect, it, vi } from 'vitest';
import { readDrainRedTeamEvidence, settleUnknownEvidenceByComment, UNREAD_SETTLE_MARGIN_MS } from '../drain-red-team-evidence.mjs';
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
const unknown = (reason, bounds) => Object.defineProperty({ ok: false, reason }, 'settleBounds', { value: { unfinishedUndecided: true, completeHeadRead: cleanRead, ...bounds }, enumerable: false });
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
  it('scan-capped with an unread record written after the result comment stays held', () => {
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 1000, unfinishedStartedAt: -Infinity }), [comment()])).toMatch(/evidence unknown/); // inside the mtime slack
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
    runsDir: '/runs', list: () => ['review-pr-1'], stat: () => ({ mtimeMs: T - 60e3 }), read: () => r, readScorecards: () => [], now: T });
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
  const read = r => readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => ['review-pr-1'], stat: () => ({ mtimeMs: T - 60e3 }), read: () => r, readScorecards: () => [], now: T });
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
    runsDir: '/runs', list: () => runs.map(r => r.id), stat: () => ({ mtimeMs: T - 60e3 }), read: id => runs.find(r => r.id === id).run, readScorecards: () => [], now: T }), [comment()], pr, head);
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
  it('an unread record newer than the result comment stays held', () => {
    expect(settleUnknownEvidenceByComment(capped(T + 60e3, T + 120e3), [comment()], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('an unread record inside the mtime slack of the result comment stays held', () => {
    expect(settleUnknownEvidenceByComment(capped(T - 1000, T - 500), [comment()], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('an unread record written recently enough to hold a still-open rejection effect stays held (not quiet for the settle margin)', () => {
    // 30 minutes before the comment: older than the slack, but within the abandon horizon an unread rejecting run could still be applying.
    expect(settleUnknownEvidenceByComment(capped(T - 1800e3), [comment()], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settleUnknownEvidenceByComment(capped(T - UNREAD_SETTLE_MARGIN_MS), [comment()], pr, head)).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(settleUnknownEvidenceByComment(capped(T - UNREAD_SETTLE_MARGIN_MS - 1), [comment()], pr, head)).toMatchObject({ ok: true });
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
  it('equal to the unread boundary plus the mtime slack stays held (scan-capped and review-unfinished)', () => {
    const edge = T - UNREAD_SETTLE_MARGIN_MS;
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: edge, unfinishedStartedAt: -Infinity }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: edge }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: edge - 1, unfinishedStartedAt: -Infinity }), [comment()])).toBeNull();
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
    expect(asked).toHaveBeenCalledWith({ pr, head });
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
    for (const verdict of [{ verdict: 'changes' }, 'changes', { verdict: 'prevention-outstanding' }, {}, [], 7]) {
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
    for (const hidden of [rec({ verdict: { verdict: 'accept' } }), rec({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }), rec(), rec({ rev: other, verdict: { verdict: 'changes' }, ...open }),
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
});
