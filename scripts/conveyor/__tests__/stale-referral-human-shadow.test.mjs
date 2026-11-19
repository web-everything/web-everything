// @vitest-environment node
/** R375: red-first contract for the standalone, read-only human-hold shadow. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOperatorRulingComment, NEGOTIATION_ROUND_CAP, readReferralRecords, renderReferralRecord,
} from '../../lib/jury-core.mjs';
import { liveReferralState } from '../../lib/referral-live-context.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import {
  createLiveShadowReaders, decideStaleReferralHumanHold, emitShadowEvent, readHumanHoldPrs, resolveStaleReferralHumanShadow,
} from '../stale-referral-human-shadow.mjs';

// Spy on the shared writer while retaining real JSONL persistence for dedup tests.
vi.mock('../../lib/daemon-events.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, appendDaemonEvent: vi.fn(actual.appendDaemonEvent) };
});

const repo = 'web-everything/web-everything';
const movedHead = 'a'.repeat(40);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/pr-5775-stale-referral-hold.json', import.meta.url), 'utf8'));
const trustedComments = fixture.comments.map(c => ({ ...c,
  author: { login: c.author?.login === 'plateau-reviewer' ? 'web-everything' : c.author?.login },
}));
const originalRecord = readReferralRecords(trustedComments, { head: fixture.headRefOid }).records
  .find(r => r.repo === repo && r.pr === fixture.number && r.head === fixture.headRefOid);
const finding = originalRecord.referrals[0];
const causes = [
  'round-cap', 'block-ruling', 'requested-changes', 'red-team-blocked', 'draft', 'merge-conflict',
  'required-checks', 'escalation', 'needs-you', 'operator-ruling-needed', 'no-verdict',
  'same-head-hold', 'security-finding', 'mandatory-referral-finding', 'advisory-push',
];
const enabled = { value: { enabled: true }, sources: { enabled: 'standard' } };
const disabled = { value: { enabled: false }, sources: { enabled: 'tool' } };

function referralComment(record) {
  return { author: { login: 'web-everything' }, authorAssociation: 'MEMBER',
    body: renderReferralRecord(record), createdAt: '2026-10-21T12:00:00Z' };
}

function ruling(record, result = 'not-real') {
  return { author: { login: 'chalbert' }, authorAssociation: 'OWNER', createdAt: '2026-10-21T12:01:00Z',
    body: buildOperatorRulingComment({ version: 1, repo, pr: fixture.number, head: record.head,
      rulings: [{ runId: record.runId, key: finding.key, result }], actor: 'chalbert',
      channel: 'test', reason: 'Finding-specific operator ruling', at: '2026-10-21T12:01:00Z', clearerId: '' }) };
}

/**
 * Proposed injectable-reader contract: readHoldEvidence returns the persisted hold's provenance and
 * independent review evidence, readRequiredChecks returns required names, and readReferralState uses
 * the acceptance gate's reader. No reader consults the host, GitHub, or an operator's settings.
 * A referral-only pause is distinct from a separately established same-head human ceremony.
 */
