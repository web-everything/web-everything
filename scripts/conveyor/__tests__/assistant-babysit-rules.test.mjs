/** Classification fixtures: report-only, no actions, no GitHub writes. */
import { describe, it, expect } from 'vitest';
import { classifyPr, nextActor, DEFAULTS, OWED_KINDS } from '../assistant-babysit-rules.mjs';

const nowMs = 120 * 60000;
const base = { repo: 'org/repo', number: 1, labels: [], isDraft: false, mergeable: 'MERGEABLE', ciFailing: false,
  headSha: 'abc', headChangedAtMs: 0, labelChangedAtMs: 0, claims: [], nowMs };
const claim = { kind: 'fix', claimedAtMs: 0, heartbeatAtMs: nowMs, ttlMinutes: 10, headShaAtClaim: 'abc' };
const classify = (patch, opts) => classifyPr({ ...base, ...patch }, opts);

describe('owed kinds', () => {
  it.each([
    ['review-changes', { labels: ['review:changes'] }],
    ['red-team-blocked', { labels: ['red-team:blocked'] }],
    ['ci-red', { labels: ['status:ci-red'], ciFailing: true }],
    ['conflicting', { mergeable: 'CONFLICTING' }],
    ['conflicting', { labels: ['merge-status:conflicting'] }],
    ['conflicting', { labels: ['status:conflict'] }],
    ['sent-back', { labels: ['status:sent-back-red-team'] }],
    ['sent-back', { labels: ['status:sent-back-review'] }],
  ])('%s is owed for %j', (kind, patch) => expect(classify(patch).owed).toEqual([kind]));

  it('exports stable kinds and thresholds', () => {
    expect(OWED_KINDS).toEqual(['review-changes', 'red-team-blocked', 'ci-red', 'conflicting', 'sent-back']);
    expect(DEFAULTS).toEqual({ noWorkerMin: 20, staleClaimMin: 60, readyStalledMin: 45 });
  });
  it('accumulates kinds and drafts owe nothing', () => {
    const patch = { labels: ['review:changes', 'red-team:blocked', 'status:ci-red', 'status:sent-back-review'], ciFailing: true, mergeable: 'CONFLICTING' };
    expect(classify(patch).owed).toEqual(OWED_KINDS);
    expect(classify({ ...patch, isDraft: true }).owed).toEqual([]);
  });
  it('pending red CI label does not owe work', () => expect(classify({ labels: ['status:ci-red'] }).owed).toEqual([]));
});

