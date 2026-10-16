// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readDrainQueueSafety, redTeamEnqueueHold, dequeueSentBack, sendBackReason } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

const head = '5300b9ec377a' + '0'.repeat(28);
const clean = (rev = head, login = 'web-everything', findings = []) => ({ author: { login }, body: renderRedTeamComment({ pr: 5283, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const hold = (over = {}) => redTeamEnqueueHold({ labels: ['review:accepted'], comments: [], pr: 5283, head, env: {}, ...over });

describe('durable head-bound red-team admission', () => {
  it('waits without a result; ignores stale, foreign-PR and untrusted markers', () => {
    expect(hold()).toMatch(/no recorded result/);
    expect(hold({ comments: [clean('a'.repeat(40)), clean(head, 'attacker'), { ...clean(), body: clean().body.replace('pr=5283', 'pr=5284') }] })).toMatch(/no recorded result/);
    expect(hold({ comments: [clean()] })).toBeNull();
  });
  it('holds advisory accepts and confirmed breaks even before the gate has sent back', () => {
    expect(hold({ labels: ['advisory:accepted'] })).toMatch(/no recorded result/);
    const findings = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
    expect(hold({ comments: [clean(head, 'web-everything', findings)] })).toMatch(/requiring send-back/);
    expect(hold({ comments: [clean(head, 'web-everything', findings)], confirmedBreaks: { broken: 'advisory', degraded: 'card', unconfirmed: 'advisory' } })).toBeNull();
  });
  it.each(['WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])('does not owe a pass with %s off', key => {
    expect(hold({ env: { [key]: '0' } })).toBeNull();
  });
  it('does not owe a pass without a panel accept', () => expect(hold({ labels: ['ready-to-merge'] })).toBeNull());
});

describe('drain policy cascade', () => {
  it('defaults both safeguards on and logs their sources', () => {
    const lines = [];
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log: l => lines.push(l) });
    expect(r.value).toMatchObject({ waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true });
    expect(r.sources).toMatchObject({ waitForRedTeamBeforeEnqueue: 'standard', dequeueOnSendBack: 'standard' });
    expect(lines.join('')).toContain('dequeueOnSendBack=true (standard)');
    expect(r.value).toMatchObject({ redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 });
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