function clean() {
  const record = { ...structuredClone(originalRecord), rulings: [], carried: [], superseded: [],
    referrals: [structuredClone(finding)] };
  const pr = { repo, number: fixture.number, headRefOid: record.head, labels: [{ name: 'review:human' }],
    body: fixture.body, createdAt: fixture.createdAt, isDraft: false, mergeable: 'MERGEABLE', reviews: [],
    comments: [referralComment(record), ruling(record)],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const evidence = { cause: 'referral', head: record.head, runId: record.runId, key: finding.key,
    round: 1, noVerdict: false, sameHeadHold: false, findings: [], escalations: [],
    needsYou: false, operatorRulingNeeded: false };
  const options = { repo, env: {}, settings: enabled, cardReadable: () => false,
    readHoldEvidence: vi.fn(() => structuredClone(evidence)),
    readRequiredChecks: vi.fn(() => ['test']),
    readReferralState: vi.fn((p, context) => liveReferralState(p, context)) };
  return { pr, record, evidence, options };
}

function checked(decision, cause, status) {
  expect(decision.wouldClear).toBe(false);
  expect(decision.checked).toEqual(expect.arrayContaining([
    expect.objectContaining({ cause, status, detail: expect.any(String) }),
  ]));
}

describe('paginated human-hold discovery', () => {
  const node = (number, names = []) => ({ number, labels: {
    nodes: names.map(name => ({ name })), pageInfo: { hasNextPage: false },
  } });
  const page = (nodes, hasNextPage = false, endCursor = null) => ({ data: { repository: {
    pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } },
  } } });

  it.each([
    ['all holds', undefined], ['explicit --pr target', [101]],
  ])('reads %s beyond 100 unrelated open PRs', (_name, selected) => {
    const pr = { number: 101, headRefOid: movedHead, labels: [{ name: 'review:human' }] };
    const gh = vi.fn()
      .mockReturnValueOnce(page(Array.from({ length: 100 }, (_, i) => node(i + 1)), true, 'page-1'))
      .mockReturnValueOnce(page([node(101, ['review:human'])]))
      .mockReturnValueOnce(pr);
    expect([...readHumanHoldPrs({ repo, gh, selected })]).toEqual([pr]);
    expect(gh).toHaveBeenCalledTimes(3);
    expect(gh.mock.calls[0][0]).toEqual(expect.arrayContaining(['api', 'graphql', `owner=${repo.split('/')[0]}`]));
    expect(gh.mock.calls[1][0]).toContain('cursor=page-1');
    expect(gh.mock.calls[2][0]).toEqual(['pr', 'view', '101', '--repo', repo, '--json',
      'number,headRefOid,baseRefName,labels,isDraft,mergeable,statusCheckRollup,body,createdAt,reviews']);
  });

  it.each([
    ['missing connection', {}],
    ['GraphQL partial error', { ...page([]), errors: [{ message: 'unreadable' }] }],
    ['missing labels', page([{ number: 1 }])],
    ['truncated labels', page([{ number: 1, labels: { nodes: [], pageInfo: { hasNextPage: true } } }])],
    ['missing continuation cursor', page([], true)],
  ])('fails closed on %s with operator guidance', (_name, response) => {
    const gh = vi.fn(() => response);
    expect(() => [...readHumanHoldPrs({ repo, gh })]).toThrow(/operator/);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('refuses a repeated cursor rather than looping over incomplete discovery', () => {
    const gh = vi.fn(() => page([], true, 'same-cursor'));
    expect(() => [...readHumanHoldPrs({ repo, gh })]).toThrow(/operator must inspect remaining human holds/);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it('propagates the shared 128-call budget refusal on oversized discovery', () => {
    let calls = 0;
    const gh = () => {
      if (calls === 128) throw new Error('GitHub read budget exhausted; operator inspection required');
      calls++;
      return page(Array.from({ length: 100 }, (_, i) => node((calls - 1) * 100 + i + 1)), true, `page-${calls}`);
    };
    expect(() => [...readHumanHoldPrs({ repo, gh })]).toThrow(/budget exhausted; operator inspection required/);
    expect(calls).toBe(128);
  });
});

describe('CLI production evidence adapter', () => {
  function setup() {
    const { pr, record, options } = clean();
    pr.baseRefName = 'main';
    pr.labels.push({ name: 'review-round:1' });
    const run = { id: record.runId, repo, pr: pr.number, head: record.head,
      parked: true, attempted: true, persistenceFailed: false, pending: [finding.key],
      startedAt: Date.parse('2026-10-21T11:59:00Z'), completedAt: Date.parse('2026-10-21T12:00:00Z') };
    const io = { repo, env: {}, now: Date.parse('2026-10-21T12:02:00Z'),
      gh: vi.fn(() => { throw new Error('unexpected network'); }),
      readRuns: vi.fn(() => [run]), readAttention: vi.fn(() => []),
      readRequired: vi.fn(() => ['test']),
      readRun: vi.fn(() => ({ id: run.id, findings: {
        read: { repo, pr: pr.number, netBasis: { rev: record.head } },
        referralVerdict: { findings: [], deferredAdvisory: [] },
      } })),
    };
    return { pr, record, options, io };
  }

  it('durable referral-only pause with a ruling yields wouldClear using production hold rules', async () => {
    const { pr, record, options, io } = setup();
    const readers = createLiveShadowReaders(io);
    expect(await readers.readHoldEvidence(pr, { cardReadable: () => false })).toMatchObject({
      cause: 'referral', head: record.head, runId: record.runId, key: finding.key,
      round: 1, findings: [], escalations: [], needsYou: false, operatorRulingNeeded: false,
      sameHeadHold: false, noVerdict: false,
    });
    expect((await decideStaleReferralHumanHold(pr, { ...options, ...readers })).wouldClear).toBe(true);
    expect(io.readRequired).toHaveBeenCalledWith(expect.objectContaining({ repo, branch: 'main' }));
    expect(io.readRuns).toHaveBeenCalledTimes(1);
    expect(io.gh).not.toHaveBeenCalled();
  });

  it('missing needs-you source is omitted and keeps independent hold causes unknown', async () => {
    const { pr, options, io } = setup();
    io.readAttention.mockImplementation(() => { throw new Error('feed unreadable'); });
    const readers = createLiveShadowReaders(io);
    const evidence = await readers.readHoldEvidence(pr);
    for (const field of ['needsYou', 'operatorRulingNeeded', 'escalations']) expect(evidence).not.toHaveProperty(field);
    const decision = await decideStaleReferralHumanHold(pr, { ...options, ...readers });
    for (const cause of ['needs-you', 'operator-ruling-needed', 'escalation']) checked(decision, cause, 'unknown');
  });

  it('missing durable findings never becomes an empty clean finding list', async () => {
    const { pr, options, io } = setup();
    io.readRun.mockReturnValue(null);
    const readers = createLiveShadowReaders(io);
    expect(await readers.readHoldEvidence(pr)).not.toHaveProperty('findings');
    checked(await decideStaleReferralHumanHold(pr, { ...options, ...readers }), 'security-finding', 'unknown');
  });

  it.each(['security', 'security/authz', 'SeCuRiTy/AuThZ', 'SECURITY'])(
    'security category %s produces a present security finding', async category => {
      const { pr, options, io } = setup();
      const run = io.readRun();
      run.findings.referralVerdict.findings = [{ category, summary: 'Authorization bypass',
        verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }];
      io.readRun.mockReturnValue(run);
      checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }),
        'security-finding', 'present');
    });

  it.each(['broken', 'unrecoverable'])(
    'canonical mandatory finding with %s impact produces a present mandatory referral', async impactIfUnfixed => {
      const { pr, options, io } = setup();
      const run = io.readRun();
      run.findings.referralVerdict.findings = [{
        summary: 'Confirmed live-head defect', verdict: 'CONFIRMED', impactIfUnfixed,
      }];
      io.readRun.mockReturnValue(run);
      checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }),
        'mandatory-referral-finding', 'present');
    });

  it.each(['findings', 'deferredAdvisory'])(
    '%s containing an array entry leaves findings unknown and wouldClear false', async field => {
      const { pr, options, io } = setup();
      const run = io.readRun();
      run.findings.referralVerdict[field] = [[]];
      io.readRun.mockReturnValue(run);
      const readers = createLiveShadowReaders(io);
      expect(await readers.readHoldEvidence(pr)).not.toHaveProperty('findings');
      const decision = await decideStaleReferralHumanHold(pr, { ...options, ...readers });
      for (const cause of ['security-finding', 'mandatory-referral-finding', 'advisory-push']) {
        checked(decision, cause, 'unknown');
      }
    });

  it.each(['findings', 'deferredAdvisory'])(
    '%s with incomplete finding content leaves production findings unknown', async field => {
      const { pr, options, io } = setup();
      const run = io.readRun();
      run.findings.referralVerdict[field] = [{ verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }];
      io.readRun.mockReturnValue(run);
      const readers = createLiveShadowReaders(io);
      expect(await readers.readHoldEvidence(pr)).not.toHaveProperty('findings');
      const decision = await decideStaleReferralHumanHold(pr, { ...options, ...readers });
      for (const cause of ['security-finding', 'mandatory-referral-finding', 'advisory-push']) {
        checked(decision, cause, 'unknown');
      }
    });

  it.each([null, 'unreadable', 1, new Date(0)])(
    'non-plain-object finding %j leaves findings unknown and wouldClear false', async entry => {
      const { pr, options, io } = setup();
      const run = io.readRun();
      run.findings.referralVerdict.findings = [entry];
      io.readRun.mockReturnValue(run);
      checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }),
        'security-finding', 'unknown');
    });

  it('a referral comment without durable run provenance stays unknown', async () => {
    const { pr, options, io } = setup();
    io.readRuns.mockReturnValue([]);
    const readers = createLiveShadowReaders(io);
    expect(await readers.readHoldEvidence(pr)).not.toHaveProperty('runId');
    checked(await decideStaleReferralHumanHold(pr, { ...options, ...readers }), 'referral-provenance', 'unknown');
  });

  it('missing round label stays unknown instead of assuming round zero', async () => {
    const { pr, options, io } = setup();
    pr.labels = pr.labels.filter(l => !l.name.startsWith('review-round:'));
    checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }), 'round-cap', 'unknown');
  });

  it('required-check read failure stays unknown', async () => {
    const { pr, options, io } = setup();
    io.readRequired.mockImplementation(() => { throw new Error('policy unavailable'); });
    checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }), 'required-checks', 'unknown');
  });

  it('live-head attention entries preserve each independent hold cause', async () => {
    const { pr, options, io } = setup();
    io.readAttention.mockReturnValue(['needs-you', 'ruling-needed', 'escalated'].map(kind => ({
      repo, pr: pr.number, head: pr.headRefOid, kind,
    })));
    const decision = await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) });
    for (const cause of ['needs-you', 'operator-ruling-needed', 'escalation']) checked(decision, cause, 'present');
  });

  it('round cap from the real label remains a hold', async () => {
    const { pr, options, io } = setup();
    pr.labels.push({ name: `review-round:${NEGOTIATION_ROUND_CAP}` });
    checked(await decideStaleReferralHumanHold(pr, { ...options, ...createLiveShadowReaders(io) }), 'round-cap', 'present');
  });
});