describe('report rules and boundaries', () => {
  it.each([
    ['bad-claim', { badClaims: [{ path: 'bad/lock.json', problem: 'Invalid ttlMinutes' }] }, true],
    ['bad-claim', { badClaims: [] }, false],
    ['no-worker', { labels: ['review:changes'], headChangedAtMs: nowMs - 20 * 60000 }, true],
    ['no-worker', { labels: ['review:changes'], labelChangedAtMs: nowMs - 20 * 60000 + 1 }, false],
    ['no-worker', { labels: ['review:changes'], headChangedAtMs: undefined, labelChangedAtMs: undefined }, false],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: nowMs - 10 * 60000 }] }, false],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: nowMs - 10 * 60000 - 1 }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: nowMs + 120000 }] }, false],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: nowMs + 120001 }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: nowMs + 24 * 60 * 60000 }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, kind: 'fixing' }] }, false],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, kind: 'ci-heal' }] }, false],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, ttlMinutes: -1 }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, ttlMinutes: 0 }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, ttlMinutes: NaN }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, ttlMinutes: Infinity }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, ttlMinutes: '10' }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, heartbeatAtMs: NaN }] }, true],
    ['no-worker', { labels: ['review:changes'], claims: [{ ...claim, claimedAtMs: NaN }] }, true],
    ['no-worker', { labels: ['review:changes', 'status:fixing'] }, true],
    ['no-worker', { labels: ['review:changes', 'review:human'] }, false],
    ['no-worker', { labels: ['review:changes', 'status:stood-down'] }, false],
    ['no-worker', { labels: ['review:changes', 'review-status:stood-down'] }, false],
    ['stale-claim', { claims: [{ ...claim, claimedAtMs: nowMs - 60 * 60000 }] }, true],
    ['stale-claim', { claims: [{ ...claim, claimedAtMs: nowMs - 60 * 60000 + 1 }] }, false],
    ['stale-claim', { claims: [claim], headChangedAtMs: 1, headSha: 'def' }, false],
    ['stale-claim', { claims: [claim], headChangedAtMs: 1 }, true],
    ['stale-claim', { claims: [claim], headSha: 'def' }, true],
    ['stale-claim', { claims: [{ kind: 'fix' }], headSha: undefined, headChangedAtMs: undefined }, false],
    ['ready-stalled', { labels: ['ready-to-merge'], headChangedAtMs: nowMs - 45 * 60000 }, true],
    ['ready-stalled', { labels: ['ready-to-merge'], headChangedAtMs: nowMs - 45 * 60000 + 1 }, false],
    ['ready-stalled', { labels: ['ready-to-merge'], headChangedAtMs: undefined, labelChangedAtMs: undefined }, false],
    ['ready-stalled', { labels: ['ready-to-merge', 'review:pending'] }, false],
    ['ready-stalled', { labels: ['ready-to-merge', 'status:ci-red'] }, true],
  ])('%s with %j => %s', (rule, patch, present) => {
    expect(classify(patch).reports.some((report) => report.rule === rule)).toBe(present);
  });

  it.each([
    ['ready-to-merge', 'review:changes', {}],
    ['ready-to-merge', 'red-team:blocked', {}],
    ['ready-to-merge', 'status:ci-red', { ciFailing: true }],
    ['ready-to-merge', 'mergeable:CONFLICTING', { mergeable: 'CONFLICTING' }],
    ['ready-to-merge', 'review:pending', {}],
    ['review:accepted', 'review:changes', {}],
    ['review:human', 'live fix claim', { claims: [claim] }],
    ['status:fixing', 'no live claim', {}],
    ['review-status:fixing', 'no live claim', {}],
    ['status:stood-down', 'owed work', { labels: ['status:stood-down', 'review:changes'] }],
    ['review-status:stood-down', 'owed work', { labels: ['review-status:stood-down', 'review:changes'] }],
    ['status:stood-down', 'ready-to-merge', {}],
    ['review-status:stood-down', 'ready-to-merge', {}],
  ])('contradiction %s + %s', (a, b, patch) => {
    const reports = classify({ labels: [a, b], ...patch }).reports;
    expect(reports.filter((report) => report.rule === 'contradiction').map((report) => report.reason)).toContain(`${a} + ${b}`);
    expect(reports.some((report) => report.rule === 'ready-stalled')).toBe(false);
  });

  it('does not infer live fixing from a label or incomplete heartbeat', () => {
    const recentClaim = { ...claim, claimedAtMs: nowMs - 60000 };
    expect(classify({ labels: ['status:fixing'], claims: [{ ...recentClaim, heartbeatAtMs: undefined }] }).reports[0].rule).toBe('contradiction');
    expect(classify({ labels: ['status:fixing'], claims: [recentClaim] }).reports).toEqual([]);
    expect(classify({ labels: ['status:fixing'], headChangedAtMs: nowMs - 20 * 60000 + 1 }).reports).toEqual([]);
  });
  it('emits one bad-claim report without suppressing no-worker for an owed PR', () => {
    const badClaims = [{ path: 'one/lock.json', problem: 'Invalid ttlMinutes' }, { path: 'two/lock.json', problem: 'Invalid heartbeatAt' }];
    const { reports } = classify({ labels: ['review:changes'], badClaims });
    expect(reports.map((report) => report.rule)).toEqual(['bad-claim', 'no-worker']);
    expect(reports[0]).toMatchObject({ repo: 'org/repo', pr: 1, reason: 'Invalid ttlMinutes', minutes: null, detail: { badClaims } });
  });
  it('emits each rule once, retaining distinct contradiction pairs', () => {
    const { reports } = classify({ labels: ['ready-to-merge', 'review:accepted', 'review:changes', 'review:changes', 'red-team:blocked'], claims: [claim, claim].map((c) => ({ ...c, heartbeatAtMs: 0 })) });
    expect(reports.filter((r) => r.rule === 'no-worker')).toHaveLength(1);
    expect(reports.filter((r) => r.rule === 'stale-claim')).toHaveLength(1);
    expect(reports.filter((r) => r.rule === 'contradiction')).toHaveLength(3);
    expect(reports[0]).toMatchObject({ repo: 'org/repo', pr: 1, minutes: 120, owner: 'fix daemon', detail: { owed: ['review-changes', 'red-team-blocked'] } });
  });
  it('accepts threshold overrides without mutating the snapshot', () => {
    const snapshot = structuredClone({ ...base, labels: ['review:changes'] });
    const before = structuredClone(snapshot);
    expect(classifyPr(snapshot, { noWorkerMin: 121 }).reports).toEqual([]);
    expect(snapshot).toEqual(before);
  });
});

describe('next actor', () => {
  it.each([
    [{ labels: ['review:human', 'review:changes'] }, 'operator'],
    [{ labels: ['status:stood-down', 'ready-to-merge'] }, 'operator'],
    [{ labels: ['review:changes', 'status:ci-red'], ciFailing: true }, 'fix daemon'],
    [{ labels: ['status:ci-red'], ciFailing: true }, 'ci-heal'],
    [{ labels: ['review:pending'] }, 'review daemon'],
    [{ labels: ['ready-to-merge'] }, 'drain'],
    [{}, 'operator'],
  ])('derives %j => %s', (patch, owner) => expect(nextActor({ ...base, ...patch })).toBe(owner));
  it('prefers supplied why owner', () => expect(nextActor(base, { owner: 'queue operator', waitingFor: 'capacity' })).toBe('queue operator'));
});
