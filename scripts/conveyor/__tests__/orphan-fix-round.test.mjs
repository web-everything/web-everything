/**
 * The orphaned-fix-round guard. Live 2026-10-10, PR #4715: a fix round addressed the findings but was killed before
 * re-arming, the next round was a restack that by design never touched labels, and the PR then sat `review:changes`
 * with no owner. These fixtures are that thread's real comment shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planOrphanFixRound, runOrphanFixRoundPass, formatOrphanFixRoundLines, buildOrphanGuardComment, verdictReviewedHead,
  ORPHAN_GUARD_MARKER, CHANGES_VERDICT_PREFIX, DEFAULT_ORPHAN_GRACE_MS, defaultListBounced, defaultRearm, defaultRedispatch,
} from '../orphan-fix-round.mjs';
import * as fixDispatch from '../reconcile-fix-dispatch.mjs';
import * as reconcilePass from '../reconcile-pass.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { STAND_DOWN_MARKER } from '../stand-down.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { runFixerStuckReclaimPass, formatFixerStuckReclaimLines } from '../fixer-stuck-reclaim.mjs';
import { buildVerdictComment, buildRearmVerdictBinding, rearmVerdictKey, latestChangesVerdict } from '../../review-set-label.mjs';
import { parseLatestHumanClearedSha } from '../../lib/review-escalation.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import * as referralGate from '../../operations/record-referral-ruling.mjs';

const BOT = { login: 'web-everything' };
// Never-edited comments, as a live `gh pr view --json comments` read reports them; an unstamped automation-posted
// operator ruling needs that proof to clear (PR #6529).
const c = (createdAt, body, author = BOT) => ({ createdAt, includesCreatedEdit: false, body, author });
const NOW = Date.parse('2026-10-10T15:48:00Z');
const HEAD = '124e242dac0adc572aaa013a35ff007b8e6f859a';
const VERDICT = c('2026-10-09T22:42:48Z', `${CHANGES_VERDICT_PREFIX}\n\nRecorded by agent.\n\nNet basis: \`0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec..d9829f557f3f264ac885722cb9afef18bd91ca7f\` (rev at review time)`);
const EVIDENCE = c('2026-10-10T11:21:37Z', '## 🔧 conveyor fix — evidence for the `review:changes` round on this PR\n\nFix commit: …');
const BEGIN = c('2026-10-10T15:03:55Z', `${FIX_BEGIN_MARKER}\n\n**Who:** \`fix-4715\``);
const RESTACK = c('2026-10-10T15:21:28Z', '🔁 restack — merged `origin/lane/gh-merge-queue-gate` into this branch.');
const END = c('2026-10-10T15:21:33Z', `${FIX_END_MARKER}\n\n\`fix-4715\` released the fix claim at \`124e242da\`.`);
const pr4715 = (comments, extra = {}) => ({ number: 4715, labels: [{ name: 'review:changes' }, { name: 'review-round:1' }], headRefOid: HEAD, isDraft: false, comments, ...extra });

it('recovers a concurrent same-head send-back after the pinned re-arm marker and operator ruling (PR #5925)', async () => {
  const { default: scenario } = await import('../soak/breaks/pinned-rearm-orphan-marker.mjs');
  const report = await scenario.run({ log: line => console.log(line) });
  expect(scenario.judge(report)).toEqual([]);
});

it('replays same-second operator rulings and malformed history through the orphan IO shell (PR #5925)', async () => {
  const { default: scenario } = await import('../soak/breaks/automation-operator-ruling-orphan.mjs');
  const report = await scenario.run({ log: line => console.log(line) });
  expect(scenario.judge(report)).toEqual([]);
});

it('holds incomplete listings and processes complete listings through the 500-PR boundary (PR #7429)', async () => {
  const { default: scenario } = await import('../soak/breaks/orphan-guard-lists-past-200.mjs');
  const report = await scenario.run({});
  expect(scenario.judge(report)).toEqual([]);
});

describe('verdict-bound orphan re-arm markers', () => {
  const verdict = { ...VERDICT, id: 'IC_verdict' };
  const marker = binding => c('2026-10-10T15:22:00Z', REARM_COMMENT_MARKER + binding);
  const plan = (binding, current = verdict, author = BOT) => planOrphanFixRound({
    pr: pr4715([current, EVIDENCE, END, { ...marker(binding), author }]), nowMs: NOW,
  });

  it('suppresses a repeat only for the verdict the marker actually re-armed', () => {
    const binding = buildRearmVerdictBinding(verdict);
    expect(plan(binding).reason).toBe('already re-armed after the latest verdict');
    expect(plan(binding, { ...verdict, id: 'IC_other' }).decision).toBe('rearm');
    expect(plan(binding, { ...verdict, body: verdict.body + '\nNew finding' }).decision).toBe('rearm');
    expect(plan(binding, verdict, { login: 'drive-by' }).decision).toBe('rearm');
  });

  it('normalizes GraphQL and REST identity and timestamp fields to the same binding', () => {
    const rest = { node_id: verdict.id, id: 42, created_at: new Date(verdict.createdAt).toISOString(), body: verdict.body };
    expect(rearmVerdictKey(rest)).toBe(rearmVerdictKey(verdict));
  });

  it('honors a bound re-arm marker later in the thread in the verdict timestamp second', () => {
    const sameSecondMarker = { ...marker(buildRearmVerdictBinding(verdict)), createdAt: verdict.createdAt };
    expect(planOrphanFixRound({ pr: pr4715([verdict, sameSecondMarker, EVIDENCE, END]), nowMs: NOW }).reason)
      .toBe('already re-armed after the latest verdict');
  });

  it('does not let a marker before the verdict suppress recovery despite its later timestamp', () => {
    expect(planOrphanFixRound({ pr: pr4715([marker(buildRearmVerdictBinding(verdict)), verdict, EVIDENCE, END]), nowMs: NOW }).decision)
      .toBe('rearm');
  });

  it('selects the latest trusted verdict even when two verdicts have identical bodies and timestamps', () => {
    const newer = { ...verdict, id: 'IC_newer' };
    const forged = { ...newer, id: 'IC_forged', author: { login: 'drive-by' } };
    expect(latestChangesVerdict([verdict, newer, forged])).toBe(newer);
    expect(rearmVerdictKey(newer)).not.toBe(rearmVerdictKey(verdict));
  });

  it.each([
    buildRearmVerdictBinding(null),
    buildRearmVerdictBinding(VERDICT), // No comment identity: do not claim coverage.
    '\n\n<!-- rearm-verdict-v1: invalid -->',
    '\n\n<!-- rearm-verdict-v2: unknown -->',
    buildRearmVerdictBinding(verdict) + buildRearmVerdictBinding(verdict),
  ])('keeps recovery actionable for missing, malformed or duplicate binding: %s', binding => {
    expect(plan(binding).decision).toBe('rearm');
  });

  it('preserves chronological handling of historical unbound markers', () => {
    expect(plan('\n\nHistorical re-arm').reason).toBe('already re-armed after the latest verdict');
  });
});

describe('defaultListBounced', () => {
  const restPr = number => ({ number, labels: [], head: { sha: HEAD }, draft: false,
    body: `PR ${number}`, created_at: '2026-10-09T22:42:48Z' });

  it('lists a bounced PR past the newest 200 within the newest 500', () => {
    const prs = Array.from({ length: 250 }, (_, i) => restPr(250 - i));
    prs[249].labels = [{ name: 'review:changes' }];
    const exec = vi.fn()
      .mockReturnValueOnce(JSON.stringify(prs.slice(0, 100)))
      .mockReturnValueOnce(JSON.stringify(prs.slice(100, 200)))
      .mockReturnValueOnce(JSON.stringify(prs.slice(200)));
    expect(defaultListBounced('o/n', { exec })).toEqual([{
      number: 1, labels: [{ name: 'review:changes' }], headRefOid: HEAD, isDraft: false,
      body: 'PR 1', createdAt: prs[249].created_at,
    }]);
    expect(exec).toHaveBeenCalledTimes(3);
    for (const [i, [command, args, opts]] of exec.mock.calls.entries()) {
      expect(command).toBe('gh');
      expect(args).toEqual(['api', `repos/o/n/pulls?state=open&sort=created&direction=desc&per_page=100&page=${i + 1}`]);
      expect(opts).toMatchObject({ encoding: 'utf8', timeout: expect.any(Number), maxBuffer: 16 * 1024 * 1024 });
    }
  });

  it.each([499, 500])('accepts a complete listing of %s PRs including the newest and oldest bounced PRs', count => {
    const prs = Array.from({ length: count }, (_, i) => restPr(count - i));
    prs[0].labels = prs[count - 1].labels = [{ name: 'review:changes' }];
    const exec = vi.fn((_command, args) => {
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      return JSON.stringify(prs.slice((page - 1) * 100, page * 100));
    });
    expect(defaultListBounced('o/boundary', { exec }).map(pr => pr.number)).toEqual([count, 1]);
    expect(exec).toHaveBeenCalledTimes(count === 500 ? 6 : 5);
  });

  it.each(['http', 'json', 'shape', 'null', 'buffer', 'deadline'])('holds an inconclusive boundary probe (%s) and accepts a complete retry', async kind => {
    const prs = Array.from({ length: 500 }, (_, i) => restPr(500 - i));
    prs[0].labels = [{ name: 'review:changes' }];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failing = true;
    const exec = vi.fn((_command, args) => {
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      if (failing && page === 6) {
        if (kind === 'json') return '{';
        if (kind === 'shape') return '{"length":0}';
        if (kind === 'null') return 'null';
        throw new Error(kind === 'http' ? 'HTTP 503' : 'ENOBUFS');
      }
      if (failing && kind === 'deadline' && page === 5) clock.mockReturnValue(1000);
      return JSON.stringify(prs.slice((page - 1) * 100, page * 100));
    });
    const readComments = vi.fn(async () => [VERDICT, EVIDENCE, END]);
    const rearm = vi.fn(async () => ({ ok: true }));
    const options = { repos: [{ key: 'test', slug: 'o/boundary' }], env: {}, nowMs: NOW,
      listBounced: slug => defaultListBounced(slug, { exec, deadlineAt: 1000 }),
      readComments, rearm, isOwned: async () => false, postComment: () => {} };
    try {
      const failed = await runOrphanFixRoundPass({ ...options, cursor: { 'o/boundary': 1 } });
      expect(failed.rows).toEqual([{ repo: 'o/boundary', decision: 'error', reason: expect.stringContaining('listing failed:') }]);
      expect(failed.repoCursors).toEqual({ 'o/boundary': 1 });
      expect(exec).toHaveBeenCalledTimes(kind === 'deadline' ? 5 : 6);
      expect(readComments).not.toHaveBeenCalled();
      expect(rearm).not.toHaveBeenCalled();
      failing = false;
      clock.mockReturnValue(0);
      const retried = await runOrphanFixRoundPass({ ...options, cursor: failed.repoCursors });
      expect(retried.rows).toEqual([expect.objectContaining({ pr: 500, decision: 'rearm', result: 're-armed' })]);
      expect(readComments).toHaveBeenCalledOnce();
      expect(rearm).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      warning.mockRestore();
    }
  });

  it('warns when the lookahead confirms overflow and stops at six calls', () => {
    const exec = vi.fn(() => JSON.stringify(Array.from({ length: 100 }, (_, i) => restPr(i + 1))));
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => defaultListBounced('o/capped', { exec })).toThrow('listing cap hit');
      expect(exec).toHaveBeenCalledTimes(6);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0][0]).toContain('listing cap hit (5 pages, 500 PRs); older PRs not scanned this pass');
      expect(warning.mock.calls[0][0]).not.toMatch(/[\r\n]/);
    } finally {
      warning.mockRestore();
    }
  });

  it('starts at page one on every pass and rejects even one PR beyond the newest 500', () => {
    const prs = Array.from({ length: 501 }, (_, i) => restPr(501 - i));
    prs[499].labels = [{ name: 'review:changes' }];
    prs[500].labels = [{ name: 'review:changes' }];
    const exec = vi.fn((_command, args) => {
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      return JSON.stringify(prs.slice((page - 1) * 100, page * 100));
    });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(() => defaultListBounced('o/stateless', { exec })).toThrow('listing cap hit');
      }
      expect(exec).toHaveBeenCalledTimes(12);
      expect(exec.mock.calls.map(([, args]) => Number(new URLSearchParams(args[1].split('?')[1]).get('page'))))
        .toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('stops paging at the deadline but always fetches the first page', () => {
    const prs = Array.from({ length: 100 }, (_, i) => restPr(100 - i));
    prs[0].labels = [{ name: 'review:changes' }];
    const exec = vi.fn(() => JSON.stringify(prs));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => defaultListBounced('o/deadline', { exec, deadlineAt: 1000 })).toThrow('listing deadline reached');
      expect(exec).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith('orphan-guard: listing deadline reached; older PRs not scanned this pass');
    } finally {
      clock.mockRestore();
      warning.mockRestore();
    }
  });

  it.each([true, false])('rejects incomplete listings after a later page fails (bounced=%s)', bounced => {
    const prs = Array.from({ length: 100 }, (_, i) => restPr(100 - i));
    if (bounced) prs[0].labels = [{ name: 'review:changes' }];
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify(prs)).mockImplementationOnce(() => { throw new Error('unreadable'); });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => defaultListBounced('o/partial', { exec })).toThrow('unreadable');
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('rethrows a first-page failure without claiming an empty listing', () => {
    const error = new Error('unreadable');
    const exec = vi.fn(() => { throw error; });
    expect(() => defaultListBounced('o/unreadable', { exec })).toThrow(error);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('accepts a complete empty first page even when the deadline has expired', () => {
    const exec = vi.fn(() => '[]');
    expect(defaultListBounced('o/empty', { exec, deadlineAt: 0 })).toEqual([]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each(['http', 'json', 'buffer'])('reports a later-page %s failure to the guard and preserves its retry cursor', async kind => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, i) => restPr(i + 2))))
      .mockImplementationOnce(() => {
        if (kind === 'json') return '{';
        throw new Error(kind === 'http' ? 'HTTP 503' : 'ENOBUFS');
      });
    const readComments = vi.fn();
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runOrphanFixRoundPass({ repos: [{ key: 'test', slug: 'o/partial' }], env: {},
        cursor: { 'o/partial': 1 }, listBounced: slug => defaultListBounced(slug, { exec }), readComments });
      expect(result.rows).toEqual([{ repo: 'o/partial', decision: 'error', reason: expect.stringContaining('listing failed:') }]);
      expect(result.repoCursors).toEqual({ 'o/partial': 1 });
      expect(readComments).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});

describe('defaultRearm child diagnostics', () => {
  it('surfaces the first non-empty child stderr lines and forwards the full head pin', () => {
    const exec = vi.fn(() => { throw Object.assign(new Error('Command failed: node rearm-review.mjs'), {
      stderr: Buffer.from('\n\u001b[31mlive head differs from --expect-head\u001b[0m\nrefused\u0000\n'),
      stdout: Buffer.from(JSON.stringify({ reason: '\u001b[31mshared refusal\u001b[0m\u0000\u202e' })),
    }); });
    expect(() => defaultRearm({ slug: 'o/n', pr: 5608, head: HEAD, exec }))
      .toThrow('orphan-guard re-arm failed: live head differs from --expect-head; refused; shared refusal');
    expect(exec.mock.calls[0][1]).toContain(`--expect-head=${HEAD}`);
  });

  it('caps oversized stderr at 300 characters', () => {
    const exec = () => { throw Object.assign(new Error('Command failed'), { stderr: 'x'.repeat(1000) }); };
    expect(() => defaultRearm({ slug: 'o/n', pr: 5608, exec }))
      .toThrow(new Error(`orphan-guard re-arm failed: ${'x'.repeat(300)}`));
  });

  it.each([
    JSON.stringify({ reason: '\u001b[31mlive head differs from --expect-head\u001b[0m\u0000' }),
    JSON.stringify({ error: 'live head differs from --expect-head' }),
    '\n\u001b[31mlive head differs from --expect-head\u001b[0m\u0000\nignored second line',
  ])('surfaces sanitized stdout when stderr is empty: %s', stdout => {
    const exec = () => { throw Object.assign(new Error('Command failed'), { stdout, stderr: '' }); };
    expect(() => defaultRearm({ slug: 'o/n', pr: 5608, exec }))
      .toThrow(new Error('orphan-guard re-arm failed: live head differs from --expect-head'));
  });

  it.each(['x'.repeat(1000), JSON.stringify({ reason: 'x'.repeat(1000) })])('caps oversized stdout at 300 characters', stdout => {
    const exec = () => { throw Object.assign(new Error('Command failed'), { stdout }); };
    expect(() => defaultRearm({ slug: 'o/n', pr: 5608, exec }))
      .toThrow(new Error(`orphan-guard re-arm failed: ${'x'.repeat(300)}`));
  });

  it('names the missing-output fallback', () => {
    const exec = () => { throw new Error('spawn failed'); };
    expect(() => defaultRearm({ slug: 'o/n', pr: 5608, exec }))
      .toThrow('orphan-guard re-arm failed: child failed without stderr or stdout');
  });
});

describe('planOrphanFixRound — the #4715 shapes', () => {
  it('holds a new unanswered stand-down after rearm but permits non-rearm answered redispatch', () => {
    const stamp = (body, id) => ({ ...c('2026-10-10T15:22:00Z', body), id });
    const stop = id => stamp(buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head: HEAD }), id);
    const answer = (id, disposition) => stamp(buildOperatorAnswer({ standDownId: id,
      reason: 'ruled', actor: 'chalbert', channel: 'chat', ...(disposition ? { disposition } : {}) }), 'answer-' + id);
    const comments = [VERDICT, BEGIN, stop('old'), answer('old', 'rearm-review'), BEGIN, stop('new')];
    const plan = comments => planOrphanFixRound({ pr: pr4715(comments), nowMs: NOW });
    expect(plan(comments)).toMatchObject({ decision: 'none', reason: 'stood down — the stand-down answer owns it' });
    expect(plan([...comments, answer('old', 'rearm-review')]).decision).toBe('none');
    expect(plan([...comments, { ...answer('new'), author: { login: 'outsider' }, viewerDidAuthor: true }]).decision).toBe('none');
    expect(plan([...comments, answer('new')]).decision).toBe('redispatch');
  });

  it.each([
    ['not bounced', pr4715([], { labels: [] })],
    ['human-cleared head', pr4715([
      c('2026-10-10T15:22:00Z', buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: HEAD }), { login: 'chalbert' }),
    ])],
    ['no trusted changes verdict', pr4715([])],
    ['no fix round since the latest verdict', pr4715([VERDICT])],
  ])('marks %s as a stable none verdict', (_reason, pr) => {
    expect(planOrphanFixRound({ pr, nowMs: NOW })).toMatchObject({ decision: 'none', stable: true });
  });

  it('re-arms the live #4715 thread: findings addressed (evidence, head moved), round ended, never re-armed', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, EVIDENCE, BEGIN, RESTACK, END]), nowMs: NOW });
    expect(p.decision).toBe('rearm');
    expect(p.roundAt).toBe('2026-10-10T15:21:33.000Z');
  });

  it('a trusted human clearance prevents rearm only when it names the current head', () => {
    const withClearance = (headSha) => pr4715([VERDICT, EVIDENCE, BEGIN, RESTACK, END,
      { ...c('2026-10-10T15:22:00Z', buildVerdictComment({ to: 'clear-human', actor: 'Nicolas Gilbert', headSha }), { login: 'chalbert' }), id: 'IC_human_clearance' },
    ]);
    const olderHead = 'd9829f557f3f264ac885722cb9afef18bd91ca7f';
    const older = withClearance(olderHead);
    expect(parseLatestHumanClearedSha(older.comments)).toBe(olderHead);
    expect(planOrphanFixRound({ pr: older, nowMs: NOW }).decision).toBe('rearm');

    const cleared = withClearance(HEAD);
    expect(parseLatestHumanClearedSha(cleared.comments)).toBe(cleared.headRefOid);
    expect(planOrphanFixRound({ pr: cleared, nowMs: NOW }).decision).toBe('none');
  });

  it('clear-human then a same-head plain accept remains protected from orphan rearm', () => {
    const pr = pr4715([VERDICT, EVIDENCE, BEGIN, RESTACK, END,
      { ...c('2026-10-10T15:22:00Z', buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: HEAD }), { login: 'chalbert' }), id: 'IC_human_clearance' },
      c('2026-10-10T15:23:00Z', buildVerdictComment({ to: 'accepted', actor: 'reviewer', headSha: HEAD })),
    ]);
    expect(parseLatestHumanClearedSha(pr.comments)).toBeNull();
    expect(planOrphanFixRound({ pr, nowMs: NOW })).toEqual({ decision: 'none', reason: 'human-cleared head — final', stable: true });
  });

  it.each([
    ['trusted current-head clearance', HEAD, { login: 'chalbert' }, 'none'],
    ['trusted stale-head clearance', 'd9829f557f3f264ac885722cb9afef18bd91ca7f', { login: 'chalbert' }, 'rearm'],
    ['untrusted current-head marker', HEAD, { login: 'drive-by' }, 'rearm'],
    ['current-head marker with no author', HEAD, null, 'rearm'],
  ])('orphan guard respects %s with a mixed-case live head', (_name, headSha, author, decision) => {
    const pr = pr4715([VERDICT, EVIDENCE, BEGIN, RESTACK, END,
      { ...c('2026-10-10T15:22:00Z', buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha }), author), id: 'IC_human_clearance' },
    ], { headRefOid: HEAD.toUpperCase() });
    const plan = planOrphanFixRound({ pr, nowMs: NOW });
    expect(plan.decision).toBe(decision);
    if (decision === 'none') expect(plan).toEqual({ decision: 'none', reason: 'human-cleared head — final', stable: true });
  });

  it('re-dispatches a restack-only round that never addressed the review', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, BEGIN, RESTACK, END]), nowMs: NOW });
    expect(p.decision).toBe('redispatch');
    expect(p.reason).toMatch(/no fix evidence/);
  });

  it('a killed round (fix-begin, no fix-end, claim gone) is also an ended round', () => {
    expect(planOrphanFixRound({ pr: pr4715([VERDICT, BEGIN]), nowMs: NOW }).decision).toBe('redispatch');
  });

  it('re-dispatches when evidence exists but the head never moved past the reviewed head', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, EVIDENCE, END], { headRefOid: 'd9829f557f3f264ac885722cb9afef18bd91ca7f' }), nowMs: NOW });
    expect(p.decision).toBe('redispatch');
  });

  it('escalates after the guard already re-dispatched twice since the verdict', () => {
    const mark = (t) => c(t, `${ORPHAN_GUARD_MARKER} — re-dispatched a fixer\n\n…`);
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, mark('2026-10-10T12:00:00Z'), mark('2026-10-10T14:00:00Z'), BEGIN, END]), nowMs: NOW });
    expect(p.decision).toBe('escalate');
  });

  it.each([
    ['a live claim owns it', { owned: true }, [VERDICT, BEGIN, END], {}],
    ['already re-armed after the verdict', {}, [VERDICT, BEGIN, END, c('2026-10-10T15:22:00Z', `${REARM_COMMENT_MARKER}\n\n…`)], {}],
    ['no fix round since the verdict (the ordinary dispatcher owns it)', {}, [EVIDENCE, VERDICT], {}],
    ['still inside the grace after fix-end', { nowMs: Date.parse(END.createdAt) + DEFAULT_ORPHAN_GRACE_MS - 1 }, [VERDICT, BEGIN, END], {}],
    ['not bounced', {}, [VERDICT, BEGIN, END], { labels: [{ name: 'review:pending' }] }],
    ['draft', {}, [VERDICT, BEGIN, END], { isDraft: true }],
    ['a person owns it (review:human)', {}, [VERDICT, BEGIN, END], { labels: ['review:changes', 'review:human'] }],
  ])('does nothing when %s', (_name, opts, comments, extra) => {
    expect(planOrphanFixRound({ pr: pr4715(comments, extra), nowMs: NOW, ...opts }).decision).toBe('none');
  });

  it('an untrusted author cannot forge the verdict, the evidence or the fix-end', () => {
    const anon = { login: 'drive-by' };
    expect(planOrphanFixRound({ pr: pr4715([c(VERDICT.createdAt, VERDICT.body, anon), BEGIN, END]), nowMs: NOW }).decision).toBe('none');
    expect(planOrphanFixRound({ pr: pr4715([VERDICT, c(EVIDENCE.createdAt, EVIDENCE.body, anon), BEGIN, END]), nowMs: NOW }).decision).toBe('redispatch');
  });

  it('reads the reviewed head off the verdict', () => {
    expect(verdictReviewedHead(VERDICT.body)).toBe('d9829f557f3f264ac885722cb9afef18bd91ca7f');
    expect(verdictReviewedHead('no basis')).toBeNull();
  });
});

describe('planOrphanFixRound — #5608 operator referral rulings', () => {
  const repo = 'o/r';
  const card = 'we:backlog/xvm9vbu-follow-up.md';
  const body = '<!-- authored-by-actor: author -->';
  const verdictAt = '2026-10-10T12:00:00Z';
  const rulingAt = '2026-10-10T13:00:00Z';
  const seat = 'judgeCorrectnessAdvisory';
  const reviewer = mandatoryReferralReviewer('review-pr-5608');
  const referrals = ['first defect', 'second defect'].map((summary) => {
    const original = { summary, file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    return { key: referralFindingKey(seat, original), seat, original, finding: normalizeFinding(original) };
  });
  const record = { version: 1, repo, pr: 5608, head: HEAD, runId: 'review-pr-5608', reviewer, authorBody: body,
    attempted: true, referrals, rulings: referrals.map(({ key }, i) => ({ id: `review-pr-5608:${i}`, key,
      reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'checked', evidence: ['diff'] })) };
  const verdict = c(verdictAt, `${CHANGES_VERDICT_PREFIX}\n\n### Blocked referral findings\n\nStill blocked on head \`${HEAD}\`.`);
  const ruling = (count = 2, extra = {}, author = { login: 'chalbert' }) => c(rulingAt, buildOperatorRulingComment({
    version: 1, repo, pr: 5608, head: HEAD, actor: 'chalbert', channel: 'claude-code-chat', reason: 'Accept',
    at: rulingAt, clearerId: 'session-1',
    rulings: referrals.slice(0, count).map(({ key }) => ({ runId: record.runId, key, result: 'card', card })), ...extra,
  }), author);
  const thread = (answer = ruling(), extra = {}) => ({ number: 5608, body, createdAt: '2026-10-09T12:00:00Z',
    labels: ['review:changes', 'review:human', 'review-round:3'], headRefOid: HEAD,
    comments: [c('2026-10-10T11:00:00Z', renderReferralRecord(record)), verdict, answer], ...extra });
  const plan = (pr, extra = {}) => planOrphanFixRound({ pr, repo, nowMs: NOW, cardReadable: (ref) => ref === card, ...extra });

  it('re-arms a fully carded thread without a fix round even with review:human', () => {
    expect(plan(thread())).toMatchObject({ decision: 'rearm', verdictAt: new Date(verdictAt).toISOString(),
      rulingAt: new Date(rulingAt).toISOString(), reason: expect.stringContaining('no fix is owed') });
  });

  it('re-arms when the verdict and later operator ruling have identical createdAt', () => {
    const answer = { ...ruling(2, { at: verdictAt }), createdAt: verdictAt };
    expect(plan(thread(answer))).toMatchObject({ decision: 'rearm', rulingAt: new Date(verdictAt).toISOString() });
  });

  it('selects the latest ruling by thread position even when its timestamp is earlier', () => {
    const pr = thread();
    pr.comments.push({ ...ruling(2, { at: verdictAt }), createdAt: verdictAt });
    expect(plan(pr)).toMatchObject({ decision: 'rearm', rulingAt: new Date(verdictAt).toISOString() });
  });

  it('keeps a malformed operator ruling after a blocked-referral verdict with a person even after a fix round', () => {
    const answer = c(rulingAt,
      '## Operator ruling on mandatory referrals\n\n<!-- mandatory-referral-operator-ruling-v1: not-base64 -->');
    const pr = thread(answer, { labels: ['review:changes'] });
    pr.comments.push(EVIDENCE, END);
    expect(plan(pr)).toEqual({ decision: 'none', reason: 'malformed referral history — it stays with a person' });
  });

  it.each(['malformed', 'protectionMalformed'])('fails closed for gate.%s despite a completed fix round', (flag) => {
    const pr = thread(ruling(), { labels: ['review:changes'] });
    pr.comments.push(EVIDENCE, END);
    const gate = referralGate.openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: HEAD,
      body, createdAt: pr.createdAt, cardReadable: () => true });
    const spy = vi.spyOn(referralGate, 'openReferralFindings').mockReturnValueOnce({ ...gate, [flag]: true });
    try {
      expect(plan(pr)).toEqual({ decision: 'none', reason: 'malformed referral history — it stays with a person' });
      expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it.each(['disputed', 'pending', 'blocked'])('keeps gate.%s with a person when open is empty and ruled is non-empty', (flag) => {
    const pr = thread(ruling(), { labels: ['review:changes'] });
    pr.comments.push(EVIDENCE, END);
    const gate = referralGate.openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: HEAD,
      body, createdAt: pr.createdAt, cardReadable: () => true });
    expect(gate.open).toEqual([]);
    expect(gate.ruled).not.toHaveLength(0);
    const spy = vi.spyOn(referralGate, 'openReferralFindings').mockReturnValueOnce({ ...gate, [flag]: ['unresolved hold'] });
    try {
      expect(plan(pr)).toMatchObject({ decision: 'none', reason: expect.stringContaining('partial: 0 referral finding(s) still open') });
      expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it('does not re-arm a fully carded thread while a stand-down is unresolved', () => {
    const pr = thread();
    pr.comments.splice(2, 0, c('2026-10-10T12:30:00Z', `${STAND_DOWN_MARKER}\n\nneeds a person`));
    expect(plan(pr)).toMatchObject({ decision: 'none', reason: expect.stringContaining('stood down') });
  });

  it('does not re-arm a fully carded thread followed by a malformed operator ruling', () => {
    const pr = thread();
    pr.comments.push(c('2026-10-10T14:00:00Z',
      '## Operator ruling on mandatory referrals\n\n<!-- mandatory-referral-operator-ruling-v1: not-base64 -->',
      { login: 'chalbert' }));
    expect(plan(pr).decision).not.toBe('rearm');
  });

  it('keeps a partial ruling with a person, even if a fix round ended', () => {
    const pr = thread(ruling(1));
    pr.comments.push(END);
    expect(plan(pr)).toMatchObject({ decision: 'none', rulingAt: new Date(rulingAt).toISOString(),
      reason: expect.stringContaining('partial: 1 referral finding(s) still open') });
    expect(plan(pr).reason).toContain('1 blocked, 0 awaiting');
  });

  it('falls through when the head moved since the send-back', () => {
    expect(plan(thread(ruling(), { headRefOid: 'b'.repeat(40) }))).toMatchObject({ decision: 'none',
      reason: expect.stringContaining('no fix round since the latest verdict') });
  });

  it('does not count an automatic policy ruling, even when operator-authored', () => {
    const auto = ruling(2, { actor: 'auto-policy', channel: 'policy',
      rulings: referrals.map(({ key }) => ({ runId: record.runId, key, result: 'block' })) });
    expect(auto.body).toMatch(/^## Automatic policy ruling/);
    expect(plan(thread(auto)).reason).toContain('no fix round since the latest verdict');
  });

  it('fails closed to a partial ruling when cards are not readable by default', () => {
    const p = planOrphanFixRound({ pr: thread(), repo, nowMs: NOW });
    expect(p.decision).toBe('none');
    expect(p.reason).toContain('partial: 2 referral finding(s) still open');
    expect(p.reason).toContain('0 blocked, 2 awaiting');
  });

  it('leaves ordinary changes verdicts on the existing path', () => {
    const pr = thread();
    pr.comments[1] = c(verdictAt, `${CHANGES_VERDICT_PREFIX}\n\nOrdinary review findings.`);
    expect(plan(pr).reason).toContain('no fix round since the latest verdict');
  });

  it.each(['card', 'not-real'])('re-arms an automation-posted operator %s ruling', (result) => {
    const answer = ruling(2, { rulings: referrals.map(({ key }) => ({
      runId: record.runId, key, result, ...(result === 'card' ? { card } : {}),
    })) }, BOT);
    expect(plan(thread(answer))).toMatchObject({ decision: 'rearm',
      rulingAt: new Date(rulingAt).toISOString() });
  });

  it.each([false, true])('keeps an untrusted operator ruling with a person (completed fix round: %s)', (completedFix) => {
    // The shared referral gate flags an outsider's copy as malformed, rather than ignoring it.
    // Remove the human label so it cannot mask a fallback into ordinary fix-round recovery.
    const pr = thread(ruling(2, {}, { login: 'mallory' }), { labels: ['review:changes'] });
    if (completedFix) pr.comments.push(EVIDENCE, END);
    expect(plan(pr)).toEqual({ decision: 'none', reason: 'malformed referral history — it stays with a person' });
  });

  it('keeps an untrusted operator ruling with a person even after a settled operator ruling', () => {
    const pr = thread(ruling(), { labels: ['review:changes'] });
    pr.comments.push(ruling(2, {}, { login: 'mallory' }));
    expect(plan(pr)).toEqual({ decision: 'none', reason: 'malformed referral history — it stays with a person' });
  });

  it('keeps an automation-posted partial ruling with a person', () => {
    expect(plan(thread(ruling(1, {}, BOT)))).toMatchObject({ decision: 'none',
      reason: expect.stringContaining('partial: 1 referral finding(s) still open') });
  });

  it('rejects an automation-posted ruling with a hand-edited operator assertion', () => {
    const answer = ruling(2, {}, BOT);
    answer.body = answer.body.replace('@chalbert', '@mallory');
    expect(plan(thread(answer)).decision).toBe('none');
  });

  it('does not treat an automation-posted policy block as an operator answer', () => {
    const answer = ruling(2, { actor: 'auto-policy', channel: 'policy',
      rulings: referrals.map(({ key }) => ({ runId: record.runId, key, result: 'block' })),
    }, BOT);
    expect(plan(thread(answer)).reason).toContain('no fix round since the latest verdict');
  });

  it('matches an abbreviated send-back head and falls back to Net basis', () => {
    for (const text of [`on head \`${HEAD.slice(0, 9)}\``, `Net basis: \`${'a'.repeat(40)}..${HEAD}\``]) {
      const pr = thread();
      pr.comments[1] = c(verdictAt, `${CHANGES_VERDICT_PREFIX}\n\n### Blocked referral findings\n\n${text}`);
      expect(plan(pr).decision).toBe('rearm');
    }
  });

  it('fails closed if the gate reader throws even after a fix round', () => {
    const pr = thread(ruling(), { labels: ['review:changes'] });
    pr.comments.push(EVIDENCE, END);
    expect(plan(pr, { cardReadable: () => { throw new Error('unreadable'); } }))
      .toEqual({ decision: 'none', reason: 'malformed referral history — it stays with a person' });
  });

  it.each(['chalbert', 'web-everything'])('passes a ruling posted by %s through the IO shell', async (login) => {
    const pr = thread(ruling(2, {}, { login }));
    const rearm = vi.fn(async () => ({ ok: true }));
    const cardReadable = vi.fn((ref) => ref === card);
    const result = await runOrphanFixRoundPass({ repos: [{ key: 'test', slug: repo }], nowMs: NOW, env: {},
      listBounced: () => [pr], readComments: async () => pr.comments, isOwned: async () => false,
      cardReadable, rearm, postComment: vi.fn() });
    expect(result.rows[0]).toMatchObject({ decision: 'rearm', result: 're-armed' });
    expect(rearm).toHaveBeenCalledWith({ slug: repo, pr: 5608, head: HEAD });
    expect(cardReadable).toHaveBeenCalledWith(card);
  });
});

describe('runOrphanFixRoundPass — IO shell', () => {
  const repos = [{ key: 'we', slug: 'web-everything/web-everything' }];
  const seams = (comments, over = {}) => ({
    repos, nowMs: NOW, env: {},
    listBounced: () => [{ number: 4715, labels: [{ name: 'review:changes' }], headRefOid: HEAD, isDraft: false }],
    readComments: async () => comments,
    isOwned: async () => false,
    rearm: vi.fn(async () => ({ ok: true })),
    redispatch: vi.fn(async () => ({ ok: true })),
    escalate: vi.fn(async () => ({ ok: true })),
    postComment: vi.fn(),
    ...over,
  });

  it('settles stable no-fix verdicts instead of deferring wrapped PRs forever', async () => {
    const settled = new Map();
    const readComments = vi.fn(async () => [VERDICT]);
    const s = seams([], { settled, readComments, deadlineAt: 0, now: () => 0,
      listBounced: () => [1, 2, 3, 4, 5].map(number => pr4715([], { number })) });
    let cursor = null;
    const deferred = [];
    for (let pass = 0; pass < 6; pass++) {
      const result = await runOrphanFixRoundPass({ ...s, cursor });
      cursor = result.repoCursors;
      deferred.push(result.deferred.length);
      expect(result.newlySettled).toHaveLength(1);
      expect(result.deferredSettled).toHaveLength(Math.min(pass, 4));
    }
    expect(deferred).toEqual([4, 3, 2, 1, 0, 0]);
    expect(readComments).toHaveBeenCalledTimes(6);
  });

  it.each(['head moved', 'TTL expired', 'missing head', 'future timestamp'])('re-reads settled evidence when %s', async reason => {
    const settled = new Map([[`${repos[0].slug}#4715`, {
      head: reason === 'head moved' ? 'other' : reason === 'missing head' ? undefined : HEAD,
      at: reason === 'TTL expired' ? NOW - 6 * 60 * 60 * 1000 : reason === 'future timestamp' ? NOW + 1 : NOW,
    }]]);
    const readComments = vi.fn(async () => [VERDICT]);
    const result = await runOrphanFixRoundPass(seams([], { settled, readComments }));
    expect(readComments).toHaveBeenCalledOnce();
    expect(result.deferredSettled).toEqual([]);
    expect(result.newlySettled).toEqual([{ repo: repos[0].slug, pr: 4715 }]);
    expect(settled.get(`${repos[0].slug}#4715`)).toEqual({ head: HEAD, at: NOW });
  });

  describe('settled cache: removing the head or TTL check fails a test', () => {
    const probe = async cached => {
      const readComments = vi.fn(async () => [VERDICT]);
      await runOrphanFixRoundPass(seams([], {
        settled: new Map([[`${repos[0].slug}#4715`, cached]]), readComments,
        listBounced: () => [pr4715([]), pr4715([], { number: 5000 })],
        isOwned: async (_repo, number) => number === 5000,
        deadlineAt: 0, now: () => 0,
      }));
      return readComments;
    };

    it('reads a matching head with stale TTL', async () => {
      const readComments = await probe({ head: HEAD, at: NOW - 6 * 60 * 60 * 1000 });
      expect(readComments.mock.calls).toEqual([[4715, repos[0].slug]]);
    });

    it('reads a different head with fresh TTL', async () => {
      const readComments = await probe({ head: 'other', at: NOW });
      expect(readComments.mock.calls).toEqual([[4715, repos[0].slug]]);
    });

    it('does not read a matching head with fresh TTL when the budget is spent', async () => {
      expect(await probe({ head: HEAD, at: NOW })).not.toHaveBeenCalled();
    });
  });

  it('uses leftover budget to read cached PRs oldest first after all uncached PRs', async () => {
    const settled = new Map([1, 2].map(number => [`${repos[0].slug}#${number}`, { head: HEAD, at: NOW - number }]));
    const readComments = vi.fn(async () => [VERDICT]);
    const result = await runOrphanFixRoundPass(seams([], { settled, readComments,
      listBounced: () => [1, 2, 3].map(number => pr4715([], { number })),
      cursor: { [repos[0].slug]: 2 } }));
    expect(readComments.mock.calls.map(([pr]) => pr)).toEqual([3, 2, 1]);
    expect(result.deferredSettled).toEqual([]);
    expect(settled.get(`${repos[0].slug}#2`).at).toBe(NOW);
  });

  it('defers cached PRs without holds or cursor entries when uncached work spends the budget', async () => {
    const settled = new Map([[`${repos[0].slug}#1`, { head: HEAD, at: NOW - 9 }]]);
    const readComments = vi.fn(async () => [VERDICT]);
    const result = await runOrphanFixRoundPass(seams([], { settled, readComments, deadlineAt: 0, now: () => 0,
      listBounced: () => [1, 2, 3].map(number => pr4715([], { number })) }));
    expect(readComments.mock.calls.map(([pr]) => pr)).toEqual([2]);
    expect(result.deferred).toEqual([{ repo: repos[0].slug, pr: 3 }]);
    expect(result.deferredSettled).toEqual([{ repo: repos[0].slug, pr: 1 }]);
    expect(result.repoCursors).toEqual({ [repos[0].slug]: 3 });
    expect(settled.get(`${repos[0].slug}#1`).at).toBe(NOW - 9);
  });

  it('detects a later same-head orphan on a cached PR and escalates it', async () => {
    const settled = new Map();
    const s = seams([VERDICT], { settled });
    await runOrphanFixRoundPass(s);
    // A dispatch and round end arrive as comments only; no evidence was recorded.
    const result = await runOrphanFixRoundPass({ ...s, readComments: async () => [VERDICT,
      c('2026-10-10T12:00:00Z', `${ORPHAN_GUARD_MARKER} — re-dispatched a fixer`),
      c('2026-10-10T14:00:00Z', `${ORPHAN_GUARD_MARKER} — re-dispatched a fixer`), END] });
    expect(result.rows[0]).toMatchObject({ decision: 'escalate', result: 'escalated' });
    expect(s.escalate).toHaveBeenCalledOnce();
    expect(settled.size).toBe(0);
  });

  it('fails closed with an error row when a cached PR thread is unreadable', async () => {
    const settled = new Map([[`${repos[0].slug}#4715`, { head: HEAD, at: NOW - 1 }]]);
    const result = await runOrphanFixRoundPass(seams([], { settled,
      readComments: async () => { throw new Error('incomplete thread'); } }));
    expect(result.rows).toEqual([expect.objectContaining({ pr: 4715, decision: 'error', result: 'error: incomplete thread' })]);
    expect(settled.size).toBe(0);
  });

  it.each(['grace', 'owned', 'draft'])('never caches a non-stable %s none', async reason => {
    const settled = new Map();
    const s = seams([VERDICT, BEGIN, END], { settled,
      nowMs: Date.parse(END.createdAt) + 1,
      isOwned: async () => reason === 'owned',
      listBounced: () => [pr4715([], { isDraft: reason === 'draft' })] });
    const result = await runOrphanFixRoundPass(s);
    expect(result.rows).toEqual([]);
    expect(result.newlySettled).toEqual([]);
    expect(settled.size).toBe(0);
  });

  it('never caches real orphans and keeps deferred orphans behind the redispatch cap', async () => {
    const settled = new Map();
    const s = seams([VERDICT, BEGIN, END], { settled,
      listBounced: () => [1, 2].map(number => pr4715([], { number })) });
    const result = await runOrphanFixRoundPass(s);
    expect(result.deferred).toEqual([{ repo: repos[0].slug, pr: 2 }]);
    expect(result.newlySettled).toEqual([]);
    expect(settled.size).toBe(0);
    expect(s.redispatch).toHaveBeenCalledOnce();
  });

  it('re-dispatches at most one orphan per pass and defers the rest with a cursor', async () => {
    const s = seams([VERDICT, BEGIN, RESTACK, END], {
      listBounced: () => [3, 1, 2].map(number => pr4715([], { number })),
    });
    const first = await runOrphanFixRoundPass(s);
    const cursor = { repo: repos[0].slug, pr: 2 };
    expect(s.redispatch).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ handled: 2, deferred: [cursor, { repo: repos[0].slug, pr: 3 }], nextCursor: cursor });
    const second = await runOrphanFixRoundPass({ ...s, cursor: first.nextCursor });
    expect(s.redispatch.mock.calls.map(([o]) => o.pr)).toEqual([1, 2]);
    expect(second.nextCursor).toEqual({ repo: repos[0].slug, pr: 3 });
  });

  it('yields mid-loop before reading remaining collected PRs and returns their cursor', async () => {
    const isOwned = vi.fn(async () => true);
    const shouldYield = vi.fn(() => isOwned.mock.calls.length >= 2);
    const s = seams([], { listBounced: () => [4, 3, 2, 1].map(number => pr4715([], { number })),
      isOwned, shouldYield });
    const result = await runOrphanFixRoundPass(s);
    expect(isOwned.mock.calls.map(([, pr]) => pr)).toEqual([1, 2]);
    expect(shouldYield).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ handled: 2,
      deferred: [{ repo: repos[0].slug, pr: 3 }, { repo: repos[0].slug, pr: 4 }],
      nextCursor: { repo: repos[0].slug, pr: 3 } });
  });

  it('checks the deadline before each PR after the first and always makes one PR of progress', async () => {
    let time = 0;
    const s = seams([], { listBounced: () => [3, 1, 2].map(number => pr4715([], { number })),
      now: () => time, deadlineAt: 10,
      isOwned: async () => { time += 10; return true; } });
    const first = await runOrphanFixRoundPass(s);
    expect(first).toMatchObject({ handled: 1, deferred: [{ repo: repos[0].slug, pr: 2 }, { repo: repos[0].slug, pr: 3 }],
      nextCursor: { repo: repos[0].slug, pr: 2 } });
    const second = await runOrphanFixRoundPass({ ...s, cursor: first.nextCursor });
    expect(second).toMatchObject({ handled: 1, deferred: [{ repo: repos[0].slug, pr: 3 }, { repo: repos[0].slug, pr: 1 }],
      nextCursor: { repo: repos[0].slug, pr: 3 } });
    const third = await runOrphanFixRoundPass({ ...s, cursor: second.nextCursor });
    expect(third).toMatchObject({ handled: 1, deferred: [{ repo: repos[0].slug, pr: 1 }, { repo: repos[0].slug, pr: 2 }],
      nextCursor: { repo: repos[0].slug, pr: 1 } });
  });

  it.each([[1, Infinity], [1, 0], [3, Infinity], [3, 0]])('rotates every repo and PR around the deadline cursor without losing coverage (first %s, budget %s)', async (progress, budget) => {
    const repos = [{ key: 'b', slug: 'org/b' }, { key: 'a', slug: 'org/a' }];
    const at = (repo, pr) => ({ repo: `org/${repo}`, pr });
    // Repos run in the order the caller yields them; the daemon heads the next pass with the first deferred repo.
    const all = [at('b', 1), at('b', 2), at('a', 1), at('a', 2)];
    const visited = [];
    const listed = [];
    const s = seams([], { repos: (function* () { yield* repos; })(),
      listBounced: slug => { listed.push(slug); return [2, 1].map(number => ({ number })); },
      now: () => visited.length, deadlineAt: progress,
      isOwned: async (key, pr) => { expect(listed).toHaveLength(2); visited.push(at(key, pr)); return true; } });
    const first = await runOrphanFixRoundPass(s);
    expect(visited).toEqual(all.slice(0, progress));
    expect(first.deferred).toEqual(all.slice(progress));
    visited.length = 0;
    listed.length = 0;
    const headAt = repos.findIndex(repo => repo.slug === first.deferred[0].repo);
    const headed = [...repos.slice(headAt), ...repos.slice(0, headAt)];
    const second = await runOrphanFixRoundPass({ ...s, repos: headed, cursor: first.repoCursors, deadlineAt: budget });
    const rotated = [...all.slice(progress), ...all.slice(0, progress)];
    expect(visited).toEqual(budget === Infinity ? rotated : [rotated[0]]);
    expect(second.deferred).toEqual(budget === Infinity ? [] : rotated.slice(1));
    expect(second.handled).toBe(visited.length);
    expect([...visited, ...second.deferred]).toEqual(rotated);
    expect(second.nextCursor).toEqual(second.deferred[0] ?? null);
  });

  it.each([
    [{ repo: 'org/b', pr: 1 }, ['b2', 'a1', 'a2']],
    [{ repo: 'b', pr: 1 }, ['b2', 'a1', 'a2']],
    [{ repo: 'org/aa', pr: 9 }, ['b2', 'a1', 'a2']],
    [{ repo: 'org/b', pr: 9 }, ['a1', 'a2', 'b2']],
    [{ 'org/b': 9 }, ['a1', 'a2', 'b2']],
    [{ 'org/a': 2, 'org/b': 2 }, ['b2', 'a2', 'a1']],
    [{ a: 2 }, ['b2', 'a2', 'a1']],
    [{ 'org/a': 0, 'org/b': 'x' }, ['b2', 'a1', 'a2']],
    [['org/a', 2], ['b2', 'a1', 'a2']],
  ])('resumes each repo at its own cursor, a missing PR at its successor, or wraps that repo last: %j', async (cursor, expected) => {
    const visited = [];
    await runOrphanFixRoundPass(seams([], {
      repos: [{ key: 'b', slug: 'org/b' }, { key: 'a', slug: 'org/a' }], cursor,
      listBounced: slug => (slug === 'org/a' ? [2, 1] : [2]).map(number => ({ number })),
      isOwned: async (key, pr) => { visited.push(`${key}${pr}`); return true; },
    }));
    expect(visited).toEqual(expected);
  });

  // PR #7330 red-team: passes that each reach one repo must not overwrite the other repo's deferred PR.
  it('keeps an unlisted or unreadable repo\'s cursor while advancing the listed repo\'s own cursor', async () => {
    let time = 0;
    const inspected = [];
    const s = seams([], { now: () => time, deadlineAt: 10,
      listBounced: slug => { if (slug === 'org/c') throw new Error('unreadable'); time += 11; return [2, 1].map(number => ({ number })); },
      isOwned: async (key, pr) => { inspected.push(`${key}${pr}`); return true; } });
    let cursor = null;
    for (const repo of ['a', 'b', 'a', 'b']) {
      const pass = await runOrphanFixRoundPass({ ...s, repos: [{ key: repo, slug: `org/${repo}` }, { key: 'c', slug: 'org/c' }], cursor });
      cursor = pass.repoCursors;
    }
    expect(inspected).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(cursor).toEqual({ 'org/a': 1, 'org/b': 1 });
    const legacy = await runOrphanFixRoundPass({ ...s, repos: [{ key: 'b', slug: 'org/b' }], cursor: { repo: 'org/a', pr: 2 } });
    expect(legacy.repoCursors).toEqual({ 'org/a': 2, 'org/b': 2 });
    const cleared = await runOrphanFixRoundPass({ ...s, deadlineAt: Infinity, repos: [{ key: 'a', slug: 'org/a' }], cursor: { 'org/a': 2, 'org/b': 2 } });
    expect(cleared.repoCursors).toEqual({ 'org/b': 2 });
  });

  it('reports an earlier repo listing failure even when resuming in a later repo', async () => {
    const result = await runOrphanFixRoundPass(seams([], {
      repos: [{ key: 'a', slug: 'org/a' }, { key: 'b', slug: 'org/b' }],
      cursor: { repo: 'org/b', pr: 2 },
      listBounced: slug => { if (slug === 'org/a') throw new Error('unreadable'); return [{ number: 2 }]; },
      isOwned: async () => true,
    }));
    expect(result.rows).toEqual([{ repo: 'org/a', decision: 'error', reason: 'listing failed: unreadable' }]);
    expect(result.handled).toBe(1);
    expect(result.deferred).toEqual([]);
  });

  it('redispatch uses the injected reconcile without running a fresh reconcile pass', async () => {
    const reconcile = vi.fn(() => ({ dispatch: [{ kind: 'fix', prNumber: 4715 }, { kind: 'fix', prNumber: 9 },
      { kind: 'ci-heal', prNumber: 4715 }], refusals: [{ prNumber: 9 }, { prNumber: 4715 }] }));
    const planner = vi.spyOn(reconcilePass, 'runReconcilePass').mockImplementation(() => { throw new Error('fresh reconcile'); });
    const dispatcher = vi.spyOn(fixDispatch, 'runReconcileFixDispatch').mockImplementation(options => {
      expect(options.reconcile({ repo: options.repo })).toEqual({
        dispatch: [{ kind: 'fix', prNumber: 4715 }], refusals: [{ prNumber: 4715 }] });
      return { dispatched: [{ pr: 4715 }] };
    });
    try {
      const result = await runOrphanFixRoundPass(seams([VERDICT, BEGIN, RESTACK, END], { redispatch: defaultRedispatch, reconcile }));
      expect(result.rows[0].result).toBe('re-dispatched');
      expect(reconcile).toHaveBeenCalledOnce();
      expect(planner).not.toHaveBeenCalled();
    } finally { dispatcher.mockRestore(); planner.mockRestore(); }
  });

  it('listing failure still yields an error row', async () => {
    const result = await runOrphanFixRoundPass(seams([], { listBounced: () => { throw new Error('unreadable'); } }));
    expect(result.rows).toEqual([{ repo: repos[0].slug, decision: 'error', reason: 'listing failed: unreadable' }]);
  });

  it('re-arms #4715 through rearm-review at the observed head and leaves one marker comment', async () => {
    const s = seams([VERDICT, EVIDENCE, BEGIN, RESTACK, END]);
    const r = await runOrphanFixRoundPass(s);
    expect(s.rearm).toHaveBeenCalledWith({ slug: 'web-everything/web-everything', pr: 4715, head: HEAD });
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(r.rows).toEqual([expect.objectContaining({ pr: 4715, decision: 'rearm', result: 're-armed' })]);
    expect(s.postComment.mock.calls[0][0].body.startsWith(`${ORPHAN_GUARD_MARKER} — re-armed for review`)).toBe(true);
    expect(formatOrphanFixRoundLines(r)[0]).toMatch(/^orphan-fix-round: web-everything\/web-everything PR #4715 — rearm → re-armed/);
  });

  it('re-dispatches the restack-only orphan; a refused dispatch posts no marker and is retried next tick', async () => {
    const ok = seams([VERDICT, BEGIN, RESTACK, END]);
    await runOrphanFixRoundPass(ok);
    expect(ok.redispatch).toHaveBeenCalledWith({ slug: 'web-everything/web-everything', pr: 4715, reconcile: undefined });
    expect(ok.postComment.mock.calls[0][0].body).toMatch(/re-dispatched a fixer/);
    const refused = seams([VERDICT, BEGIN, RESTACK, END], { redispatch: vi.fn(async () => ({ ok: false, why: 'fix-cap: full' })) });
    const r = await runOrphanFixRoundPass(refused);
    expect(r.rows[0].result).toBe('not-done: fix-cap: full');
    expect(refused.postComment).not.toHaveBeenCalled();
  });

  it('capability-off refuses redispatch while rearm and escalation still run', async () => {
    const resolveProfile = () => ({ capabilities: { fix: false } });
    const denied = seams([VERDICT, BEGIN, RESTACK, END], { resolveProfile });
    const out = await runOrphanFixRoundPass(denied);
    expect(out.rows[0].result).toContain('capability unavailable');
    expect(denied.redispatch).not.toHaveBeenCalled();
    const rearmed = seams([VERDICT, EVIDENCE, BEGIN, RESTACK, END], { resolveProfile });
    await runOrphanFixRoundPass(rearmed);
    expect(rearmed.rearm).toHaveBeenCalledOnce();
    const mark = t => c(t, `${ORPHAN_GUARD_MARKER} — re-dispatched a fixer\n\n…`);
    const escalated = seams([VERDICT, mark('2026-10-10T12:00:00Z'), mark('2026-10-10T14:00:00Z'), BEGIN, END], { resolveProfile });
    await runOrphanFixRoundPass(escalated);
    expect(escalated.escalate).toHaveBeenCalledOnce();
  });

  it('WE_ORPHAN_FIX_GUARD=0 reports without acting; an owned PR is never even read', async () => {
    const off = seams([VERDICT, EVIDENCE, BEGIN, END], { env: { WE_ORPHAN_FIX_GUARD: '0' } });
    const r = await runOrphanFixRoundPass(off);
    expect(r.rows[0].result).toMatch(/report-only/);
    expect(off.rearm).not.toHaveBeenCalled();
    const readComments = vi.fn(async () => []);
    const owned = await runOrphanFixRoundPass(seams([], { isOwned: async () => true, readComments }));
    expect(owned.rows).toEqual([]);
    expect(readComments).not.toHaveBeenCalled();
  });

  it('one PR failing never stops the next', async () => {
    const s = seams([VERDICT, EVIDENCE, BEGIN, END], {
      listBounced: () => [{ number: 1, labels: ['review:changes'] }, { number: 4715, labels: ['review:changes'], headRefOid: HEAD }],
      readComments: async (n) => { if (n === 1) throw new Error('gh down'); return [VERDICT, EVIDENCE, BEGIN, END]; },
    });
    const r = await runOrphanFixRoundPass(s);
    expect(r.rows.map((x) => [x.pr, x.result])).toEqual([[1, 'error: gh down'], [4715, 're-armed']]);
  });

  it('the marker comment names what happened and that it is the same round', () => {
    const body = buildOrphanGuardComment({ decision: 'escalate', reason: 'cap reached', prNumber: 4715 });
    expect(body.split('\n')[0]).toBe(`${ORPHAN_GUARD_MARKER} — escalated to a person`);
    expect(body).toMatch(/same review round/);
  });
});

describe('wiring — the fix daemon runs the guard inside its stuck-fixer reclaim step', () => {
  it('appends the guard rows after the reclaim rows and logs them on their own prefix', async () => {
    const orphanPass = vi.fn(async () => ({ enabled: true, rows: [{ repo: 'web-everything/web-everything', pr: 4715, decision: 'rearm', result: 're-armed', reason: 'r' }] }));
    const r = await runFixerStuckReclaimPass({
      env: {}, nowMs: NOW, readEvents: () => [], readAcked: () => new Set(), listClaims: () => [], prHeadFor: () => null,
      stopSession: () => ({}), orphanPass,
    });
    expect(orphanPass).toHaveBeenCalledWith({ env: {}, nowMs: NOW });
    expect(formatFixerStuckReclaimLines(r)).toEqual(['orphan-fix-round: web-everything/web-everything PR #4715 — rearm → re-armed (r)']);
  });

  it('a throwing guard never breaks the reclaim result', async () => {
    const r = await runFixerStuckReclaimPass({
      env: {}, nowMs: NOW, readEvents: () => [], readAcked: () => new Set(), listClaims: () => [], prHeadFor: () => null,
      stopSession: () => ({}), orphanPass: async () => { throw new Error('boom'); },
    });
    expect(r.rows).toEqual([{ kind: 'orphan-fix-round', decision: 'error', reason: 'boom' }]);
  });
});