describe('decideStaleReferralHumanHold: stale referral must be the ONLY cause', () => {
  it('referral ruled on live head + all else clean -> wouldClear', async () => {
    const { pr, record, options } = clean();
    const before = structuredClone(pr);
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision).toMatchObject({ wouldClear: true, head: pr.headRefOid,
      referral: expect.any(String), why: expect.stringMatching(/ruled|resolved/) });
    expect(decision.referral).toContain(record.runId);
    expect(decision.referral).toContain(finding.key);
    expect(decision.checked.map(c => c.cause)).toEqual(expect.arrayContaining(causes));
    expect(decision.checked.every(c => c.status === 'absent' && typeof c.detail === 'string' && c.detail.length > 0)).toBe(true);
    expect(pr).toEqual(before);
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('head moved past referral -> wouldClear', async () => {
    const { pr, record, options } = clean();
    pr.headRefOid = movedHead;
    // The old referral is still unruled; it no longer applies to the live head.
    pr.comments = [referralComment(record)];
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision).toMatchObject({ wouldClear: true, head: movedHead, why: expect.stringMatching(/head-moved-past/) });
    expect(decision.referral).toContain(record.runId);
  });

  it('pending referral -> no', async () => {
    const { pr, record, options } = clean();
    pr.comments = [referralComment(record)];
    expect((await decideStaleReferralHumanHold(pr, options)).wouldClear).toBe(false);
  });

  it('head moved past referral but live head has another pending referral -> no', async () => {
    const { pr, record, options } = clean();
    pr.headRefOid = movedHead;
    const liveRecord = structuredClone(record);
    liveRecord.head = movedHead;
    // Re-check metadata is pinned to its record head; preserve that invariant when moving the fixture.
    for (const f of liveRecord.referrals) if (f.recheck) f.recheck.head = movedHead;
    for (const recheck of liveRecord.rechecks ?? []) recheck.head = movedHead;
    pr.comments = [referralComment(record), referralComment(liveRecord)];
    expect((await decideStaleReferralHumanHold(pr, options)).wouldClear).toBe(false);
  });

  it('block ruling -> no', async () => {
    const { pr, record, options } = clean();
    pr.comments = [referralComment(record), ruling(record, 'block')];
    checked(await decideStaleReferralHumanHold(pr, options), 'block-ruling', 'present');
  });

  it('round cap reached -> no', async () => {
    const { pr, evidence, options } = clean();
    evidence.round = NEGOTIATION_ROUND_CAP;
    pr.labels.push({ name: `review-round:${NEGOTIATION_ROUND_CAP}` });
    checked(await decideStaleReferralHumanHold(pr, options), 'round-cap', 'present');
  });

  it.each([
    ['failing check', 'COMPLETED', 'FAILURE'],
    ['pending required check', 'IN_PROGRESS', null],
  ])('%s -> no', async (_name, status, conclusion) => {
    const { pr, options } = clean();
    pr.statusCheckRollup[0] = { name: 'test', status, conclusion };
    checked(await decideStaleReferralHumanHold(pr, options), 'required-checks', 'present');
  });

  it.each([
    ['review:changes', 'requested-changes'], ['red-team:blocked', 'red-team-blocked'],
    ['needs-you', 'needs-you'], ['operator-ruling-needed', 'operator-ruling-needed'],
    ['advisory:changes', 'advisory-push'],
  ])('%s independently retains the human hold', async (label, cause) => {
    const { pr, options } = clean();
    pr.labels.push({ name: label });
    checked(await decideStaleReferralHumanHold(pr, options), cause, 'present');
  });

  it('requested changes in reviews independently retains the human hold', async () => {
    const { pr, options } = clean();
    pr.reviews = [{ state: 'CHANGES_REQUESTED', author: { login: 'chalbert' }, commit: { oid: pr.headRefOid } }];
    checked(await decideStaleReferralHumanHold(pr, options), 'requested-changes', 'present');
  });

  it.each([
    ['draft', p => { p.isDraft = true; }],
    ['merge-conflict', p => { p.mergeable = 'CONFLICTING'; }],
  ])('%s independently retains the human hold', async (cause, change) => {
    const { pr, options } = clean();
    change(pr);
    checked(await decideStaleReferralHumanHold(pr, options), cause, 'present');
  });

  it.each([
    ['no-verdict', { noVerdict: true }], ['same-head-hold', { sameHeadHold: true }],
    ['escalation', { escalations: [{ head: fixture.headRefOid, reason: 'operator decision required' }] }],
    ['security-finding', { findings: [{ head: fixture.headRefOid, lens: 'security', verdict: 'CONFIRMED', impactIfUnfixed: 'broken', summary: 'Open security issue' }] }],
    ['mandatory-referral-finding', { findings: [{ head: fixture.headRefOid, verdict: 'CONFIRMED', impactIfUnfixed: 'broken', summary: 'Unruled live finding' }] }],
    ['advisory-push', { findings: [{ head: fixture.headRefOid, advisory: true, requiresPush: true, verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded', summary: 'Repair requires a push' }] }],
  ])('%s in persisted evidence independently retains the human hold', async (cause, patch) => {
    const { pr, evidence, options } = clean();
    Object.assign(evidence, patch);
    checked(await decideStaleReferralHumanHold(pr, options), cause, 'present');
  });

  it('confirmed broken finding without summary leaves findings unknown and wouldClear false', async () => {
    const { pr, evidence, options } = clean();
    evidence.findings = [{ head: pr.headRefOid, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }];
    const decision = await decideStaleReferralHumanHold(pr, options);
    for (const cause of ['security-finding', 'mandatory-referral-finding', 'advisory-push']) {
      checked(decision, cause, 'unknown');
    }
  });

  it.each([
    ['non-string summary', { summary: 42 }],
    ['blank summary', { summary: '   ' }],
    ['missing verdict', { verdict: undefined }],
    ['non-string verdict', { verdict: ['CONFIRMED'] }],
    ['missing impactIfUnfixed', { impactIfUnfixed: undefined }],
    ['non-string impactIfUnfixed', { impactIfUnfixed: ['broken'] }],
    ['non-string category', { category: ['security'] }],
    ['non-string lens', { lens: ['security'] }],
    ['non-boolean security', { security: 'true' }],
  ])('%s leaves findings unknown and wouldClear false', async (_name, patch) => {
    const { pr, evidence, options } = clean();
    evidence.findings = [{ head: pr.headRefOid, summary: 'Live-head defect',
      verdict: 'CONFIRMED', impactIfUnfixed: 'broken', ...patch }];
    const decision = await decideStaleReferralHumanHold(pr, options);
    for (const cause of ['security-finding', 'mandatory-referral-finding', 'advisory-push']) {
      checked(decision, cause, 'unknown');
    }
  });

  it('no referral provenance -> no, even with clean live referrals', async () => {
    const { pr, evidence, options } = clean();
    evidence.cause = 'unknown';
    expect((await decideStaleReferralHumanHold(pr, options)).wouldClear).toBe(false);
  });

  it('unreadable referral state -> no (unknown), never throws', async () => {
    const { pr, options } = clean();
    options.readReferralState = () => { throw new Error('referral store unavailable'); };
    checked(await decideStaleReferralHumanHold(pr, options), 'referral-state', 'unknown');
  });

  it('malformed referral record -> no (unknown)', async () => {
    const { pr, options } = clean();
    pr.comments.push({ author: { login: 'web-everything' }, body: '<!-- mandatory-referrals-v1: %not-json -->' });
    checked(await decideStaleReferralHumanHold(pr, options), 'referral-state', 'unknown');
  });

  it.each(['readHoldEvidence', 'readRequiredChecks'])('%s read error -> no (unknown), never throws', async reader => {
    const { pr, options } = clean();
    options[reader] = () => { throw new Error('unavailable'); };
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision.wouldClear).toBe(false);
    expect(decision.checked.some(c => c.status === 'unknown')).toBe(true);
  });

  it.each(['headRefOid', 'labels', 'reviews', 'comments', 'statusCheckRollup', 'mergeable', 'isDraft'])(
    'missing %s -> no (unknown)', async field => {
      const { pr, options } = clean();
      delete pr[field];
      const decision = await decideStaleReferralHumanHold(pr, options);
      expect(decision.wouldClear).toBe(false);
      expect(decision.checked.some(c => c.status === 'unknown')).toBe(true);
    },
  );

  it('unknown label -> no (unknown)', async () => {
    const { pr, options } = clean();
    pr.labels.push({ name: 'review:unrecognized-human-hold' });
    checked(await decideStaleReferralHumanHold(pr, options), 'labels', 'unknown');
  });

  it('missing required check cannot be inferred green from other checks', async () => {
    const { pr, options } = clean();
    options.readRequiredChecks = () => ['test', 'security'];
    checked(await decideStaleReferralHumanHold(pr, options), 'required-checks', 'unknown');
  });

  it('PR without review:human is ineligible', async () => {
    const { pr, options } = clean();
    pr.labels = [];
    expect((await decideStaleReferralHumanHold(pr, options)).wouldClear).toBe(false);
  });
});

describe('shadow setting', () => {
  it('defaults on for shadow with no tool or environment setting', () => {
    expect(resolveStaleReferralHumanShadow({ env: {}, tool: {} }).value.enabled).toBe(true);
  });

  it('explicit tool enabled=false disables readers and events independently of the enabled default', async () => {
    const { pr, options } = clean();
    const settings = resolveStaleReferralHumanShadow({ env: {},
      tool: { staleReferralHumanShadow: { enabled: false } } });
    expect(settings).toMatchObject({ value: { enabled: false }, sources: { enabled: 'tool' } });
    const decision = await decideStaleReferralHumanHold(pr, { ...options, settings });
    expect(decision.wouldClear).toBe(false);
    expect(options.readHoldEvidence).not.toHaveBeenCalled();
    expect(options.readRequiredChecks).not.toHaveBeenCalled();
    expect(options.readReferralState).not.toHaveBeenCalled();
    await emitShadowEvent({ wouldClear: true }, pr, { repo, settings, env: {} });
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it.each([['0', true, false], ['1', false, true], ['invalid', false, false], ['true', true, true]])(
    'environment %s over tool enabled=%s resolves to %s', (value, toolEnabled, expected) => {
      const result = resolveStaleReferralHumanShadow({ env: { WE_STALE_REFERRAL_HUMAN_SHADOW: value },
        tool: { staleReferralHumanShadow: { enabled: toolEnabled } } });
      expect(result.value.enabled).toBe(expected);
      expect(result.sources.enabled).toMatch(value === '0' || value === '1' ? /env/ : /tool/);
    },
  );

  it('disabled setting -> no evaluation, no event, even for a previously positive decision', async () => {
    const { pr, options } = clean();
    const positive = await decideStaleReferralHumanHold(pr, options);
    expect(positive.wouldClear).toBe(true);
    vi.clearAllMocks();
    const decision = await decideStaleReferralHumanHold(pr, { ...options, settings: disabled });
    expect(decision.wouldClear).toBe(false);
    expect(options.readReferralState).not.toHaveBeenCalled();
    expect(options.readHoldEvidence).not.toHaveBeenCalled();
    expect(options.readRequiredChecks).not.toHaveBeenCalled();
    await emitShadowEvent(positive, pr, { repo, settings: disabled, env: {} });
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });
});

let scratch;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('emitShadowEvent', () => {
  beforeEach(() => {
    // The launcher supplies a task-local TMPDIR; never fall back to a host-global scratch directory.
    scratch = mkdtempSync(join(process.env.TMPDIR, 'stale-referral-shadow-'));
    vi.stubEnv('WE_DAEMON_EVENTS', join(scratch, 'events.jsonl'));
    vi.stubEnv('WE_STALE_REFERRAL_HUMAN_SHADOW', '1');
    writeFileSync(process.env.WE_DAEMON_EVENTS, '');
  });
  const rows = () => readFileSync(process.env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const emit = (d, p) => emitShadowEvent(d, p, { repo, settings: enabled, env: process.env });

  it('only-wouldClear emits one event with the full checked evidence', async () => {
    const { pr, options } = clean();
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision.wouldClear).toBe(true);
    await emit({ ...decision, wouldClear: false }, pr);
    expect(rows()).toEqual([]);
    expect(appendDaemonEvent).not.toHaveBeenCalled();
    await emit(decision, pr);
    expect(appendDaemonEvent).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([expect.objectContaining({ kind: 'would-clear-human-hold', repo,
      pr: pr.number, daemon: 'review', detail: { head: decision.head, referral: decision.referral,
        why: decision.why, checked: decision.checked } })]);
  });

  it('dedup: persisted pr+head+referral in the last 200 lines prevents re-append', async () => {
    const { pr, options } = clean();
    const decision = await decideStaleReferralHumanHold(pr, options);
    const duplicate = { kind: 'would-clear-human-hold', repo, pr: pr.number, daemon: 'review', detail: decision };
    // Seed disk independently: this must work across separate daemon invocations, not just in-memory calls.
    const noise = Array.from({ length: 199 }, () => JSON.stringify({ kind: 'other-event' }));
    writeFileSync(process.env.WE_DAEMON_EVENTS, [JSON.stringify(duplicate), ...noise].join('\n') + '\n');
    await emit(decision, pr);
    expect(appendDaemonEvent).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(200);
  });

  it('dedup window excludes matches older than the last 200 lines', async () => {
    const { pr, options } = clean();
    const decision = await decideStaleReferralHumanHold(pr, options);
    const duplicate = { kind: 'would-clear-human-hold', repo, pr: pr.number, daemon: 'review', detail: decision };
    const noise = Array.from({ length: 200 }, () => JSON.stringify({ kind: 'other-event' }));
    writeFileSync(process.env.WE_DAEMON_EVENTS, [JSON.stringify(duplicate), ...noise].join('\n') + '\n');
    await emit(decision, pr);
    expect(appendDaemonEvent).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(202);
  });

  it.each(['head', 'referral', 'pr', 'repo'])('dedup includes %s in its identity', async field => {
    const { pr, options } = clean();
    const decision = await decideStaleReferralHumanHold(pr, options);
    await emit(decision, pr);
    const next = { ...decision };
    const nextPr = { ...pr };
    if (field === 'head') next.head = movedHead;
    if (field === 'referral') next.referral += ':another-finding';
    if (field === 'pr') nextPr.number += 1;
    const nextRepo = field === 'repo' ? 'another/repo' : repo;
    await emitShadowEvent(next, { ...nextPr, repo: nextRepo }, { repo: nextRepo, settings: enabled, env: process.env });
    expect(rows()).toHaveLength(2);
  });
});

// Each row starts with the same positive referral-only fixture and changes only one
// independent cause. Keep this list aligned with the complete checked-cause contract.
const independentCauses = [
  { cause: 'round-cap', present: ({ evidence }) => { evidence.round = NEGOTIATION_ROUND_CAP; }, field: 'round' },
  { cause: 'block-ruling', present: ({ pr, record }) => { pr.comments = [referralComment(record), ruling(record, 'block')]; }, reader: 'readReferralState' },
  { cause: 'requested-changes', present: ({ pr }) => { pr.reviews = [{ state: 'CHANGES_REQUESTED' }]; }, prField: 'reviews' },
  { cause: 'red-team-blocked', present: ({ pr }) => { pr.labels.push({ name: 'red-team:blocked' }); }, prField: 'labels' },
  { cause: 'draft', present: ({ pr }) => { pr.isDraft = true; }, prField: 'isDraft' },
  { cause: 'merge-conflict', present: ({ pr }) => { pr.mergeable = 'CONFLICTING'; }, prField: 'mergeable' },
  { cause: 'required-checks', present: ({ pr }) => { pr.statusCheckRollup[0].conclusion = 'FAILURE'; }, reader: 'readRequiredChecks' },
  { cause: 'escalation', present: ({ pr, evidence }) => { evidence.escalations = [{ head: pr.headRefOid }]; }, field: 'escalations' },
  { cause: 'needs-you', present: ({ evidence }) => { evidence.needsYou = true; }, field: 'needsYou' },
  { cause: 'operator-ruling-needed', present: ({ evidence }) => { evidence.operatorRulingNeeded = true; }, field: 'operatorRulingNeeded' },
  { cause: 'no-verdict', present: ({ evidence }) => { evidence.noVerdict = true; }, field: 'noVerdict' },
  { cause: 'same-head-hold', present: ({ evidence }) => { evidence.sameHeadHold = true; }, field: 'sameHeadHold' },
  { cause: 'security-finding', present: ({ pr, evidence }) => { evidence.findings = [{ head: pr.headRefOid, lens: 'security', summary: 'Open security issue', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }]; }, field: 'findings' },
  { cause: 'mandatory-referral-finding', present: ({ pr, evidence }) => { evidence.findings = [{ head: pr.headRefOid, verdict: 'CONFIRMED', impactIfUnfixed: 'broken', summary: 'Unruled live finding' }]; }, field: 'findings' },
  { cause: 'advisory-push', present: ({ pr, evidence }) => { evidence.findings = [{ head: pr.headRefOid, advisory: true, requiresPush: true, summary: 'Repair requires a push', verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded' }]; }, field: 'findings' },
];

describe('referral-only safety predicate: every independent cause fails closed', () => {
  it('positive referral-only fixture checks every cause absent and proposes clearance', async () => {
    const { pr, options } = clean();
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision.wouldClear).toBe(true);
    for (const cause of causes) expect(decision.checked).toContainEqual(
      expect.objectContaining({ cause, status: 'absent', detail: expect.any(String) }));
    expect(independentCauses.map(row => row.cause).sort()).toEqual([...causes].sort());
  });

  it.each(independentCauses)('$cause present independently prevents referral-only clearance', async row => {
    const context = clean();
    row.present(context);
    checked(await decideStaleReferralHumanHold(context.pr, context.options), row.cause, 'present');
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it.each(independentCauses)('$cause unreadable independently prevents referral-only clearance', async row => {
    const { pr, evidence, options } = clean();
    if (row.reader) options[row.reader] = () => { throw new Error(`${row.cause} evidence unavailable`); };
    else if (row.prField) delete pr[row.prField];
    else delete evidence[row.field];
    const decision = await decideStaleReferralHumanHold(pr, options);
    checked(decision, row.cause, 'unknown');
    await emitShadowEvent(decision, pr, { repo, settings: enabled, env: {} });
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });
});

describe('benign status labels', () => {
  it('status:awaiting-review, red-team:pending and red-team:clear do not make the labels unknown', async () => {
    const { pr, options } = clean();
    pr.labels.push({ name: 'status:awaiting-review' }, { name: 'red-team:pending' }, { name: 'red-team:clear' });
    const decision = await decideStaleReferralHumanHold(pr, options);
    expect(decision.checked).toContainEqual(expect.objectContaining({ cause: 'labels', status: 'absent' }));
  });
});

describe('shadow-only source boundary', () => {
  it('module never touches labels', () => {
    const source = readFileSync(new URL('../stale-referral-human-shadow.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/review-set-label|clear-human/i);
    expect(source).not.toMatch(/(?:gh\s+(?:pr\s+edit|issue\s+edit|label\s+(?:edit|create|delete))|--(?:add|remove)-label)/i);
    expect(source).not.toMatch(/["'](?:pr|issue)["']\s*,\s*["']edit["']|["']label["']\s*,\s*["'](?:edit|create|delete)["']/i);
  });
});
