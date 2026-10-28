/**
 * @file scripts/conveyor/__tests__/fix-dispatch-queue-cap.test.mjs
 * @description Card xkyw1x4 — the fix-dispatch daemon's `queue-cap` hook: `runReconcileFixDispatch` and
 *   `runReconcileCiHealDispatch` admit each owed fix / CI-heal only while the projected heavy-test queue wait stays
 *   ≤ the max, and a budget shared across both passes sees every dispatch before it. Every read is a stub — no
 *   real GitHub, lane pool or host queue.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runReconcileFixDispatch, queueBudgetFrom, planQueueCapRefusal, recordQueueCapRefusal,
} from '../reconcile-fix-dispatch.mjs';
import { runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';
import {
  QUEUE_CAP_REFUSAL_MARKER, QUEUE_CAP_REFUSAL_CAP, countQueueCapRefusals,
  summarizeCapacityDeferral, FIX_STARVED_CAPACITY_MARKER, buildFixStarvedCapacityComment,
  buildCapacityBaselineComment,
  hasFixStarvedCapacityAlert, buildQueueCapRefusalComment, queueCapHeadLine,
} from '../queue-cap-refusal-count.mjs';
import { NOTE_COMMENT_MARKER } from '../reconcile-note-comment.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
const item = { num: '3438', slug: 'wire-reconcile-pass', specPath: 'backlog/3438-wire-reconcile-pass.md', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'] };
// #4295 — one scope-DISJOINT item per owed fix, so the overlap filter (correctly) doesn't serialize them.
const findItemStub = (key) => (key === '3438' ? item : /^900\d$/.test(key) ? { num: key, slug: 'x', specPath: `backlog/${key}-x.md`, scope: [`we:scripts/x${key}.mjs`] } : null);
const fixEntries = (prs) => prs.map((pr, i) => ({ kind: 'fix', prNumber: pr, headRefName: `lane/900${i}-x` }));
const reconcileStub = (entries) => () => ({ dispatch: entries.map((entry) => ({ ...entry, files: entry.files ?? [`scripts/pr-${entry.prNumber}.mjs`] })), refusals: [], notes: [], prs: entries.length, agents: 0 });
const WE_PROFILE = () => ({ capabilities: { fix: true, ciHeal: true }, lanePoolRepo: '.' });

function runFix(prs, queueAdmission, o = {}) {
  const dispatched = [];
  const result = runReconcileFixDispatch({
    root: '/repo',
    reconcile: reconcileStub(fixEntries(prs)),
    findItemFn: findItemStub,
    loadItems: () => [],
    pickFreeLanes: () => [2, 3, 4, 5],
    resolveProfile: WE_PROFILE,
    dispatch: (planned) => { dispatched.push(planned.pr); return { sessionSlug: `fix-${planned.pr}`, pr: planned.pr, lane: planned.lane }; },
    checkStaleness: FRESH,
    queueAdmission,
    // #4229 — never touch a real `gh`/`osascript` process from a unit test; a test that cares about the
    // queue-cap-refusal counter supplies its own stubs below instead.
    readPrComments: () => [],
    postQueueCapComment: () => ({ ok: true }),
    notifyQueueCapOperator: () => ({ ok: true }),
    ...o,
  });
  return { dispatched, result };
}

describe('runReconcileFixDispatch — queue-cap', () => {
  it('no queueAdmission (the default) — every owed fix dispatches, as before', () => {
    const { dispatched, result } = runFix([1, 2, 3, 4], undefined);
    expect(dispatched).toEqual([1, 2, 3, 4]);
    expect(result.refusals).toEqual([]);
  });

  it('4 fixes owed at once on a busy queue: the one that would push the projection past 30m is refused queue-cap', () => {
    // (50 + 3.25n) / 2 → 26.63, 28.25, 29.88, 31.5
    const { dispatched, result } = runFix([1, 2, 3, 4], { slots: 2, backlogMinutes: 50, maxWaitMinutes: 30 });
    expect(dispatched).toEqual([1, 2, 3]);
    expect(result.refusals).toEqual([{
      pr: 4,
      kind: 'queue-cap',
      why: expect.stringContaining('projected heavy-test queue wait 31.5m would exceed 30m'),
      attempts: 0,
      deferredForCapacity: 1,
      cap: 3,
      capExhausted: false,
    }]);
  });

  it('the baseline may be a function (read once per pass); a throwing reader fails open', () => {
    let reads = 0;
    const { dispatched } = runFix([1, 2], () => { reads += 1; return { slots: 1, backlogMinutes: 100 }; });
    expect(reads).toBe(1);
    expect(dispatched).toEqual([]);
    expect(runFix([1, 2], () => { throw new Error('pool unreadable'); }).dispatched).toEqual([1, 2]);
  });
});

describe('runReconcileCiHealDispatch — queue-cap, sharing ONE budget with the fix pass', () => {
  it('a CI-heal is costed like a fix and sees the fixes admitted before it in the same daemon pass', async () => {
    const budget = queueBudgetFrom({ slots: 2, backlogMinutes: 50, maxWaitMinutes: 30 });
    const fix = runFix([1, 2], budget); // → 26.63, 28.25 — both admitted
    expect(fix.dispatched).toEqual([1, 2]);
    const healed = [];
    const result = await runReconcileCiHealDispatch({
      root: '/repo',
      flushOwed: () => ({ posted: [], cleared: [], dropped: [], kept: [] }), // #4352 — never the host's real owed dir
      reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: 50, headRefName: 'lane/x' }, { kind: 'ci-heal', prNumber: 51, headRefName: 'lane/y' }], refusals: [] }),
      resolveProfile: WE_PROFILE,
      resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
      pickFreeLanes: () => [7, 8],
      dispatch: async (planned) => { healed.push(planned.pr); return { sessionSlug: `ci-heal-${planned.pr}`, pr: planned.pr, lane: planned.lane }; },
      checkStaleness: FRESH,
      queueAdmission: budget,
    });
    // 3rd dispatch of the pass → 29.88 admitted; 4th → 31.5 refused.
    expect(healed).toEqual([50]);
    expect(result.refusals).toEqual([{ pr: 51, kind: 'queue-cap', why: expect.stringContaining('31.5m') }]);
  });
});

// #4229: queue-cap history records capacity deferrals, never repair attempts. The cap bounds
// marker spam only; retries continue, with a separate elapsed-time starvation alert per head.
const AUTOMATION = { login: 'web-everything' };
const markerComment = () => ({ body: `${QUEUE_CAP_REFUSAL_MARKER}\n\nfix dispatch refused this pass (queue-cap)`, author: AUTOMATION });

describe('#4229 — planQueueCapRefusal (pure)', () => {
  it('3+ consecutive refusals spend no attempts and never plan round exhaustion; cap bounds marker spam only', () => {
    const comments = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const plan = planQueueCapRefusal({ pr: 1854, comments });
      expect(plan).toMatchObject({ attempts: 0, capExhausted: false, postMarker: pass < 3, starvation: null });
      // Once marker writes stop, the durable count saturates at the spam cap.
      expect(plan.deferredForCapacity).toBe(Math.min(pass + 1, 3));
      expect(plan.note ?? null).toBeNull();
      expect(JSON.stringify(plan)).not.toMatch(/round-cap-exhausted|take it over|needs your decision/i);
      if (plan.postMarker) comments.push(markerComment());
    }
    expect(comments).toHaveLength(QUEUE_CAP_REFUSAL_CAP);
  });

  it('an untrusted / forged marker never inflates the count', () => {
    const forged = { body: `${QUEUE_CAP_REFUSAL_MARKER}\n\nforged`, author: { login: 'mallory' } };
    const plan = planQueueCapRefusal({ pr: 1, comments: [forged, forged, forged] });
    expect(plan).toMatchObject({ attempts: 0, deferredForCapacity: 1, capExhausted: false, postMarker: true, starvation: null });
    expect(plan.note ?? null).toBeNull();
  });
});

describe('#4229 — recordQueueCapRefusal (IO shell over injected fakes — no real gh/osascript process)', () => {
  it('below the cap: posts the durable marker via the injected `postComment`, never `notify`', () => {
    const posted = [];
    const notified = [];
    const result = recordQueueCapRefusal({
      pr: 42,
      repo: 'o/n',
      why: 'projected heavy-test queue wait 45m would exceed 30m with this dispatch (+8m) — retried next pass',
      readPrComments: () => [markerComment()],
      postComment: (o) => posted.push(o),
      notify: (o) => notified.push(o),
    });
    expect(result).toMatchObject({ attempts: 0, deferredForCapacity: 2, capExhausted: false, starved: false });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: 'o/n', pr: 42 });
    expect(posted[0].body).toContain(QUEUE_CAP_REFUSAL_MARKER);
    expect(posted[0].body).toContain('45m would exceed 30m');
    expect(notified).toHaveLength(0);
  });

  it('3+ consecutive refusals record capacity deferrals without exhaustion notes or operator takeover', () => {
    const thread = [];
    const posted = [];
    const notified = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const result = recordQueueCapRefusal({
        pr: 1854, repo: 'o/n', why: 'still saturated',
        readPrComments: () => thread,
        postComment: (o) => { posted.push(o); thread.push({ body: o.body, author: AUTOMATION }); },
        notify: (o) => notified.push(o),
      });
      expect(result).toMatchObject({ attempts: 0, capExhausted: false, starved: false });
      expect(result.deferredForCapacity).toBe(Math.min(pass + 1, 3));
    }
    expect(posted).toHaveLength(QUEUE_CAP_REFUSAL_CAP);
    expect(posted.every((o) => o.body.startsWith(QUEUE_CAP_REFUSAL_MARKER))).toBe(true);
    expect(JSON.stringify(posted)).not.toMatch(/round-cap-exhausted|take it over/i);
    expect(posted.some((o) => o.body.includes(NOTE_COMMENT_MARKER))).toBe(false);
    expect(notified).toEqual([]);
  });

  it('a historical queue-cap exhaustion note never makes a capacity deferral spend a repair attempt', async () => {
    const { buildNoteComment } = await import('../reconcile-note-comment.mjs');
    const note = {
      kind: 'round-cap-exhausted', prNumber: 1854, attempts: 3, cap: 3, capKind: 'queue-cap', text: 'already exhausted',
    };
    const atCapAndNoted = [
      markerComment(), markerComment(), markerComment(),
      { body: buildNoteComment(note), author: AUTOMATION },
    ];
    const posted = [];
    const notified = [];
    const result = recordQueueCapRefusal({
      pr: 1854,
      repo: 'o/n',
      why: 'still saturated',
      readPrComments: () => atCapAndNoted,
      postComment: (o) => posted.push(o),
      notify: (o) => notified.push(o),
    });
    expect(result).toMatchObject({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(posted).toHaveLength(0); // already posted — nothing new to write
    expect(notified).toHaveLength(0);
  });

  // PR #2760 review (codex-correctness + antigravity) — the history read GATES the write, so a read failure must
  // fail CLOSED (write nothing), never fail open to an empty history: otherwise persistently failing reads with
  // working writes post a fresh marker every single pass, bypassing the cap forever.
  it('a throwing `readPrComments` fails CLOSED — no marker, no note, no notify, and the pass does not crash', () => {
    const posted = [];
    const notified = [];
    const result = recordQueueCapRefusal({
      pr: 9,
      repo: 'o/n',
      why: 'saturated',
      readPrComments: () => { throw new Error('gh: network error'); },
      postComment: (o) => posted.push(o),
      notify: (o) => notified.push(o),
    });
    expect(result).toEqual({ attempts: null, capExhausted: false, historyUnknown: true });
    expect(posted).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it.each([undefined, null, {}])('recordQueueCapRefusal with non-array readPrComments result %j fails closed without writes or notify', comments => {
    const postComment = vi.fn();
    const notify = vi.fn();
    const result = recordQueueCapRefusal({
      pr: 9, repo: 'o/n', why: 'saturated',
      readPrComments: () => comments, postComment, notify,
    });
    expect(result).toEqual({ attempts: null, capExhausted: false, historyUnknown: true });
    expect(postComment).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('repeated read failures with working writes post NOTHING, before and after the marker cap — then resume counting once reads recover', () => {
    const ALWAYS_REFUSE = { tryAdmit: () => ({ admit: false, projectedMinutes: 45, maxWaitMinutes: 30, demandMinutes: 8 }) };
    let thread = [];
    let readsFail = false;
    const posted = [];
    const pass = () => runFix([1854], ALWAYS_REFUSE, {
      readPrComments: () => { if (readsFail) throw new Error('gh: timeout'); return thread; },
      postQueueCapComment: (o) => { posted.push(o); thread = [...thread, { body: o.body, author: AUTOMATION }]; },
    }).result.refusals[0];
    readsFail = true;
    for (let i = 0; i < 5; i += 1) expect(pass()).toMatchObject({ attempts: null, capExhausted: false });
    expect(posted).toHaveLength(0); // below the cap: nothing written while history is unknown
    readsFail = false;
    for (let i = 0; i < 4; i += 1) pass(); // marker spam stops at 3
    expect(posted).toHaveLength(3);
    readsFail = true;
    for (let i = 0; i < 5; i += 1) pass();
    expect(posted).toHaveLength(3); // past the marker cap: still nothing written while history is unknown
  });

  it('a throwing `postComment`/`notify` is swallowed — never masks the (already-decided) refusal', () => {
    expect(() => recordQueueCapRefusal({
      pr: 9,
      repo: 'o/n',
      why: 'saturated',
      readPrComments: () => [],
      postComment: () => { throw new Error('gh: rate limited'); },
      notify: () => {},
    })).not.toThrow();
  });
});

describe('#4229 — runReconcileFixDispatch: the durable count survives across passes, dispatch never stops retrying', () => {
  it('4 consecutive saturated passes: zero attempts, capacity deferrals counted, marker spam bounded, retry never stops', () => {
    const ALWAYS_REFUSE = { tryAdmit: () => ({ admit: false, projectedMinutes: 45, maxWaitMinutes: 30, demandMinutes: 8 }) };
    let thread = []; // mirrors the durable PR comment thread a real `gh pr comment` write would leave behind
    const posted = [];
    const notified = [];
    const outcomes = [];
    for (let pass = 1; pass <= 4; pass += 1) {
      const attemptsBeforeThisPass = countQueueCapRefusals(thread);
      const { dispatched, result } = runFix([1854], ALWAYS_REFUSE, {
        readPrComments: () => thread,
        postQueueCapComment: (o) => { posted.push(o); thread = [...thread, { body: o.body, author: AUTOMATION }]; },
        notifyQueueCapOperator: (o) => notified.push(o),
      });
      outcomes.push({
        pass, attemptsBeforeThisPass, dispatched: dispatched.length, refusal: result.refusals[0],
      });
    }
    // Every single pass is still refused (never dispatched) — the resource constraint is real and dispatch
    // correctly keeps retrying it, exactly as before this fix.
    expect(outcomes.every((o) => o.dispatched === 0)).toBe(true);
    expect(outcomes.map((o) => o.attemptsBeforeThisPass)).toEqual([0, 1, 2, 3]);
    expect(outcomes.map((o) => o.refusal.attempts)).toEqual([0, 0, 0, 0]);
    expect(outcomes.slice(0, 3).map((o) => o.refusal.deferredForCapacity)).toEqual([1, 2, 3]);
    expect(outcomes[3].refusal.deferredForCapacity).toBe(3);
    expect(outcomes.map((o) => o.refusal.capExhausted)).toEqual([false, false, false, false]);
    // Only three capacity markers: later passes keep retrying without further thread spam.
    expect(posted).toHaveLength(3);
    expect(posted.filter((p) => p.body.includes(QUEUE_CAP_REFUSAL_MARKER))).toHaveLength(3);
    expect(posted.filter((p) => p.body.includes(NOTE_COMMENT_MARKER))).toHaveLength(0);
    expect(JSON.stringify(posted)).not.toMatch(/round-cap-exhausted|take it over/i);
    expect(notified).toHaveLength(0);
  });

  // PR #2760 review (correctness) — the call site must hand the gh `OWNER/REPO` slug to the comment seams, never
  // the internal repo KEY ('we'): `gh pr view <n> --repo we` fails, the read was swallowed, and the whole
  // count/cap/escalation feature was silently inert. This drives the REAL `defaultReadPrComments` /
  // `postNoteComment` argv builders (only the process exec itself is faked) so the wiring is checked end to end.
  it('WIRING — the real default gh seams receive the OWNER/REPO slug (never the internal repo key), for the default repo and an explicit slug or key', async () => {
    const { defaultReadPrComments } = await import('../ci-red-recovery-watch.mjs');
    const { postNoteComment } = await import('../reconcile-note-comment.mjs');
    const ALWAYS_REFUSE = { tryAdmit: () => ({ admit: false, projectedMinutes: 45, maxWaitMinutes: 30, demandMinutes: 8 }) };
    for (const [repo, slug] of [[undefined, 'web-everything/web-everything'], ['we', 'web-everything/web-everything'], ['web-everything/web-everything', 'web-everything/web-everything']]) {
      const argvs = [];
      const exec = (_cmd, argv) => {
        argvs.push(argv);
        if (argv[0] === 'api' && argv[1] === 'graphql') {
          return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 0 } } } } });
        }
        return ''; // empty paginated TSV thread, or successful marker post
      };
      runFix([1854], ALWAYS_REFUSE, {
        ...(repo === undefined ? {} : { repo }),
        readPrComments: (pr, o) => defaultReadPrComments(pr, { ...o, exec }),
        postQueueCapComment: (o) => postNoteComment({ ...o, exec }),
      });
      expect(argvs).toHaveLength(3); // paginated read + independent count proof + marker post
      const [readArgv, countArgv, postArgv] = argvs;
      expect(readArgv[0]).toBe('api');
      expect(readArgv).toContain('--paginate');
      expect(readArgv).toContain(`repos/${slug}/issues/1854/comments`);
      expect(countArgv.slice(0, 2)).toEqual(['api', 'graphql']);
      const [owner, name] = slug.split('/');
      expect(countArgv).toEqual(expect.arrayContaining([`owner=${owner}`, `name=${name}`, 'n=1854']));
      expect(postArgv.slice(0, 3)).toEqual(['pr', 'comment', '1854']);
      expect(postArgv.slice(postArgv.indexOf('--repo'), postArgv.indexOf('--repo') + 2)).toEqual(['--repo', slug]);
    }
  });

  it('a NEW head starts a fresh capacity episode and marker allowance with zero repair attempts', () => {
    const ALWAYS_REFUSE = { tryAdmit: () => ({ admit: false, projectedMinutes: 45, maxWaitMinutes: 30, demandMinutes: 8 }) };
    let thread = [];
    const posted = [];
    const notified = [];
    const pass = (headRefOid) => runFix([1854], ALWAYS_REFUSE, {
      reconcile: reconcileStub(fixEntries([1854]).map((e) => ({ ...e, headRefOid }))),
      readPrComments: () => thread,
      postQueueCapComment: (o) => { posted.push(o); thread = [...thread, { body: o.body, author: AUTOMATION }]; },
      notifyQueueCapOperator: (o) => notified.push(o),
    }).result.refusals[0];
    const first = [1, 2, 3, 4, 5].map(() => pass('aaa111'));
    expect(first.map((r) => r.attempts)).toEqual([0, 0, 0, 0, 0]);
    expect(first.map((r) => r.deferredForCapacity)).toEqual([1, 2, 3, 3, 3]);
    expect(notified).toHaveLength(0);
    const second = [1, 2, 3, 4, 5].map(() => pass('bbb222'));
    expect(second.map((r) => r.attempts)).toEqual([0, 0, 0, 0, 0]);
    expect(second.map((r) => r.deferredForCapacity)).toEqual([1, 2, 3, 3, 3]);
    expect(second.map((r) => r.capExhausted)).toEqual([false, false, false, false, false]);
    expect(posted.filter((p) => p.body.includes(QUEUE_CAP_REFUSAL_MARKER))).toHaveLength(6);
    expect(posted.filter((p) => p.body.includes(NOTE_COMMENT_MARKER))).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  // #4229 — REPLAY PROOF, grounded in real PR web-everything/web-everything#2756's own real identity (`gh pr view 2756
  // --repo web-everything/web-everything --json number,headRefName,updatedAt`, captured 2026-09-26: open,
  // `review:changes`, head `lane/xu38vlf-conflict-watch-caps-and-bound` — a genuine bounced PR this repo's own
  // fix-dispatch daemon owes a fix). SYNTHESIZED: neither this repo's fix-dispatch daemon log
  // (`wev-review-daemon/.conveyor/fix-dispatch-daemon.log`) nor the merge/health-watch daemon clones' own logs
  // show a REAL `queue-cap` refusal yet today (the heavy-test queue has not actually saturated for long enough
  // to hit this — confirmed by grep, 2026-09-26) — so, mirroring PR #2756's own two REPLAY tests
  // (`parked-pr-conflict-watch.test.mjs`), this replay keeps this PR's real number/head-ref identity and
  // synthesizes the one condition that has not naturally occurred yet: a heavy-test queue saturated for 4
  // consecutive reconcile passes running.
  it('REPLAY — real PR #2756 shape: a persistently saturated queue is bounded at 3 capacity markers with zero repair attempts, never stopping the retry', () => {
    const ALWAYS_REFUSE = { tryAdmit: () => ({ admit: false, projectedMinutes: 52, maxWaitMinutes: 30, demandMinutes: 12 }) };
    const realPr = 2756;
    const realHeadRef = 'lane/xu38vlf-conflict-watch-caps-and-bound';
    let thread = [];
    const posted = [];
    const notified = [];
    // #4229 — real PR #2756's own real head ref names item `xu38vlf` (a JIT-numbered, hash-slug bornAs id, not
    // yet given a plain numeric backlog number — this repo's own item-resolution supports both forms).
    const item2756 = {
      num: 'xu38vlf', slug: 'conflict-watch-caps-and-bound', specPath: 'backlog/xu38vlf-x.md', scope: ['we:scripts/conveyor/parked-pr-conflict-watch.mjs'],
    };
    const dispatched = [];
    const outcomes = [];
    for (let pass = 1; pass <= 4; pass += 1) {
      const result = runReconcileFixDispatch({
        root: '/repo',
        reconcile: () => ({
          dispatch: [{ kind: 'fix', prNumber: realPr, headRefName: realHeadRef, files: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] }], refusals: [], notes: [], prs: 1, agents: 0,
        }),
        findItemFn: (key) => (key === 'xu38vlf' ? item2756 : null),
        loadItems: () => [],
        pickFreeLanes: () => [9],
        resolveProfile: WE_PROFILE,
        dispatch: (planned) => { dispatched.push(planned.pr); return { sessionSlug: `fix-${planned.pr}`, pr: planned.pr, lane: planned.lane }; },
        checkStaleness: FRESH,
        queueAdmission: ALWAYS_REFUSE,
        readPrComments: () => thread,
        postQueueCapComment: (o) => { posted.push(o); thread = [...thread, { body: o.body, author: AUTOMATION }]; },
        notifyQueueCapOperator: (o) => notified.push(o),
      }).refusals[0];
      outcomes.push(result);
    }
    expect(dispatched).toEqual([]); // never dispatched — but also never silently dropped: refused every pass
    expect(outcomes.every((o) => o.pr === realPr && o.kind === 'queue-cap')).toBe(true);
    expect(outcomes.map((o) => o.attempts)).toEqual([0, 0, 0, 0]);
    expect(outcomes.slice(0, 3).map((o) => o.deferredForCapacity)).toEqual([1, 2, 3]);
    expect(outcomes[3].deferredForCapacity).toBe(3);
    expect(outcomes.map((o) => o.capExhausted)).toEqual([false, false, false, false]);
    expect(posted.filter((p) => p.body.includes(NOTE_COMMENT_MARKER))).toHaveLength(0);
    expect(JSON.stringify(posted)).not.toMatch(/round-cap-exhausted|take it over/i);
    expect(notified).toHaveLength(0);
    expect(posted.filter((p) => p.body.startsWith(QUEUE_CAP_REFUSAL_MARKER))).toHaveLength(3);
  });
});

const CAPACITY_NOW = Date.parse('2026-10-28T12:00:00Z');
const HOUR = 3_600_000;
const CAPACITY_HEAD = 'a'.repeat(40);
const capacityMarker = (at, head = CAPACITY_HEAD, author = AUTOMATION) => ({
  author,
  body: `${QUEUE_CAP_REFUSAL_MARKER}\n${queueCapHeadLine(head)}${at == null ? '' : `\n<!-- queue-cap-deferred-at: ${at} -->`}\n\nqueue busy`,
});
const isoHoursAgo = hours => new Date(CAPACITY_NOW - hours * HOUR).toISOString();
const saturated = () => ({ admit: false, projectedMinutes: 45, maxWaitMinutes: 30, demandMinutes: 8 });

// This common assertion guards every externally visible escalation channel.
function expectNoRepairExhaustion(posted, notified) {
  expect(posted.some(o => o.body.includes(NOTE_COMMENT_MARKER))).toBe(false);
  expect(JSON.stringify({ posted, notified })).not.toMatch(/round-cap-exhausted|take it over|rounds exhausted|round limit|needs your decision/i);
}

describe('capacity deferral marker helpers', () => {
  it.each([
    ['ISO', new Date(CAPACITY_NOW).toISOString()], ['Date', new Date(CAPACITY_NOW)], ['ms', CAPACITY_NOW],
  ])('buildQueueCapRefusalComment embeds the deferred-at line for %s without changing marker or head', (_kind, now) => {
    const body = buildQueueCapRefusalComment('queue busy', CAPACITY_HEAD, now);
    expect(body.split('\n')[0]).toBe(QUEUE_CAP_REFUSAL_MARKER);
    expect(body).toContain(queueCapHeadLine(CAPACITY_HEAD));
    expect(body).toContain('<!-- queue-cap-deferred-at: 2026-10-28T12:00:00.000Z -->');
    expect(body).toContain('queue busy');
    expect(buildQueueCapRefusalComment('legacy', CAPACITY_HEAD)).not.toContain('queue-cap-deferred-at:');
  });

  it('summarizeCapacityDeferral counts trusted same-head markers and takes min/max embedded times, independent of thread order', () => {
    const comments = [
      capacityMarker(isoHoursAgo(1)), capacityMarker(isoHoursAgo(7)), capacityMarker(null),
      capacityMarker(isoHoursAgo(4)), capacityMarker(isoHoursAgo(99), CAPACITY_HEAD, { login: 'mallory' }),
      capacityMarker(isoHoursAgo(99), 'b'.repeat(40)),
      { ...capacityMarker(isoHoursAgo(99)), body: `quoted: ${capacityMarker(isoHoursAgo(99)).body}` },
    ];
    expect(summarizeCapacityDeferral(comments, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 4, firstAt: isoHoursAgo(7), lastAt: isoHoursAgo(1),
    });
  });

  it('legacy or invalid timestamps do not invent starvation evidence; legacy markers still count', () => {
    expect(summarizeCapacityDeferral([capacityMarker(null), capacityMarker('invalid')], { headSha: CAPACITY_HEAD }))
      .toEqual({ deferredForCapacity: 2, firstAt: null, lastAt: null });
    expect(summarizeCapacityDeferral([], { headSha: CAPACITY_HEAD }))
      .toEqual({ deferredForCapacity: 0, firstAt: null, lastAt: null });
  });

  it('legacy markers without a deferred-at line count toward deferredForCapacity but never create starvation evidence', () => {
    const comments = Array.from({ length: 3 }, () => ({
      ...capacityMarker(null), createdAt: isoHoursAgo(99),
    }));
    expect(summarizeCapacityDeferral(comments, { headSha: CAPACITY_HEAD }))
      .toEqual({ deferredForCapacity: 3, firstAt: null, lastAt: null });
    expect(planQueueCapRefusal({ pr: 42, comments, headSha: CAPACITY_HEAD, now: CAPACITY_NOW }))
      .toMatchObject({ deferredForCapacity: 3, firstAt: null, postMarker: false, postBaseline: true, starvation: null });
  });

  it.each([
    '2026-13-45', 'tomorrow', '1e12', '', '2026-10-28',
    '2026-10-28 05:00:00Z', '2026-10-28T05:00:00', '2026-10-28T05:00:00+00:00',
    '2026-10-28T05:00:00.1Z', '2026-10-28T05:00:00.0000Z', '2026-13-45T05:00:00Z',
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-27T24:00:00Z',
    '2026-02-30T00:00:00.000Z', '2026-10-27T24:00:00.000Z',
  ])('malformed deferred-at %j counts as a deferral but supplies no starvation timestamp', at => {
    const comments = [capacityMarker(at)];
    expect(summarizeCapacityDeferral(comments, { headSha: CAPACITY_HEAD }))
      .toEqual({ deferredForCapacity: 1, firstAt: null, lastAt: null });
    expect(planQueueCapRefusal({ pr: 42, comments, headSha: CAPACITY_HEAD, now: CAPACITY_NOW }).starvation).toBeNull();
  });

  it.each(['2026-10-28T05:00:00Z', '2026-10-28T05:00:00.000Z'])(
    'valid UTC deferred-at %s supplies starvation evidence', at => {
      expect(summarizeCapacityDeferral([capacityMarker(at)], { headSha: CAPACITY_HEAD }))
        .toEqual({ deferredForCapacity: 1, firstAt: isoHoursAgo(7), lastAt: isoHoursAgo(7) });
    },
  );

  it.each(['2026-10-28T05:00:00.123Z', '2024-02-29T00:00:00.000Z'])(
    'valid calendar instant %s retains millisecond precision', at => {
      expect(summarizeCapacityDeferral([capacityMarker(at)], { headSha: CAPACITY_HEAD }))
        .toEqual({ deferredForCapacity: 1, firstAt: at, lastAt: at });
    },
  );

  it('buildFixStarvedCapacityComment identifies host capacity, no failed fix and no used attempt', () => {
    expect(FIX_STARVED_CAPACITY_MARKER).toBe('⏳ conveyor — fix starved on host capacity (fix-starved-capacity)');
    const body = buildFixStarvedCapacityComment({ headSha: CAPACITY_HEAD, hours: 7, deferredForCapacity: 3, firstAt: isoHoursAgo(7) });
    expect(body.split('\n')[0]).toBe(FIX_STARVED_CAPACITY_MARKER);
    expect(body).toContain(queueCapHeadLine(CAPACITY_HEAD));
    expect(body).toMatch(/host capacity/i);
    expect(body).toMatch(/(?:not|hasn't|has not) failed/i);
    expect(body).toMatch(/no (?:fix )?attempt (?:was |has been )?used/i);
    expect(body).toMatch(/7\s*hours/i);
    expectNoRepairExhaustion([{ body }], []);
  });

  it('buildFixStarvedCapacityComment floors fractional elapsed hours to whole hours', () => {
    const body = buildFixStarvedCapacityComment({
      headSha: CAPACITY_HEAD, hours: 7 + 17_000 / HOUR, deferredForCapacity: 3, firstAt: isoHoursAgo(7),
    });
    expect(body).toContain('for 7 hours');
    expect(body).not.toMatch(/\d+\.\d+ hours/);
  });

  it('hasFixStarvedCapacityAlert ignores untrusted authors, quoted markers and other heads', () => {
    const body = `${FIX_STARVED_CAPACITY_MARKER}\n${queueCapHeadLine(CAPACITY_HEAD)}\n\nhost capacity`;
    const trusted = { body, author: AUTOMATION };
    expect(hasFixStarvedCapacityAlert([trusted], { headSha: CAPACITY_HEAD })).toBe(true);
    expect(hasFixStarvedCapacityAlert([
      { body, author: { login: 'mallory' } },
      { ...trusted, body: `quoted: ${body}` },
      { ...trusted, body: body.replace(CAPACITY_HEAD, 'b'.repeat(40)) },
    ], { headSha: CAPACITY_HEAD })).toBe(false);
  });
});

describe('host capacity starvation is elapsed-time based, never round exhaustion', () => {
  it.each([[7, 6], [6, 6], [3, 2]])(
    'starvation plan, comment and notify show whole hours for %ih00m17s elapsed, at least the %ih threshold', (age, starvationHours) => {
      const firstAt = isoHoursAgo(age);
      const comments = [capacityMarker(firstAt), capacityMarker(firstAt), capacityMarker(firstAt)];
      const options = { pr: 42, headSha: CAPACITY_HEAD, now: CAPACITY_NOW + 17_000, starvationHours };
      const plan = planQueueCapRefusal({ ...options, comments });
      expect(plan.starvation).toEqual({ hours: age, firstAt, deferredForCapacity: 3 });
      expect(Number.isInteger(plan.starvation.hours)).toBe(true);
      expect(plan.starvation.hours).toBeGreaterThanOrEqual(starvationHours);
      const postComment = vi.fn(() => ({ ok: true }));
      const notify = vi.fn();
      expect(recordQueueCapRefusal({
        ...options, repo: 'o/n', readPrComments: () => comments, postComment, notify,
      })).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: true });
      expect(postComment).toHaveBeenCalledTimes(1);
      expect(postComment.mock.calls[0][0].body).toContain(`for ${age} hours`);
      expect(postComment.mock.calls[0][0].body).not.toMatch(/\d+\.\d+ hours/);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith({
        title: '🔔 conveyor — host capacity starved',
        body: `PR #42: host capacity has deferred the fix for ${age} hours; inspect host capacity`,
      });
    },
  );

  it.each([[7, undefined, true], [5, undefined, false], [6, undefined, false], [3, 2, true]])(
    'planner: %ih old first marker, threshold %s -> starvation %s', (age, starvationHours, starved) => {
      const plan = planQueueCapRefusal({
        pr: 42, headSha: CAPACITY_HEAD, comments: [capacityMarker(isoHoursAgo(age))], now: CAPACITY_NOW,
        ...(starvationHours === undefined ? {} : { starvationHours }),
      });
      expect(plan).toMatchObject({ attempts: 0, deferredForCapacity: 2, firstAt: isoHoursAgo(age), capExhausted: false });
      expect(plan.note ?? null).toBeNull();
      if (starved) expect(plan.starvation).toMatchObject({ hours: age, firstAt: isoHoursAgo(age), deferredForCapacity: 2 });
      else expect(plan.starvation).toBeNull();
    },
  );

  it('recordQueueCapRefusal alerts exactly once after 7h, even at the marker cap', () => {
    const thread = [capacityMarker(isoHoursAgo(7)), capacityMarker(isoHoursAgo(6)), capacityMarker(isoHoursAgo(5))];
    const posted = [];
    const notified = [];
    const pass = () => recordQueueCapRefusal({
      pr: 42, repo: 'o/n', headSha: CAPACITY_HEAD, now: CAPACITY_NOW, why: 'queue busy',
      readPrComments: () => thread,
      postComment: o => { posted.push(o); thread.push({ body: o.body, author: AUTOMATION }); return { ok: true }; },
      notify: o => notified.push(o),
    });
    expect(pass()).toMatchObject({ attempts: 0, capExhausted: false, deferredForCapacity: 3, starved: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].body.split('\n')[0]).toBe(FIX_STARVED_CAPACITY_MARKER);
    expect(notified).toEqual([expect.objectContaining({ title: '🔔 conveyor — host capacity starved', body: expect.stringMatching(/host capacity/i) })]);
    expect(notified[0].body).toContain('PR #42');
    expect(pass()).toMatchObject({ attempts: 0, capExhausted: false, starved: false });
    expect(posted).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expectNoRepairExhaustion(posted, notified);
  });

  it.each(['ok:false', 'throw', 'missing result'])(
    'REPLAY — PR #2756: failed alert publisher (%s) never notifies or sets starved; recovery posts exactly one durable alert', failure => {
      const thread = [capacityMarker(isoHoursAgo(7)), capacityMarker(isoHoursAgo(6)), capacityMarker(isoHoursAgo(5))];
      const posted = [];
      const notified = [];
      const publisher = vi.fn(() => {
        if (failure === 'throw') throw new Error('publisher unavailable');
        return failure === 'ok:false' ? { ok: false } : undefined;
      });
      const pass = () => recordQueueCapRefusal({
        pr: 2756, repo: 'o/n', headSha: CAPACITY_HEAD, now: CAPACITY_NOW,
        readPrComments: () => thread, postComment: publisher, notify: o => notified.push(o),
      });
      expect(pass()).toMatchObject({ deferredForCapacity: 3, starved: false });
      expect(publisher).toHaveBeenCalledTimes(1);
      expect(publisher.mock.calls[0][0].body).toContain(FIX_STARVED_CAPACITY_MARKER);
      expect(hasFixStarvedCapacityAlert(thread, { headSha: CAPACITY_HEAD })).toBe(false);
      expect(posted).toEqual([]);
      expect(notified).toEqual([]);

      publisher.mockImplementation(o => {
        posted.push(o);
        thread.push({ body: o.body, author: AUTOMATION });
        return { ok: true };
      });
      expect(pass()).toMatchObject({ deferredForCapacity: 3, starved: true });
      expect(pass()).toMatchObject({ deferredForCapacity: 3, starved: false });
      expect(publisher).toHaveBeenCalledTimes(2);
      expect(posted).toHaveLength(1);
      expect(posted[0].body.split('\n')[0]).toBe(FIX_STARVED_CAPACITY_MARKER);
      expect(hasFixStarvedCapacityAlert(thread, { headSha: CAPACITY_HEAD })).toBe(true);
      expect(notified).toHaveLength(1);
      expect(notified[0].body).toContain('PR #2756');
      expect(notified[0].body).toMatch(/host capacity/i);
      expectNoRepairExhaustion(posted, notified);
    },
  );

  it.each([[7, undefined, 1], [5, undefined, 0], [3, 2, 1]])(
    'dispatch threads its clock and settings: %ih old, threshold %s -> %i alert', (age, threshold, alerts) => {
      const thread = [capacityMarker(isoHoursAgo(age))];
      const posted = [];
      const notified = [];
      const options = {
        now: CAPACITY_NOW,
        reconcile: reconcileStub(fixEntries([1854]).map(e => ({ ...e, headRefOid: CAPACITY_HEAD }))),
        ...(threshold === undefined ? {} : { fixSettings: { capacityStarvationHours: threshold } }),
        readPrComments: () => thread,
        postQueueCapComment: o => { posted.push(o); thread.push({ body: o.body, author: AUTOMATION }); return { ok: true }; },
        notifyQueueCapOperator: o => notified.push(o),
      };
      const pass = () => runFix([1854], { tryAdmit: saturated }, options);
      const first = pass();
      expect(first.dispatched).toEqual([]);
      expect(first.result.refusals[0]).toMatchObject({ kind: 'queue-cap', attempts: 0, deferredForCapacity: 2, capExhausted: false });
      pass();
      expect(posted.filter(o => o.body.startsWith(FIX_STARVED_CAPACITY_MARKER))).toHaveLength(alerts);
      expect(notified).toHaveLength(alerts);
      for (const notification of notified) {
        expect(notification).toMatchObject({ title: '🔔 conveyor — host capacity starved', body: expect.stringMatching(/host capacity/i) });
        expect(notification.body).toContain('PR #1854');
      }
      expectNoRepairExhaustion(posted, notified);
    },
  );

  it('a new head restarts the starvation clock and can earn its own alert after another 7h', () => {
    const thread = [capacityMarker(isoHoursAgo(7))];
    const posted = [];
    const notified = [];
    const pass = (head, now) => runFix([1854], { tryAdmit: saturated }, {
      now,
      reconcile: reconcileStub(fixEntries([1854]).map(e => ({ ...e, headRefOid: head }))),
      readPrComments: () => thread,
      postQueueCapComment: o => { posted.push(o); thread.push({ body: o.body, author: AUTOMATION }); return { ok: true }; },
      notifyQueueCapOperator: o => notified.push(o),
    }).result.refusals[0];
    pass(CAPACITY_HEAD, CAPACITY_NOW);
    expect(notified).toHaveLength(1);
    const newHead = 'b'.repeat(40);
    expect(pass(newHead, CAPACITY_NOW)).toMatchObject({ attempts: 0, deferredForCapacity: 1, capExhausted: false });
    expect(notified).toHaveLength(1);
    expect(summarizeCapacityDeferral(thread, { headSha: newHead })).toEqual({
      deferredForCapacity: 1, firstAt: new Date(CAPACITY_NOW).toISOString(), lastAt: new Date(CAPACITY_NOW).toISOString(),
    });
    pass(newHead, CAPACITY_NOW + 7 * HOUR);
    pass(newHead, CAPACITY_NOW + 7 * HOUR);
    expect(notified).toHaveLength(2);
    const alerts = posted.filter(o => o.body.startsWith(FIX_STARVED_CAPACITY_MARKER));
    expect(alerts).toHaveLength(2);
    expect(alerts[0].body).toContain(queueCapHeadLine(CAPACITY_HEAD));
    expect(alerts[1].body).toContain(queueCapHeadLine(newHead));
    expectNoRepairExhaustion(posted, notified);
  });
});

describe('recordQueueCapRefusal — capped legacy history baseline through injected IO', () => {
  const repo = 'web-everything/web-everything';
  const pr = 2756;
  const baselineAt = new Date(CAPACITY_NOW).toISOString();

  it('capped legacy untimed markers with headSha null cannot establish a baseline or alert and remain deferrals with attempts 0', () => {
    const comments = Array.from({ length: QUEUE_CAP_REFUSAL_CAP }, markerComment);
    const postComment = vi.fn();
    const notify = vi.fn();
    const options = { pr, repo, headSha: null, now: CAPACITY_NOW };
    expect(planQueueCapRefusal({ ...options, comments })).toEqual({
      attempts: 0, deferredForCapacity: 3, firstAt: null, capExhausted: false,
      postMarker: false, postBaseline: false, starvation: null,
    });
    const pass = now => recordQueueCapRefusal({
      ...options, now, readPrComments: () => comments, postComment, notify,
    });
    expect(pass(CAPACITY_NOW)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(pass(CAPACITY_NOW + 99 * HOUR)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(postComment).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  function legacyShell() {
    const thread = Array.from({ length: 3 }, () => ({
      body: buildQueueCapRefusalComment('legacy queue-cap refusal', CAPACITY_HEAD),
      author: AUTOMATION,
    }));
    const posted = [];
    const notified = [];
    const reads = [];
    const pass = (now) => recordQueueCapRefusal({
      pr, repo, headSha: CAPACITY_HEAD, now,
      readPrComments: (number, options) => { reads.push({ number, options }); return thread; },
      postComment: (comment) => {
        posted.push(comment);
        thread.push({ body: comment.body, author: AUTOMATION });
        return { ok: true };
      },
      notify: (notification) => notified.push(notification),
    });
    return { thread, posted, notified, reads, pass };
  }

  it('posts exactly one baseline with a leading baseline marker, matching head and valid deferred-at for three untimed legacy markers', () => {
    const { thread, posted, notified, reads, pass } = legacyShell();
    expect(thread).toHaveLength(3);
    expect(thread.every(comment => !comment.body.includes('queue-cap-deferred-at:'))).toBe(true);
    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: null, lastAt: null,
    });

    expect(pass(CAPACITY_NOW)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });

    expect(reads).toEqual([{ number: pr, options: { repo } }]);
    expect(posted).toEqual([{ repo, pr, body: buildCapacityBaselineComment(CAPACITY_HEAD, CAPACITY_NOW) }]);
    const body = posted[0].body;
    expect(body.split('\n')[0]).toBe('⏳ conveyor — host capacity clock started (queue-cap-baseline)');
    expect(body.split('\n')).toContain(queueCapHeadLine(CAPACITY_HEAD));
    const deferredAt = body.match(/^<!-- queue-cap-deferred-at: (.+) -->$/m)?.[1];
    expect(deferredAt).toBe(baselineAt);
    expect(Date.parse(deferredAt)).toBe(CAPACITY_NOW);
    expect(notified).toEqual([]);
  });

  it('reads the persisted baseline as firstAt on a later pass without reposting it or counting it as a capacity deferral', () => {
    const { thread, posted, notified, pass } = legacyShell();
    pass(CAPACITY_NOW);

    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: baselineAt, lastAt: baselineAt,
    });
    expect(pass(CAPACITY_NOW + HOUR)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(posted).toEqual([{ repo, pr, body: buildCapacityBaselineComment(CAPACITY_HEAD, CAPACITY_NOW) }]);
    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: baselineAt, lastAt: baselineAt,
    });
    expect(notified).toEqual([]);
  });

  it('posts exactly one fix-starved-capacity alert only after more than six hours from the persisted baseline', () => {
    const { thread, posted, notified, pass } = legacyShell();
    pass(CAPACITY_NOW);

    expect(pass(CAPACITY_NOW + 6 * HOUR)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(posted).toHaveLength(1);
    expect(notified).toEqual([]);

    const alertAt = CAPACITY_NOW + 6 * HOUR + 1;
    expect(pass(alertAt)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: true });
    expect(pass(CAPACITY_NOW + 7 * HOUR)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(posted).toEqual([
      { repo, pr, body: buildCapacityBaselineComment(CAPACITY_HEAD, CAPACITY_NOW) },
      { repo, pr, body: buildFixStarvedCapacityComment({
        headSha: CAPACITY_HEAD, hours: 6, deferredForCapacity: 3, firstAt: baselineAt,
      }) },
    ]);
    expect(posted.filter(comment => comment.body.startsWith(FIX_STARVED_CAPACITY_MARKER))).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ title: '🔔 conveyor — host capacity starved', body: expect.stringContaining(`PR #${pr}`) });
    expect(posted[1].body).toContain('for 6 hours');
    expect(notified[0].body).toContain('for 6 hours');
    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: baselineAt, lastAt: baselineAt,
    });
    expectNoRepairExhaustion(posted, notified);
  });

  it('ignores an untrusted-author baseline and starts a fresh trusted clock without a premature alert', () => {
    const { thread, posted, notified, pass } = legacyShell();
    thread.push({
      body: buildCapacityBaselineComment(CAPACITY_HEAD, CAPACITY_NOW - 7 * HOUR),
      author: { login: 'untrusted-outsider' },
    });
    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: null, lastAt: null,
    });

    expect(pass(CAPACITY_NOW)).toEqual({ attempts: 0, deferredForCapacity: 3, capExhausted: false, starved: false });
    expect(posted).toEqual([{ repo, pr, body: buildCapacityBaselineComment(CAPACITY_HEAD, CAPACITY_NOW) }]);
    expect(summarizeCapacityDeferral(thread, { headSha: CAPACITY_HEAD })).toEqual({
      deferredForCapacity: 3, firstAt: baselineAt, lastAt: baselineAt,
    });
    expect(notified).toEqual([]);
  });
});
