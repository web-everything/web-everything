/**
 * pr-sweep — fixtures are the shapes seen live on 2026-10-20/21: #5485 (paused referrals), #5769/#5530 (red-team
 * round cap), #5784 (ruling dispute), #5787 (draft-withdrawn), #5771 (red-team result missing, drain skip),
 * #5759 (red-team break sent back, then review:human cleared).
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The live bot logins (REST form) are trusted automation; set before the authorship module reads them at import.
vi.hoisted(() => { process.env.WE_AUTOMATION_LOGINS = 'web-everything,plateau-worker[bot],plateau-reviewer[bot],plateau-merger[bot]'; });
import { isReadOnlyOperation } from '../registry.mjs';
import {
  assessPrSweep, finishPrSweep, humanReviewHold, needsDecisionOpen, openFixClaim, referralHoldOpen, renderSweepTable,
  FIX_CLAIM_LIVE_MS, jobsFor,
} from '../pr-sweep-core.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { prSweepOperation, PR_SWEEP_OP } from '../pr-sweep.mjs';
import { createPrSweepReader, parseDrainSkips, parseLiveJobs, resolveStalledAfter, LIST_LIMIT } from '../pr-sweep-io.mjs';
import { redTeamGateMarker } from '../../lib/red-team-gate.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';

const REPO = 'web-everything/web-everything';
const NOW = Date.parse('2026-10-21T11:15:00Z');
const HEAD = '97284ec67feb777e04e811bf623b640d37c3162e';
const L = (...names) => names.map((name) => ({ name }));
const c = (login, createdAt, body) => ({ author: { login }, createdAt, body });
const mkPr = (o) => ({ repo: REPO, number: 5485, title: 't', isDraft: false, headRefOid: HEAD, headCommittedAt: '2026-10-21T01:00:00Z',
  updatedAt: '2026-10-21T11:00:00Z', labels: [], comments: [], statusCheckRollup: [], ...o });
const sweep = (prs, extra = {}) => assessPrSweep({ now: NOW, stalledAfterMinutes: 45, prs, liveJobs: [], drainSkips: [], ...extra });
const row = (report, n) => report.prs.find((r) => r.number === n);

describe('repair process identity at a terminal stand-down', async () => {
  const { buildStandDownComment } = await import('../../conveyor/stand-down.mjs');
  const stoppedAt = Date.parse('2026-10-21T11:00:00Z');
  const pr = mkPr({ labels: L('review:changes'), comments: [c('web-everything', new Date(stoppedAt).toISOString(),
    buildStandDownComment({ reason: 'gate-red', detail: 'verify red' }))] });
  const laterJob = { pr: pr.number, startedAt: stoppedAt + 60_000 };
  const kinds = ['fix-run', 'ci-heal', 'deliver-item-run'];
  it.each(kinds.flatMap((kind) => [undefined, null, '', 'o/other'].map((repo) => [kind, repo])))
  ('an unknown-repository or mismatched %s repair process cannot revive a stand-down: %s', (kind, repo) => {
    expect(row(sweep([pr], { liveJobs: [{ ...laterJob, kind, repo }] }), pr.number)).toMatchObject({
      waitingOn: 'system:fix-stood-down', stalled: true, liveJob: null,
    });
  });
  it.each(kinds)('a later %s repair process in the same repository revives the stand-down', (kind) => {
    expect(row(sweep([pr], { liveJobs: [{ ...laterJob, kind, repo: REPO }] }), pr.number))
      .toMatchObject({ waitingOn: 'fixing', stalled: false, liveJob: kind });
  });
  it.each(['--repo=o/other', '--repo o/other', '--pr=9999', '--pr 9999', '--repo=', '--pr='])
  ('ambiguous process identity cannot revive a stand-down: %s', (extra) => {
    // The real fixer uses the last flag; ps must not credit its first identity to this PR.
    const jobs = parseLiveJobs(`123 00:01 node scripts/conveyor/fix-run.mjs --pr=${pr.number} --repo=${REPO} ${extra}`, NOW);
    expect(jobs).toEqual([]);
    expect(row(sweep([pr], { liveJobs: jobs }), pr.number))
      .toMatchObject({ waitingOn: 'system:fix-stood-down', stalled: true, liveJob: null });
  });
  it.each([`--pr=${pr.number}x --repo=${REPO}`, `--pr=${pr.number} --repo=${REPO}!`])
  ('a malformed process identity cannot revive a stand-down: %s', (flags) => {
    const jobs = parseLiveJobs(`123 00:01 node scripts/conveyor/fix-run.mjs ${flags}`, NOW);
    expect(row(sweep([pr], { liveJobs: jobs }), pr.number))
      .toMatchObject({ waitingOn: 'system:fix-stood-down', stalled: true, liveJob: null });
  });
  it.each([['another PR', { pr: pr.number + 1 }], ['undated', { startedAt: undefined }],
    ['earlier', { startedAt: stoppedAt - 1 }], ['simultaneous', { startedAt: stoppedAt }]])
  ('a matching repository does not revive a stand-down with %s work', (_name, patch) => {
    expect(row(sweep([pr], { liveJobs: [{ ...laterJob, kind: 'fix-run', repo: REPO, ...patch }] }), pr.number))
      .toMatchObject({ waitingOn: 'system:fix-stood-down', stalled: true, liveJob: null });
  });
});

const hold = c('plateau-worker[bot]', '2026-10-21T02:24:21Z',
  'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back\n\n<!-- review-referral-hold: efb6cc81e16fce34ed263b83c6473009fc7e040a7fa67d80810639908a2ea701 -->');

describe('#5485: review paused on referrals (the live miss)', () => {
  const pr = mkPr({ labels: L('review:human', 'review-round:7', 'red-team:pending'),
    comments: [c('plateau-reviewer[bot]', '2026-10-21T02:18:14Z', '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Pending: 2 mandatory referral(s) await a ruling'), hold] });

  it('is waiting on the operator, since the hold, and STALLED with the exact ruling command', () => {
    const r = row(sweep([pr]), 5485);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true, since: '2026-10-21T02:24:21.000Z', approxSince: false });
    expect(r.ageMinutes).toBe(531);
    expect(r.next.command).toContain(`record-referral-ruling --pr=5485 --repo=${REPO}`);
    expect(r.next.command).toContain('--ruling=card --card=<card id>');
  });
  it('a live review job does NOT hide an operator hold', () => {
    expect(row(sweep([pr], { liveJobs: [{ kind: 'review-job', pr: 5485, repo: REPO }] }), 5485)).toMatchObject({ actor: 'operator', stalled: true });
  });
  it('the hold is closed by an operator comment, a later push, or a fix re-arm', () => {
    expect(referralHoldOpen([hold])).toMatchObject({ count: 2 });
    expect(referralHoldOpen([hold, c('chalbert', '2026-10-21T10:53:43Z', '🔁 review — changes requested')])).toBeNull();
    expect(referralHoldOpen([hold], { headCommittedAt: '2026-10-21T03:00:00Z' })).toBeNull();
    expect(referralHoldOpen([hold, c('plateau-worker[bot]', '2026-10-21T04:00:00Z', '🔧 conveyor fix — re-armed for re-review')])).toBeNull();
  });
  it('a TRUSTED automated send-back or accept record after the hold also closes it', () => {
    expect(referralHoldOpen([hold, c('plateau-reviewer[bot]', '2026-10-21T05:00:00Z', '🔁 review — changes requested\n\nfix it')])).toBeNull();
    expect(referralHoldOpen([hold, c('plateau-reviewer[bot]', '2026-10-21T05:00:00Z', '✅ review — accepted\n\nx')])).toBeNull();
  });
  it('a review:accepted LABEL alone does not hide a newer hold (only a dated record after it can)', () => {
    const r = row(sweep([mkPr({ labels: L('ready-to-merge', 'review:accepted'), comments: [hold], updatedAt: '2026-10-21T11:10:00Z' })]), 5485);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
  });
  it('an outsider cannot close a hold, open one, or fake a fix claim', () => {
    const outsider = (at, body) => c('mallory', at, body);
    expect(referralHoldOpen([hold, outsider('2026-10-21T04:00:00Z', '🔧 conveyor fix — re-armed for re-review'), outsider('2026-10-21T04:01:00Z', '🔁 review — changes requested')])).not.toBeNull();
    expect(referralHoldOpen([outsider('2026-10-21T02:24:21Z', 'review paused: 2 referrals need a ruling')])).toBeNull();
    expect(openFixClaim([outsider('2026-10-21T11:00:00Z', '🔒 conveyor fix-begin — fix claim held')], NOW)).toBeNull();
    expect(needsDecisionOpen([outsider('2026-10-21T05:00:00Z', '🔔 conveyor — needs your decision\n\nx')])).toBeNull();
  });
  it('after the operator sends it back it is the fixer\'s, not the operator\'s', () => {
    const sent = { ...pr, labels: L('review:changes', 'review:human', 'status:fixing'),
      comments: [...pr.comments, c('chalbert', '2026-10-21T10:53:43Z', '🔁 review — changes requested')] };
    expect(row(sweep([sent]), 5485)).toMatchObject({ waitingOn: 'fixing', actor: 'fixer', stalled: false });
  });
  it('the second live shape (head already reviewed, waiting on your ruling) is also a hold', () => {
    const second = c('plateau-reviewer[bot]', '2026-10-20T21:59:21Z', 'review paused: head 3d16f726a was already reviewed 1 time(s); it resumes on a new push or an explicit re-arm\n\nWaiting on your ruling (block, card or not-real):\n- `a.md:16` x\n\n<!-- review-referral-hold: abc -->');
    expect(referralHoldOpen([second], { labels: ['review:human'] })).not.toBeNull();
  });
});

describe('referral hold evidence (#5530: stale or unsaved hold)', () => {
  const finding = { summary: 'no named test for identity scoping', file: 'backlog/x.md', line: 33, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const seat = 'judgeCorrectnessAdvisory';
  const reviewer = mandatoryReferralReviewer('review-pr-1');
  const key = referralFindingKey(seat, finding);
  const record = { version: 1, repo: REPO, pr: 5530, head: HEAD, runId: 'review-pr-1', reviewer, authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals: [{ key, seat, original: finding, finding: normalizeFinding(finding) }], rulings: [] };
  const recordComment = c('web-everything', '2026-10-21T08:23:00Z', renderReferralRecord(record));
  const operatorRuling = c('chalbert', '2026-10-21T08:46:37Z', buildOperatorRulingComment({ version: 1, repo: REPO, pr: 5530, head: HEAD,
    rulings: [{ runId: 'review-pr-1', key, result: 'not-real' }], actor: 'chalbert', channel: 'claude-code-chat', reason: 'not real', at: '2026-10-21T11:46:28Z', clearerId: 's1' }));
  const plainHold = c('plateau-reviewer[bot]', '2026-10-21T08:46:29Z', 'review paused: 1 referrals need a ruling; it resumes on a new push, a ruling, or a send-back');
  const failedHold = c('plateau-reviewer[bot]', '2026-10-21T09:50:47Z', 'review paused: 1 referrals need a ruling; it resumes on a new push, a ruling, or a send-back\n\nReferral persistence failed; the next bounded retry is at 2026-10-21T13:50:00Z');
  const pr = (comments, over = {}) => mkPr({ number: 5530, body: '<!-- authored-by-actor: author -->', labels: L('review:human'), comments, ...over });

  it('a truly open finding stays the operator\'s and its location is printed', () => {
    const r = row(sweep([pr([recordComment, plainHold])]), 5530);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
    expect(r.why).toContain('backlog/x.md:33');
    expect(r.evidence).toContain('open: backlog/x.md:33');
    expect(r.next.command).toContain('record-referral-ruling');
  });
  it('0 open findings cannot dismiss an unlinked hold, even when every saved finding has a ruling', () => {
    // The operator ruled BEFORE the later hold comment, so the hold is the newest event and still "open".
    const r = row(sweep([pr([recordComment, operatorRuling, { ...plainHold, createdAt: '2026-10-21T09:00:00Z' }])]), 5530);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
    expect(r.next.command).toContain('record-referral-ruling');
  });
  it('a failed referral save is the system\'s even while a finding is open, and still names it', () => {
    const r = row(sweep([pr([recordComment, failedHold])]), 5530);
    expect(r).toMatchObject({ waitingOn: 'system:ledger-write-miss', actor: 'system' });
    expect(r.why).toContain('backlog/x.md:33');
    expect(r.next.summary).toMatch(/outbox/);
  });
  it('a later trusted ledger-write-miss comment also marks the hold as unsaved', () => {
    const parked = c('plateau-reviewer[bot]', '2026-10-21T10:45:20Z', 'Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: verdict-ledger-io: append failed');
    expect(row(sweep([pr([recordComment, plainHold, parked])]), 5530).waitingOn).toBe('system:ledger-write-miss');
    // an outsider's claim must not excuse the operator
    const forged = c('mallory', '2026-10-21T10:45:20Z', 'ledger-write-miss');
    expect(row(sweep([pr([recordComment, plainHold, forged])]), 5530).actor).toBe('operator');
  });
  it('a trusted comment that merely mentions a ledger miss (another PR, telemetry) does not excuse the operator', () => {
    const other = c('plateau-reviewer[bot]', '2026-10-21T09:05:00Z', 'Diagnostics: ledger-write-miss for o/other#7, not for this referral');
    const r = row(sweep([pr([recordComment, { ...plainHold, createdAt: '2026-10-21T09:00:00Z' }, other])]), 5530);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
  });
  it.each(['referral persistence failed', 'referral-persistence-failed'])(
    'unrelated trusted diagnostic prose mentioning %s cannot dismiss a newer hold', (phrase) => {
      const diagnostic = c('plateau-reviewer[bot]', '2026-10-21T09:05:00Z', `Diagnostics: ${phrase} for o/other#7`);
      const newer = { ...plainHold, createdAt: '2026-10-21T09:00:00Z' };
      expect(row(sweep([pr([recordComment, operatorRuling, newer, diagnostic])]), 5530))
        .toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
    });
  it('an older ruled run does not hide newer UNSAVED referrals on the same head (#5485 shape with history)', () => {
    const two = c('plateau-reviewer[bot]', '2026-10-21T09:00:00Z', 'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back');
    const r = row(sweep([pr([recordComment, operatorRuling, two])]), 5530);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator' });
  });
  it('an older ruled run does not hide an equal count of different unsaved referrals', () => {
    const newer = c('plateau-reviewer[bot]', '2026-10-21T09:00:00Z',
      'review paused: 1 referrals need a ruling\n\nWaiting on your ruling (block, card or not-real):\n- `scripts/new.mjs:7` — a different unsaved finding');
    expect(row(sweep([pr([recordComment, operatorRuling, newer])]), 5530))
      .toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator', stalled: true });
  });
  it('a hold whose count is unknown can not be proven stale', () => {
    const noCount = c('plateau-reviewer[bot]', '2026-10-21T09:00:00Z', 'review paused: it resumes on a new push, a ruling, or a send-back\n\nWaiting on your ruling');
    expect(row(sweep([pr([recordComment, operatorRuling, noCount])]), 5530).actor).toBe('operator');
  });
  it('a malformed operator-ruling record keeps the operator asked even with standing rulings or a failed save', () => {
    const bad = c('chalbert', '2026-10-21T08:50:00Z', '## Operator ruling on mandatory referrals\n<!-- mandatory-referral-operator-ruling-v1: garbage -->');
    const stale = { ...plainHold, createdAt: '2026-10-21T09:00:00Z' };
    expect(row(sweep([pr([recordComment, operatorRuling, bad, stale])]), 5530).actor).toBe('operator');
    expect(row(sweep([pr([recordComment, bad, failedHold])]), 5530).actor).toBe('operator');
  });
  it('a card ruling cannot dismiss an unlinked hold, regardless of card readability', () => {
    const card = c('chalbert', '2026-10-21T08:46:37Z', buildOperatorRulingComment({ version: 1, repo: REPO, pr: 5530, head: HEAD,
      rulings: [{ runId: 'review-pr-1', key, result: 'card', card: 'we:backlog/xcard.md' }], actor: 'chalbert', channel: 'x', reason: 'card it', at: '2026-10-21T08:46:28Z', clearerId: 's1' }));
    const stale = { ...plainHold, createdAt: '2026-10-21T09:00:00Z' };
    const withReader = (cardReadable) => assessPrSweep({ now: NOW, stalledAfterMinutes: 45, prs: [pr([recordComment, card, stale])], holdOptions: { cardReadable } });
    expect(row(withReader(() => true), 5530)).toMatchObject({ waitingOn: 'ruling-needed:referral-hold', actor: 'operator' });
    expect(row(withReader(() => false), 5530).actor).toBe('operator');
  });
  it('a system row is still STALLED once it outlives the threshold with no live job', () => {
    const r = row(sweep([pr([recordComment, failedHold])], { liveJobs: [] }), 5530);
    expect(r.stalled).toBe(true);
    expect(r.stalledReason).toMatch(/waiting on system/);
    expect(renderSweepTable(sweep([pr([recordComment, failedHold])])).join('\n')).toMatch(/run:  \(none\)/);
  });
});

describe('red-team round cap (#5769 / #5530)', () => {
  const HEAD2 = 'f501c83a08006e8ceb0bc535e58dd8eec5096472';
  const advisory = c('web-everything', '2026-10-10T02:00:00Z', `**Verdict:** human review required\n**Advisory outcome:** \`accept\` — x.\nNet basis: \`${'b'.repeat(40)}..${HEAD2}\``);
  const redTeam = c('web-everything', '2026-10-10T02:04:41Z', renderRedTeamComment({ pr: 5769, rev: HEAD2, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [{ summary: 'spaced value hides live reviews', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true }] }));
  const capped = c('web-everything', '2026-10-21T10:30:00Z', redTeamGateMarker(5769, HEAD2, 'round-cap'));
  const pr = mkPr({ number: 5769, headRefOid: HEAD2, labels: L('ready-to-merge', 'review:accepted'), comments: [advisory, redTeam, capped] });

  it('round-cap with live findings waits on the operator and says how to rule', () => {
    const r = row(sweep([pr]), 5769);
    expect(r).toMatchObject({ waitingOn: 'ruling-needed:red-team-round-cap', actor: 'operator', stalled: true });
    expect(r.next.command).toContain('--to=changes');
    expect(r.next.command).toContain('--to=clear-human');
  });
  it('a sent-back break under review:changes with a fix claim open is the fixer\'s and live', () => {
    const sent = c('web-everything', '2026-10-21T10:30:00Z', redTeamGateMarker(5530, HEAD2, 'sent-back'));
    const claim = c('plateau-worker[bot]', '2026-10-21T10:35:09Z', '🔒 conveyor fix-begin — fix claim held\n\n**Who:** `fix-5530`');
    const r = row(sweep([mkPr({ number: 5530, headRefOid: HEAD2, labels: L('review:human', 'review:changes'), comments: [advisory, redTeam, sent, claim] })]), 5530);
    expect(r).toMatchObject({ actor: 'fixer', liveJob: 'fix', stalled: false });
    const released = c('plateau-worker[bot]', '2026-10-21T10:52:24Z', '🔓 conveyor fix-end — fix claim released');
    expect(openFixClaim([claim, released], NOW)).toBeNull();
  });
});

describe('ruling dispute (#5784)', () => {
  const note = c('plateau-worker[bot]', '2026-10-21T05:25:58Z', '🔔 conveyor — needs your decision\n\nneeds your decision: the fixer and the reviewer disagree about a ruling\n\nPR #5784: 3 confirmed finding(s) came back');
  const pr = mkPr({ number: 5784, labels: L('review:human', 'review-round:4'), comments: [note] });
  it('an unanswered dispute note waits on the operator', () => {
    expect(row(sweep([pr]), 5784)).toMatchObject({ waitingOn: 'ruling-needed:dispute', actor: 'operator', stalled: true });
  });
  it('another needs-your-decision note (not a ruling dispute) is an operator item with a different answer', () => {
    const other = { ...pr, comments: [c('plateau-worker[bot]', '2026-10-21T05:25:58Z', '🔔 conveyor — needs your decision\n\nneeds your decision: a session is blocked on a permission prompt')] };
    const r = row(sweep([other]), 5784);
    expect(r).toMatchObject({ waitingOn: 'needs-decision:note', actor: 'operator', stalled: true });
    expect(r.next.command).toContain('gh pr view 5784');
  });
  it('an operator comment after the note answers it', () => {
    const answered = { ...pr, comments: [note, c('chalbert', '2026-10-21T10:38:33Z', '## Operator ruling on mandatory referrals')] };
    expect(row(sweep([answered]), 5784).waitingOn).not.toBe('ruling-needed:dispute');
  });
});

describe.each([
  ['referral hold', referralHoldOpen, hold, 'ruling-needed:referral-hold'],
  ['decision dispute', needsDecisionOpen, c('plateau-worker[bot]', '2026-10-21T05:25:58Z',
    '🔔 conveyor — needs your decision\n\nfixer and reviewer disagree about a ruling'), 'ruling-needed:dispute'],
  ['decision note', needsDecisionOpen, c('plateau-worker[bot]', '2026-10-21T05:25:58Z',
    '🔔 conveyor — needs your decision\n\npermission prompt'), 'needs-decision:note'],
])('%s closure lifecycle', (_name, reader, note, state) => {
  it.each(['push', 'operator reply'])('only a later %s closes the item; earlier and equal timestamps preserve it', (kind) => {
    const at = Date.parse(note.createdAt);
    for (const offset of [-1, 0, 1]) {
      const timestamp = new Date(at + offset).toISOString();
      const comments = kind === 'push' ? [note] : [c('chalbert', timestamp, 'proceed'), note];
      const options = kind === 'push' ? { headCommittedAt: timestamp } : {};
      const open = reader(comments, options);
      if (offset > 0) expect(open).toBeNull();
      else expect(open).toMatchObject({ at });
      const result = sweep([mkPr({ labels: L('review:pending'), comments, ...options })]).prs[0];
      expect(result).toMatchObject(offset > 0
        ? { waitingOn: 'awaiting-review', actor: 'reviewer', stalled: false }
        : { waitingOn: state, actor: 'operator', stalled: true });
    }
  });
});

describe('draft-withdrawn (#5787)', () => {
  it('a draft with the withdrawn hold waits on the operator with a release command', () => {
    const r = row(sweep([mkPr({ number: 5787, isDraft: true, labels: L('review-status:draft-withdrawn') })]), 5787);
    expect(r).toMatchObject({ waitingOn: 'draft-withdrawn', actor: 'operator', stalled: true });
    expect(r.next.command).toContain('gh pr ready 5787');
  });
  it('a plain draft is its author\'s: not stalled until past the threshold with no job', () => {
    const fresh = mkPr({ number: 5788, isDraft: true, updatedAt: '2026-10-21T11:05:00Z' });
    expect(row(sweep([fresh]), 5788)).toMatchObject({ actor: 'fixer', stalled: false });
    expect(row(sweep([{ ...fresh, updatedAt: '2026-10-21T08:00:00Z' }]), 5788)).toMatchObject({ stalled: true });
    expect(row(sweep([{ ...fresh, updatedAt: '2026-10-21T08:00:00Z' }], { liveJobs: [{ kind: 'fix-run', pr: 5788, repo: REPO }] }), 5788).stalled).toBe(false);
  });
});

describe('red-team request held (#5771)', () => {
  const pr = mkPr({ number: 5771, labels: L('ready-to-merge', 'review:accepted'), updatedAt: '2026-10-21T05:27:40Z' });
  const skips = [{ num: 5771, repo: REPO, kind: 'red-team-pending', reason: 'post-accept red team has no recorded result on the live head' }];
  it('no red-team result and no job for hours is STALLED on the red team', () => {
    expect(row(sweep([pr], { drainSkips: skips }), 5771)).toMatchObject({ waitingOn: 'red-team-pending', actor: 'red-team', stalled: true });
  });
  it('a live review-job for the PR clears the stall', () => {
    expect(row(sweep([pr], { drainSkips: skips, liveJobs: [{ kind: 'review-job', pr: 5771, repo: REPO }] }), 5771)).toMatchObject({ stalled: false, liveJob: 'review-job' });
  });
  it.each([
    ['matching repo', REPO, 5771, true],
    ['another repo', 'o/other', 5771, false],
    ['null repo', null, 5771, false],
    ['missing repo', undefined, 5771, false],
    ['another PR', REPO, 5772, false],
  ])('jobsFor requires the same repo and PR: %s', (_name, repo, number, matches) => {
    const job = { kind: 'review-job', pr: number, repo };
    expect(jobsFor(pr, [job], NOW)).toEqual(matches ? [job] : []);
    expect(row(sweep([pr], { drainSkips: skips, liveJobs: [job] }), 5771))
      .toMatchObject({ stalled: !matches, liveJob: matches ? 'review-job' : null });
  });
  it('jobs without --repo do not suppress STALLED for same-numbered PRs in another repo', () => {
    const liveJobs = parseLiveJobs('11915 node /w/scripts/operations/review-job.mjs run --pr=5771');
    const other = { ...pr, repo: 'o/other' };
    expect(sweep([pr, other], { liveJobs }).prs.map((r) => ({ repo: r.repo, stalled: r.stalled, liveJob: r.liveJob })))
      .toEqual([REPO, 'o/other'].map((repo) => ({ repo, stalled: true, liveJob: null })));
  });
});

describe('enqueue comment trust', () => {
  const pr = mkPr({ labels: L('ready-to-merge', 'review:accepted'),
    labelEvents: [{ label: 'review:accepted', at: '2026-10-21T08:00:00Z' }] });
  const marker = `<!-- we-drain-enqueue-clearance head=${HEAD} -->`;
  it.each([false, true])('untrusted enqueue comments cannot suppress STALLED (existing trusted enqueue: %s)', (existing) => {
    const comments = existing ? [c('plateau-merger[bot]', '2026-10-21T09:00:00Z', marker)] : [];
    const before = sweep([{ ...pr, comments }]).prs[0];
    expect(before).toMatchObject({ waitingOn: existing ? 'in-merge-queue' : 'ready-to-merge',
      since: existing ? '2026-10-21T09:00:00.000Z' : '2026-10-21T08:00:00.000Z', stalled: true });
    const after = sweep([{ ...pr, comments: [...comments, c('mallory', '2026-10-21T11:14:00Z', marker)] }]).prs[0];
    expect(after).toEqual(before);
  });
  it.each(['plateau-merger[bot]', 'chalbert'])('a matching enqueue from %s legitimately restarts the clock', (login) => {
    expect(sweep([{ ...pr, comments: [c(login, '2026-10-21T11:14:00Z', marker)] }]).prs[0])
      .toMatchObject({ waitingOn: 'in-merge-queue', since: '2026-10-21T11:14:00.000Z', stalled: false });
  });
  it('a trusted enqueue for an earlier head does not restart the clock', () => {
    expect(sweep([{ ...pr, comments: [c('plateau-merger[bot]', '2026-10-21T11:14:00Z', marker.replace(HEAD, 'f'.repeat(40)))] }]).prs[0])
      .toMatchObject({ waitingOn: 'ready-to-merge', since: '2026-10-21T08:00:00.000Z', stalled: true });
  });
});

describe('sent back, then cleared (#5759)', () => {
  const H = 'e7d770a7274520373df0446b83d3b23fa9612fd4';
  const sent = c('web-everything', '2026-10-20T18:16:44Z', redTeamGateMarker(5759, H, 'sent-back'));
  it('a sent-back break with the review label cleared has no owner: nobody, STALLED, send-back command', () => {
    const r = row(sweep([mkPr({ number: 5759, headRefOid: H, labels: L('ready-to-merge', 'review:accepted'), comments: [sent] })]), 5759);
    expect(r).toMatchObject({ waitingOn: 'red-team-sent-back-cleared', actor: 'nobody', stalled: true });
    expect(r.next.command).toContain('--to=changes');
  });
});

describe('thresholds, drain, ci', () => {
  it('fixer label with no job past the threshold is STALLED; inside it, not', () => {
    const base = mkPr({ number: 1, labels: L('review:changes') });
    expect(row(sweep([{ ...base, updatedAt: '2026-10-21T10:50:00Z' }]), 1).stalled).toBe(false);
    const old = row(sweep([{ ...base, updatedAt: '2026-10-21T10:00:00Z' }]), 1);
    expect(old.stalled).toBe(true);
    expect(old.stalledReason).toMatch(/waiting on fixer for 75 min \(> 45\) with no live job/);
  });
  it('an unrelated later comment does not reset the clock when the label time is known', () => {
    const p = mkPr({ number: 6, labels: L('review:changes'), updatedAt: '2026-10-21T11:10:00Z', headCommittedAt: '2026-10-21T01:00:00Z',
      labelEvents: [{ label: 'review:changes', at: '2026-10-21T02:00:00Z' }, { label: 'gone', at: '2026-10-21T10:00:00Z' }] });
    const r = row(sweep([p]), 6);
    expect(r).toMatchObject({ stalled: true, approxSince: false, since: '2026-10-21T02:00:00.000Z' });
    expect(row(sweep([{ ...p, labelEvents: undefined }]), 6)).toMatchObject({ approxSince: true, stalled: false });
  });
  it('a newer push restarts the fixer clock', () => {
    const p = mkPr({ number: 6, labels: L('review:changes'), headCommittedAt: '2026-10-21T11:00:00Z', labelEvents: [{ label: 'review:changes', at: '2026-10-21T02:00:00Z' }] });
    expect(row(sweep([p]), 6)).toMatchObject({ stalled: false, ageMinutes: 15 });
  });
  it('the threshold is a parameter', () => {
    const p = mkPr({ number: 1, labels: L('review:changes'), updatedAt: '2026-10-21T10:50:00Z' });
    expect(assessPrSweep({ now: NOW, stalledAfterMinutes: 10, prs: [p] }).prs[0].stalled).toBe(true);
  });
  it('a running CI check counts as live; review-gate does not count as CI', () => {
    const p = mkPr({ number: 2, labels: L('status:awaiting-ci'), updatedAt: '2026-10-21T08:00:00Z', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] });
    expect(row(sweep([p]), 2)).toMatchObject({ actor: 'ci', stalled: false });
    const g = mkPr({ number: 3, labels: L('ready-to-merge'), statusCheckRollup: [{ name: 'review-gate', conclusion: 'FAILURE' }] });
    expect(row(sweep([g]), 3).waitingOn).toBe('ready-to-merge');
  });
  it('not-certified drain skip is the operator\'s', () => {
    const p = mkPr({ number: 4, labels: L('ready-to-merge') });
    expect(row(sweep([p], { drainSkips: [{ num: 4, repo: REPO, kind: 'not-certified', reason: 'x' }] }), 4)).toMatchObject({ actor: 'operator', stalled: true });
  });
  it.each(['not-certified', 'red-team-pending'])('a %s drain skip requires the same repo and PR', (kind) => {
    const p = mkPr({ number: 4, labels: L('ready-to-merge') });
    const baseline = sweep([p]).prs[0];
    for (const skip of [
      { num: 4, repo: null }, { num: 4 }, { num: 4, repo: 'o/other' }, { num: 5, repo: REPO },
    ]) {
      expect(sweep([p], { drainSkips: [{ ...skip, kind, reason: 'x' }] }).prs[0]).toEqual(baseline);
    }
    expect(sweep([p], { drainSkips: [{ num: 4, repo: REPO, kind, reason: 'x' }] }).prs[0])
      .toMatchObject({ waitingOn: kind === 'red-team-pending' ? kind : `drain-skip:${kind}` });
  });
  it('an unreadable PR list is an error, never an empty sweep', () => {
    expect(() => assessPrSweep({ now: NOW })).toThrow(/unreadable/);
  });
  it('orders STALLED first, oldest first', () => {
    const r = sweep([
      mkPr({ number: 6, labels: L('ready-to-merge'), updatedAt: '2026-10-21T11:12:00Z' }),
      mkPr({ number: 9, labels: L('review:human', 'advisory:accepted'), updatedAt: '2026-10-21T11:10:00Z' }),
      mkPr({ number: 8, labels: L('review:human', 'advisory:accepted'), updatedAt: '2026-10-21T10:00:00Z' }),
      mkPr({ number: 7, labels: L('review:pending'), updatedAt: '2026-10-21T08:00:00Z' }),
    ], { liveJobs: [{ kind: 'review-job', pr: 7, repo: REPO }] });
    expect(r.prs.map((x) => [x.number, x.stalled])).toEqual([[8, true], [9, true], [7, false], [6, false]]);
    expect(r.stalledCount).toBe(2);
  });
});

describe('rendering and declaration', () => {
  const report = sweep([mkPr({ labels: L('review:human'), comments: [hold] })]);
  it('table lists STALLED rows with a run line; --json prints the report alone', () => {
    const text = renderSweepTable(report).join('\n');
    expect(text).toMatch(/1 STALLED/);
    expect(text).toMatch(/run:  node scripts\/operations\/run\.mjs record-referral-ruling/);
    expect(JSON.parse(finishPrSweep({ run: { verdict: report }, code: 0, lines: ['{json}'], json: true }).lines[0])).toMatchObject({ stalledCount: 1, prs: [{ number: 5485, actor: 'operator' }] });
    expect(finishPrSweep({ run: { verdict: report }, code: 0, lines: ['{json}'], json: false }).lines.join('\n')).toMatch(/WAITING ON/);
  });
  it('declares a read-only two-step operation', () => {
    const d = prSweepOperation({ readSweep: () => ({}), assess: () => ({}) });
    expect(d.name).toBe(PR_SWEEP_OP);
    expect(d.steps.map((x) => x.name)).toEqual(['read', 'assess']);
    expect(isReadOnlyOperation(d)).toBe(true);
  });
});

describe('fix claim comment expiration', () => {
  const started = NOW - FIX_CLAIM_LIVE_MS;
  const claim = c('plateau-worker[bot]', new Date(started).toISOString(), '🔒 conveyor fix-begin — fix claim held');
  it('openFixClaim expires an unreleased comment after FIX_CLAIM_LIVE_MS', () => {
    expect(openFixClaim([claim], NOW - 1)).toEqual({ at: started });
    expect(openFixClaim([claim], NOW)).toEqual({ at: started });
    expect(openFixClaim([claim], NOW + 1)).toBeNull();
  });
  it('expired unreleased fix claims no longer suppress STALLED or hold back a review notification', () => {
    const pr = mkPr({ labels: L('review:pending'), updatedAt: new Date(started).toISOString(), comments: [claim] });
    for (const offset of [-1, 0, 1]) {
      const now = NOW + offset;
      // With a threshold longer than the claim lease, the lease alone decides liveness.
      const r = assessPrSweep({ now, prs: [pr], stalledAfterMinutes: 24 * 60 }).prs[0];
      expect(r.liveJob).toBe(offset > 0 ? null : 'fix');
      expect(humanReviewHold(pr, now)).toEqual(offset > 0 ? [] : ['a fix claim is open']);
      // Past the stall threshold a claim COMMENT with no process is not a fixer at work (live #5768): STALLED.
      const d = assessPrSweep({ now, prs: [pr] }).prs[0];
      expect([d.stalled, d.liveJob]).toEqual([true, null]);
    }
  });
});

describe('io helpers', () => {
  it('parses every documented pr-sweep flag through its declaration and passes the threshold to the reader', () => {
    const readSweep = vi.fn(() => ({}));
    const declaration = prSweepOperation({ readSweep, assess: () => ({}) });
    const parsed = parseOperationArgv(declaration, [`--repo=${REPO}`, '--pr=5485', '--stalled-after=10', '--json']);
    expect(parsed.errors).toEqual([]);
    expect(parsed.control.json).toBe(true);
    declaration.steps[0].step.fn({ input: parsed.input });
    expect(readSweep).toHaveBeenCalledWith({ repo: REPO, pr: 5485, stalledAfter: 10 });
  });
  it.each(['MERGED', 'CLOSED'])('an explicit --pr skips a %s PR and reports its identifier', (state) => {
    const run = vi.fn(() => JSON.stringify({ number: 301, state }));
    const out = createPrSweepReader({ run, ps: () => '', readText: () => '', settings: () => ({}) })({ repo: REPO, pr: 301 });
    expect(out.prs).toEqual([]);
    expect(out.unreadable).toEqual([`${REPO}#301: PR is ${state}, not OPEN`]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].at(-1).split(',')).toContain('state');
  });
  it('an unqualified --pr uses only the primary configured repo', () => {
    const run = vi.fn(() => JSON.stringify({ number: 301, state: 'MERGED' }));
    const out = createPrSweepReader({ run, ps: () => '', readText: () => '',
      settings: () => ({ prSweep: { repos: [REPO, 'o/other'] } }) })({ pr: 301 });
    expect(out.repos).toEqual([REPO]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(['comments', 'events', 'commits'])('failed PR detail reads report unreadable and preserve other PRs: %s', (endpoint) => {
    const run = (_file, args) => {
      if (args[1] === 'list') return JSON.stringify([{ number: 1, state: 'OPEN' }, { number: 2, state: 'OPEN' }]);
      const fails = endpoint === 'commits' ? args[1] === 'view' && args[2] === '1'
        : args[0] === 'api' && args[3].includes(`/issues/1/${endpoint}?`);
      if (fails) throw new Error(`${endpoint} failed\nextra`);
      return args[0] === 'api' ? '[[]]' : '{"commits":[]}';
    };
    const out = createPrSweepReader({ run, ps: () => '', readText: () => '', settings: () => ({}) })({ repo: REPO });
    expect(out.unreadable).toEqual([`${REPO}#1: ${endpoint} failed`]);
    expect(out.prs.map((p) => p.number)).toEqual([2]);
  });
  it('parses the latest drain skip row', () => {
    const log = 'x\nmerge-ai-prs · skip-reasons: [{"num":1,"repo":"a/b","kind":"k","reason":"old"}]\nmerge-ai-prs · skip-reasons: [{"num":5771,"repo":"web-everything/web-everything","kind":"red-team-pending","reason":"r"}]\nnoise';
    expect(parseDrainSkips(log)).toEqual({ rows: [{ num: 5771, repo: REPO, kind: 'red-team-pending', reason: 'r' }], error: null });
    expect(parseDrainSkips('nothing')).toEqual({ rows: [], error: null });
    expect(parseDrainSkips('merge-ai-prs · skip-reasons: {bad}').error).toMatch(/not valid JSON/);
    expect(parseDrainSkips('merge-ai-prs · skip-reasons: {"a":1}').error).toMatch(/not a list/);
  });
  it.each(['review-job', 'review-extra-seats', 'fix-run', 'ci-heal', 'deliver-item-run', 'red-team-gate-apply'])
  ('recognizes live %s processes with PR and repo', (kind) => {
    for (const separator of ['=', ' ']) {
      const ps = ` 11915 06:55 /bin/node /w/scripts/operations/${kind}.mjs run --pr${separator}5786 --repo${separator}${REPO} --prefer-lane=13\n 2 1 vim x`;
      expect(parseLiveJobs(ps)).toEqual([{ kind, pr: 5786, repo: REPO, source: 'ps' }]);
    }
  });
  it('threshold cascade: flag > env > setting > 45', () => {
    expect(resolveStalledAfter({ flag: 10, env: { WE_PR_SWEEP_STALLED_AFTER_MINUTES: '20' }, settings: { prSweep: { stalledAfterMinutes: 30 } } })).toBe(10);
    expect(resolveStalledAfter({ env: { WE_PR_SWEEP_STALLED_AFTER_MINUTES: '20' }, settings: { prSweep: { stalledAfterMinutes: 30 } } })).toBe(20);
    expect(resolveStalledAfter({ env: {}, settings: { prSweep: { stalledAfterMinutes: 30 } } })).toBe(30);
    expect(resolveStalledAfter({ env: {}, settings: {} })).toBe(45);
  });
  it('a missing or corrupt drain log is reported, not read as "no skips"', () => {
    const mk = (readText) => createPrSweepReader({ run: () => '[]', ps: () => '', readText, now: () => NOW, settings: () => ({ prSweep: { repos: [REPO] } }) })({});
    expect(mk(() => { throw new Error('x does not exist'); }).unreadable).toEqual(['drain log: x does not exist']);
    expect(mk(() => 'merge-ai-prs · skip-reasons: {bad}').unreadable[0]).toMatch(/^drain log: .*not valid JSON/);
  });
  it('an explicit --pr is fetched by number (not through the capped list), and a capped list is reported', () => {
    const calls = [];
    const run = (_f, args) => {
      calls.push(args.slice(0, 3).join(' '));
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('commits')) return JSON.stringify({ commits: [] });
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 301, state: 'OPEN', title: 't', headRefOid: HEAD, labels: [] });
      if (args[0] === 'api') return '[[]]';
      return JSON.stringify(Array.from({ length: LIST_LIMIT }, (_, i) => ({ number: i + 1, state: 'OPEN', headRefOid: HEAD, labels: [] })));
    };
    const rd = (input) => createPrSweepReader({ run, ps: () => '', readText: () => '', now: () => NOW, settings: () => ({}) })(input);
    expect(rd({ repo: REPO, pr: 301 }).prs.map((p) => p.number)).toEqual([301]);
    expect(calls.some((x) => x.startsWith('pr list'))).toBe(false);
    expect(rd({ repo: REPO }).unreadable.join()).toMatch(/hit the 1000 cap/);
  });
  it('the default reader goes through plain gh and never the throttled wrapper (which writes lock + log files)', () => {
    const src = readFileSync(resolvePath(process.cwd(), 'scripts/operations/pr-sweep-io.mjs'), 'utf8');
    expect(src).not.toMatch(/gh-throttle|Throttled/);
  });
  it('the reader reports an unreadable repo instead of dropping it', () => {
    const read = createPrSweepReader({ run: () => { throw new Error('boom\nmore'); }, ps: () => '', readText: () => '', now: () => NOW,
      settings: () => ({ prSweep: { repos: [REPO] } }) });
    const out = read({});
    expect(out.prs).toEqual([]);
    expect(out.unreadable).toEqual([`${REPO}: boom`]);
  });
  it('the reader joins the list, paginated comments, and the head commit date', () => {
    const run = (_f, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 9, state: 'OPEN', title: 't', headRefOid: HEAD, labels: [], updatedAt: 'u' }]);
      if (args[0] === 'api' && /events/.test(args[3])) return JSON.stringify([[{ event: 'labeled', label: { name: 'review:human' }, created_at: '2026-10-21T00:30:00Z' }, { event: 'closed' }]]);
      if (args[0] === 'api') return JSON.stringify([[{ id: 1, user: { login: 'chalbert' }, body: 'hi', created_at: '2026-10-21T01:00:00Z' }]]);
      return JSON.stringify({ commits: [{ oid: HEAD, committedDate: '2026-10-21T00:00:00Z' }] });
    };
    const out = createPrSweepReader({ run, ps: () => '', readText: () => '', now: () => NOW, settings: () => ({}) })({ repo: REPO });
    expect(out.prs[0]).toMatchObject({ number: 9, repo: REPO, headCommittedAt: '2026-10-21T00:00:00Z', comments: [{ author: { login: 'chalbert' }, body: 'hi' }], labelEvents: [{ label: 'review:human', at: '2026-10-21T00:30:00Z' }] });
  });
});

describe('humanReviewHold: the gate behind "your review" (#5768)', () => {
  const H = '18088fcad0000000000000000000000000000000';
  const sentBack = c('web-everything', '2026-10-21T14:29:00Z', redTeamGateMarker(5768, H, 'sent-back'));
  const base = { number: 5768, headRefOid: H, labels: L('review:human', 'advisory:accepted', 'red-team:clear'), comments: [] };
  const at = Date.parse('2026-10-21T14:35:00Z');

  it('a clean PR is the operator\'s to review', () => {
    expect(humanReviewHold(base, at)).toEqual([]);
  });
  it('the #5768 shape (red-team:blocked, review:changes, sent-back) is held for every reason', () => {
    const r = humanReviewHold({ ...base, labels: L('review:human', 'advisory:accepted', 'review:changes', 'red-team:blocked', 'status:sent-back-red-team'), comments: [sentBack] }, at);
    expect(r).toEqual(expect.arrayContaining(['the red team blocked the live head', 'it was sent back (review:changes)', 'an unanswered red-team send-back on the live head']));
  });
  it('a send-back record alone holds it, even before any label caught up (the stale-snapshot case)', () => {
    expect(humanReviewHold({ ...base, comments: [sentBack] }, at)).toEqual(['an unanswered red-team send-back on the live head']);
  });
  it('red-team:pending holds it; red-team:clear does not', () => {
    expect(humanReviewHold({ ...base, labels: L('review:human', 'advisory:accepted', 'red-team:pending') }, at)).toEqual(['the red team has not cleared the live head']);
  });
  it('a LATER operator comment answers the send-back; an earlier one or an outsider does not', () => {
    expect(humanReviewHold({ ...base, comments: [sentBack, c('chalbert', '2026-10-21T14:31:00Z', 'ok, proceed')] }, at)).toEqual([]);
    expect(humanReviewHold({ ...base, comments: [c('chalbert', '2026-10-21T14:20:00Z', 'earlier'), sentBack] }, at)).not.toEqual([]);
    expect(humanReviewHold({ ...base, comments: [sentBack, c('mallory', '2026-10-21T14:31:00Z', 'ok')] }, at)).not.toEqual([]);
  });
  it('a send-back for another head or from an outsider does not hold it', () => {
    expect(humanReviewHold({ ...base, comments: [c('web-everything', '2026-10-21T14:29:00Z', redTeamGateMarker(5768, 'f'.repeat(40), 'sent-back'))] }, at)).toEqual([]);
    expect(humanReviewHold({ ...base, comments: [c('mallory', '2026-10-21T14:29:00Z', redTeamGateMarker(5768, H, 'sent-back'))] }, at)).toEqual([]);
  });
  it('an open fix claim holds it; a released one does not', () => {
    const claim = c('plateau-worker[bot]', '2026-10-21T14:30:00Z', '🔒 conveyor fix-begin — fix claim held');
    expect(humanReviewHold({ ...base, comments: [claim] }, at)).toEqual(['a fix claim is open']);
    expect(humanReviewHold({ ...base, comments: [claim, c('plateau-worker[bot]', '2026-10-21T14:32:00Z', '🔓 conveyor fix-end — fix claim released')] }, at)).toEqual([]);
  });
});
