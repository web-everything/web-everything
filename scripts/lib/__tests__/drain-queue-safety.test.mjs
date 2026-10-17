// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readDrainQueueSafety, redTeamEnqueueHold, dequeueSentBack, sendBackReason } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { redTeamGateMarker, redTeamMarker } from '../red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';

const head = '5300b9ec377a' + '0'.repeat(28);
const prior = 'a'.repeat(40);
const bot = { author: { login: 'web-everything' } };
const clean = (rev = head, login = 'web-everything', findings = []) => ({ author: { login }, body: renderRedTeamComment({ pr: 5283, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const hold = (over = {}) => redTeamEnqueueHold({ scheduled: over.loopPayload !== null && over.loopPayload?.verdict?.verdict !== 'needs-human', loopPayload: { verdict: { verdict: 'accept' } }, labels: ['review:accepted'], comments: [], pr: 5283, head, env: {}, ...over });
const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
const gate = (sha, outcome) => ({ ...bot, body: redTeamGateMarker(5283, sha, outcome) });
// The comment shapes review-set-label renders: `clear-human` (heading first, markers last), `restamp`, plain accept.
const accept = (sha, cleared = false) => ({ ...bot, body: cleared
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
    ['untrusted clearance', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), { ...accept(head, true), author: { login: 'attacker' } }]],
    ['a later plain accept supersedes it', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), accept(head)]],
    ['a newer result after the ruling', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true), clean(head, 'web-everything', broken)]],
    ['a restamp repeating an earlier head\'s clearance', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), restamp(head)]],
    ['clearance markers inside a trusted red-team body', [clean(head, 'web-everything', broken), gate(head, 'round-cap'),
      clean(prior, 'web-everything', [{ ...broken[0], summary: `${buildReviewedShaMarker(head)} ${buildClearedHumanMarker('x')}` }])]],
    ['a round-cap line after a quoted carried marker', [clean(head, 'web-everything', broken), gate(head, 'sent-back'), { ...bot, body: [
      'quoting:', buildVerdictCarriedMarker({ fromSha: prior, toSha: 'd'.repeat(40), patchId: 'c'.repeat(40) }), redTeamGateMarker(5283, head, 'round-cap')].join('\n') }, accept(head, true)]],
    ['a carried marker for this head preceded by a non-gate line', [clean(head, 'web-everything', broken), gate(head, 'sent-back'), { ...bot, body: [
      'quoting:', redTeamGateMarker(5283, head, 'round-cap'), buildVerdictCarriedMarker({ fromSha: prior, toSha: head, patchId: 'c'.repeat(40) })].join('\n') }, accept(head, true)]],
  ])('keeps holding: %s', (_name, comments) => expect(hold({ comments })).toMatch(/requiring send-back/));
  it('a ruling on the prior head survives a proven carry (restamped clearance, carried round-cap and result)', () => {
    const ruledOnPrior = [clean(prior, 'web-everything', broken), gate(prior, 'round-cap'), accept(prior, true)];
    expect(hold({ comments: [...ruledOnPrior, restamp(head), carry({ findings: broken, gates: ['round-cap'] })] })).toBeNull();
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
});

describe('drain policy cascade', () => {
  it('defaults both safeguards on and logs their sources', () => {
    const lines = [];
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log: l => lines.push(l) });
    expect(r.value).toMatchObject({ waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true });
    expect(r.sources).toMatchObject({ waitForRedTeamBeforeEnqueue: 'standard', dequeueOnSendBack: 'standard' });
    expect(lines.join('')).toContain('dequeueOnSendBack=true (standard)');
    expect(r.value).toMatchObject({ redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45, enqueueWhenRedTeamNeverScheduled: true });
    expect(lines.join('')).toContain('enqueueWhenRedTeamNeverScheduled=true (standard)');
    expect(lines.join('')).toContain('redTeamPendingBackoffSec=300 (standard)');
    expect(lines.join('')).toContain('redTeamPendingMaxMin=45 (standard)');
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
  it('recognizes ready removal and leaves ready accepted PRs alone', () => {
    expect(sendBackReason([])).toContain('ready-to-merge');
    expect(sendBackReason(['review:accepted', 'ready-to-merge'])).toBeNull();
  });
});
