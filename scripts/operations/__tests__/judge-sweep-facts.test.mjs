import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveHumanReviewSurfaces } from '../../lib/human-review-surfaces.mjs';
import * as judgeSweepFacts from '../judge-sweep-facts.mjs';
import * as judgeSweepFactsIo from '../judge-sweep-facts-io.mjs';
import { buildJudgeSweepBundle, finishJudgeSweep, judgeSweepFactsOperation, needsJudgment, JUDGE_SWEEP_REPO } from '../judge-sweep-facts.mjs';
import { createJudgeSweepFactsReader, createShapeCache, operatorGh } from '../judge-sweep-facts-io.mjs';
import { resolveOperation } from '../run.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { renderPanelComment } from '../../lib/review-render.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import * as throttle from '../../lib/gh-throttle.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40), BASE = 'c'.repeat(40), REPO = JUDGE_SWEEP_REPO;
const shapeCacheKey = (head = SHA, base = BASE) => `${REPO}:${head}:${base}:${createHash('sha256')
  .update(JSON.stringify(resolveHumanReviewSurfaces().categories)).digest('hex')}`;
const NOW = Date.parse('2026-10-22T13:00:00Z');
const at = minutes => new Date(NOW - minutes * 60_000).toISOString();
const facts = overrides => ({ number: 1, title: 'fixture', labels: [], headSha: SHA, round: 1, cap: 5,
  redTeam: { state: 'unknown', latestResultId: null, latestOutcome: null }, latestVerdict: null,
  openReferrals: [], openSendBacks: [], lastFixLoop: null, humanRequired: null,
  minutesSinceUpdate: 1, fixerRunning: false, inCi: false, owner: null, evidenceErrors: [], ...overrides });
const pr = overrides => ({ number: 1, title: 'fixture $(touch sentinel)', headRefOid: SHA, baseRefOid: BASE, labels: [],
  updatedAt: at(1), createdAt: at(120), body: '<!-- authored-by-actor: author -->', author: { login: 'author' },
  assignees: [], files: [{ path: 'scripts/x.mjs' }], changedFiles: 1, statusCheckRollup: [], ...overrides });
const comment = (body, minutes = 1, login = 'chalbert') => ({ body, createdAt: at(minutes), author: { login } });
const advisory = ({ head = SHA, findings = [], minutes = 1, outcome = 'changes', login } = {}) => comment([
  renderPanelComment({ findings, verdict: outcome === 'accept' ? 'accept' : 'changes',
    lensVerdicts: { correctness: outcome }, lenses: ['correctness'] }),
  `**Advisory outcome:** \`${outcome}\``, `Net basis: \`${'c'.repeat(40)}..${head}\``,
].join('\n'), minutes, login);
const finding = { file: 'scripts/x.mjs', line: 12, summary: 'loses the current head',
  category: 'correctness', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const memoryCache = () => {
  let text = '{}';
  return createShapeCache({ cacheDir: '/scratch', read: () => text, write: (_p, data) => { text = data; } });
};
function fixture(overrides = {}) {
  const gh = vi.fn(() => JSON.stringify([pr()]));
  const readComments = vi.fn(() => []);
  const shape = vi.fn(() => ({ humanRequired: false }));
  const options = { checkoutState: () => ({ behind: 0 }), gh, now: () => NOW, readLedgerRows: () => [], readFixRows: () => [],
    readJobs: () => [], readComments, cache: memoryCache(), shape, baseCap: 5, cardReadable: () => false, ...overrides };
  return { ...options, read: createJudgeSweepFactsReader(options) };
}
afterEach(() => vi.restoreAllMocks());

describe('deterministic first-match judge classification', () => {
  it.each([
    ['at-cap', { round: 5 }],
    ['at-cap', { labels: ['status:round-limit'] }],
    // At a known cap the first rule wins. This gate record also catches an unreadable current round.
    ['red-team-blocked-at-cap', { round: null, redTeam: { state: 'blocked', latestOutcome: 'round-cap' } }],
    ['finding-back-unfixed-more-than-once', { verdictHistory: [{ findings: [{ key: 'k' }] }, { findings: [{ key: 'k' }] }] }],
    ['clean-and-owed-approval', { labels: ['review:human'], latestVerdict: { accepted: true }, redTeam: { state: 'clear' } }],
    ['stalled>45min-no-owner', { minutesSinceUpdate: 46 }],
    ['fixer running', { fixerRunning: true, round: 5 }],
    ['fix-loop active (<60 min)', { minutesSinceFixLoop: 59, round: 5 }],
    ['waiting on review', { round: 4 }],
    ['in CI', { inCi: true, round: 5 }],
    ['in CI', { inCi: true }],
    ['waiting on review', {}],
  ])('%s', (reason, patch) => {
    expect(needsJudgment(facts(patch))).toEqual({ reason,
      needsJudgment: !['fixer running', 'in CI', 'waiting on review', 'fix-loop active (<60 min)'].includes(reason) });
  });
  it('does not confuse nonconsecutive findings or missing red-team evidence with a clean approval', () => {
    expect(needsJudgment(facts({ verdictHistory: [{ findings: [{ key: 'k' }] }, { findings: [] }, { findings: [{ key: 'k' }] }] })).needsJudgment).toBe(false);
    expect(needsJudgment(facts({ labels: ['review:human'], latestVerdict: { accepted: true } })).needsJudgment).toBe(false);
    expect(needsJudgment(facts({ round: 3, cap: 8,
      redTeam: { state: 'blocked', latestOutcome: 'round-cap' } })).needsJudgment).toBe(false);
  });
  it('keeps assigned and running PRs out of the no-owner stall rule, including exactly 45 minutes', () => {
    for (const patch of [{ owner: 'alice' }, { fixerRunning: true }, { minutesSinceUpdate: 45 }]) {
      expect(needsJudgment(facts({ minutesSinceUpdate: 46, ...patch })).needsJudgment).toBe(false);
    }
  });
  it('fails closed on unavailable evidence and names an operator fallback', () => {
    expect(needsJudgment(facts({ evidenceErrors: ['comments unreadable'] }))).toMatchObject({
      needsJudgment: true, reason: expect.stringContaining('inspect PR evidence and rerun') });
  });
  const activity = [
    ['idle', {}],
    ['fixer running', { fixerRunning: true }],
    ['CI in flight', { inCi: true }],
    ['fix-loop active', { minutesSinceFixLoop: 59 }],
    ['all active', { fixerRunning: true, inCi: true, minutesSinceFixLoop: 0 }],
  ];
  it.each(activity)('prioritizes unavailable evidence over referrals and cap while %s', (_name, patch) => {
    expect(needsJudgment(facts({ ...patch, round: 5, evidenceErrors: ['comments unreadable'],
      openReferrals: [{ ruled: false, superseded: false }] }))).toEqual({
      needsJudgment: true, reason: 'evidence-unavailable: inspect PR evidence and rerun' });
  });
  it.each(activity)('prioritizes an unruled referral over cap while %s', (_name, patch) => {
    for (const superseded of [false, undefined]) {
      expect(needsJudgment(facts({ ...patch, round: 5,
        openReferrals: [{ ruled: true }, { ruled: false, superseded }] }))).toEqual({
        needsJudgment: true, reason: 'unruled-referral' });
    }
  });
  it('does not require a ruling for ruled, superseded, or unspecified referrals', () => {
    for (const openReferrals of [[], null, undefined, [{ ruled: true }],
      [{ ruled: false, superseded: true }], [{}]]) {
      expect(needsJudgment(facts({ openReferrals }))).toEqual({ needsJudgment: false, reason: 'waiting on review' });
    }
  });
  it('keeps at-cap PRs in CI out of judgment when evidence is readable and no referral awaits a ruling', () => {
    for (const patch of [{ round: 5 }, { labels: ['status:round-limit'] }]) {
      expect(needsJudgment(facts({ ...patch, inCi: true }))).toEqual({ needsJudgment: false, reason: 'in CI' });
    }
  });
  it('builds one complete bundle with counts and no internal classifier inputs', () => {
    const bundle = buildJudgeSweepBundle({ generatedAt: at(0), elapsedMs: 12,
      prs: [facts({ round: 5 }), facts({ number: 2, inCi: true })] });
    expect(bundle).toMatchObject({ generatedAt: at(0), elapsedMs: 12, counts: { needsJudgment: 1, noAction: 1 } });
    expect(bundle.prs).toHaveLength(2);
    expect(bundle.prs[0]).not.toHaveProperty('verdictHistory');
  });
});

// Keep facts() historical: new observations are opt-in so old callers exercise absent fields.
const stallDefaults = { fixerInfraLoop: 3, needsHumanAgedHours: 6, draftWithdrawnAgedHours: 4, waitingFixerMinutes: 45,
  unownedMinutes: 45 };
const judgmentReason = (patch, id, thresholds) => {
  expect(needsJudgment(facts(patch), thresholds)).toEqual({
    needsJudgment: true, reason: expect.stringMatching(new RegExp(`^${id}`)),
  });
};

describe('stall judgment reasons and compatibility', () => {
  it.each([
    ['idle', {}], ['recent fix loop', { minutesSinceFixLoop: 5 }],
    ['fixer running', { fixerRunning: true }], ['in CI', { inCi: true }],
    ['at cap', { round: 5 }],
    ['all active at cap', { minutesSinceFixLoop: 5, fixerRunning: true, inCi: true, round: 5 }],
  ])('prioritizes fixer-infra-loop over %s', (_name, activity) => {
    judgmentReason({ ...activity, infraFailStreak: 3 }, 'fixer-infra-loop');
    judgmentReason({ ...activity, infraFailStreak: 4 }, 'fixer-infra-loop');
    expect(needsJudgment(facts({ ...activity, infraFailStreak: 2 }))).toEqual(needsJudgment(facts(activity)));
  });
  it.each(['review-status:needs-human', 'status:needs-human'])('ages %s by head time, falling back to update time', label => {
    judgmentReason({ labels: [label], minutesSinceHeadChange: 361 }, 'needs-human-aged');
    judgmentReason({ labels: [label], minutesSinceHeadChange: null, minutesSinceUpdate: 361 }, 'needs-human-aged');
    judgmentReason({ labels: [label], minutesSinceUpdate: 361 }, 'needs-human-aged');
    for (const minutesSinceHeadChange of [0, 360]) {
      expect(needsJudgment(facts({ labels: [label], minutesSinceHeadChange, minutesSinceUpdate: 900, owner: 'alice' })))
        .toEqual({ needsJudgment: false, reason: 'owner present' });
    }
  });
  it('uses needs-human-aged only with readable evidence and keeps evidence-unavailable first otherwise', () => {
    const aged = { labels: ['status:needs-human'], minutesSinceHeadChange: 361 };
    judgmentReason({ ...aged, evidenceErrors: [] }, 'needs-human-aged');
    expect(needsJudgment(facts({ ...aged, evidenceErrors: ['comments unreadable'] }))).toEqual({
      needsJudgment: true, reason: 'evidence-unavailable: inspect PR evidence and rerun',
    });
    expect(needsJudgment(facts({ infraFailStreak: 3, evidenceErrors: ['ledger unreadable'] }))).toEqual({
      needsJudgment: true, reason: 'evidence-unavailable: inspect PR evidence and rerun',
    });
  });
  it.each([{ isDraft: true }, { labels: ['review-status:draft-withdrawn'] }])('ages withdrawn drafts: %j', draft => {
    judgmentReason({ ...draft, minutesSinceHeadChange: 241 }, 'draft-withdrawn-aged');
    judgmentReason({ ...draft, minutesSinceHeadChange: null, minutesSinceUpdate: 241 }, 'draft-withdrawn-aged');
    for (const minutesSinceHeadChange of [0, 240]) {
      expect(needsJudgment(facts({ ...draft, minutesSinceHeadChange, minutesSinceUpdate: 900, owner: 'alice' })))
        .toEqual({ needsJudgment: false, reason: 'owner present' });
    }
  });
  it('does not age a nondraft or an unlabelled PR', () => {
    expect(needsJudgment(facts({ isDraft: false, minutesSinceHeadChange: 900 })))
      .toEqual({ needsJudgment: false, reason: 'waiting on review' });
  });
  it.each(['status:answered-waiting-fixer', 'review:changes'])('detects %s without a recent dispatch', label => {
    for (const minutesSinceFixDispatch of [null, 46]) {
      judgmentReason({ labels: [label], minutesSinceFixDispatch }, 'waiting-fixer-not-dispatched');
    }
    for (const minutesSinceFixDispatch of [0, 45]) {
      expect(needsJudgment(facts({ labels: [label], minutesSinceFixDispatch })))
        .toEqual(needsJudgment(facts({ labels: [label] })));
    }
    expect(needsJudgment(facts({ labels: [label], minutesSinceFixDispatch: null, fixerRunning: true })))
      .toEqual({ needsJudgment: false, reason: 'fixer running' });
    expect(needsJudgment(facts({ labels: [label], minutesSinceFixDispatch: null, fixerRunning: null })).reason)
      .not.toMatch(/^waiting-fixer-not-dispatched/);
  });
  it('uses supplied thresholds for each new reason', () => {
    const thresholds = { fixerInfraLoop: 5, needsHumanAgedHours: 8, draftWithdrawnAgedHours: 7, waitingFixerMinutes: 90 };
    const cases = [
      ['fixer-infra-loop', { infraFailStreak: 4 }, { infraFailStreak: 5 }],
      ['needs-human-aged', { labels: ['status:needs-human'], minutesSinceHeadChange: 480 },
        { labels: ['status:needs-human'], minutesSinceHeadChange: 481 }],
      ['draft-withdrawn-aged', { isDraft: true, minutesSinceHeadChange: 420 }, { isDraft: true, minutesSinceHeadChange: 421 }],
      ['waiting-fixer-not-dispatched', { labels: ['review:changes'], minutesSinceFixDispatch: 90 },
        { labels: ['review:changes'], minutesSinceFixDispatch: 91 }],
    ];
    for (const [id, below, above] of cases) {
      expect(needsJudgment(facts(below), thresholds).reason).not.toMatch(new RegExp(`^${id}`));
      judgmentReason(above, id, thresholds);
    }
  });
  it.each([
    { round: 5 }, { round: 6 }, { labels: ['status:round-limit'] }, { labels: ['status:cap-exhausted'] },
  ])('does not classify accepted or merge-ready PRs as at-cap: %j', cap => {
    const capLabels = cap.labels ?? [];
    for (const labels of [['ready-to-merge'], ['review:accepted', 'ready-to-merge']]) {
      expect(needsJudgment(facts({ ...cap, labels: [...capLabels, ...labels] })))
        .toEqual({ needsJudgment: false, reason: 'awaiting-merge' });
    }
    judgmentReason({ ...cap, labels: [...capLabels, 'review:accepted', 'review:human'] }, 'awaiting-operator');
    expect(needsJudgment(facts(cap))).toEqual({ needsJudgment: true, reason: 'at-cap' });
  });
  it('pins historical bundle rows and results when all new observations are absent or null', () => {
    const old = [facts({ round: 5 }), facts({ number: 2, inCi: true }), facts({ number: 3, labels: ['review:changes'] })];
    const expectedRows = [
      { number: 1, round: 5, needsJudgment: true, reason: 'at-cap', nextOwner: 'judge' },
      { number: 2, round: 1, needsJudgment: false, reason: 'in CI', nextOwner: 'nobody' },
      { number: 3, round: 1, needsJudgment: false, reason: 'waiting for fixes', nextOwner: 'nobody' },
    ].map(row => ({ title: 'fixture', labels: row.number === 3 ? ['review:changes'] : [], headSha: SHA, cap: 5,
      redTeam: { state: 'unknown', latestResultId: null, latestOutcome: null }, latestVerdict: null,
      openReferrals: [], openSendBacks: [], lastFixLoop: null, humanRequired: null,
      minutesSinceUpdate: 1, evidenceErrors: [], ownerSince: 1,
      nextStep: expect.stringMatching(/^[^\r\n]+$/), ...row }));
    expect(buildJudgeSweepBundle({ generatedAt: at(0), elapsedMs: 12, prs: old })).toEqual({
      generatedAt: at(0), elapsedMs: 12, counts: { needsJudgment: 1, noAction: 2 }, prs: expectedRows,
    });
    for (const row of old) {
      expect(needsJudgment({ ...row, infraFailStreak: null, isDraft: null,
        minutesSinceHeadChange: null })).toEqual(needsJudgment(row));
    }
  });
  it('retains old bundle fields alongside new observations and updated counts', () => {
    const observation = { infraFailStreak: 3, isDraft: false, minutesSinceHeadChange: 30, minutesSinceFixDispatch: 5 };
    const input = facts({ ...observation, minutesSinceFixLoop: 5, verdictHistory: [], ignoredFindingReturned: false });
    const { fixerRunning, inCi, owner, verdictHistory, ignoredFindingReturned, ...publicFacts } = input;
    const bundle = buildJudgeSweepBundle({ generatedAt: at(0), elapsedMs: 12, prs: [input] });
    expect(bundle).toEqual({ generatedAt: at(0), elapsedMs: 12, counts: { needsJudgment: 1, noAction: 0 },
      prs: [{ ...publicFacts, needsJudgment: true, reason: expect.stringMatching(/^fixer-infra-loop/),
        nextOwner: 'judge', nextStep: expect.stringMatching(/^[^\r\n]+$/), ownerSince: 5 }] });
  });
});

describe('stall threshold policy cascade (injected IO only)', () => {
  const resolve = (tool, env = {}, platform = null) => judgeSweepFactsIo.resolveStallThresholds({
    env, platform, readFile: () => JSON.stringify({ judgeSweepStall: tool }),
  });
  it('exports a resolver with the standard defaults', () => {
    expect(judgeSweepFactsIo.resolveStallThresholds).toBeTypeOf('function');
    expect(judgeSweepFacts.STALL_DEFAULTS).toEqual(stallDefaults);
    expect(resolve(undefined)).toMatchObject(stallDefaults);
  });
  it('resolves standard then platform then tool then the JSON environment override', () => {
    const platform = { fixerInfraLoop: 4, needsHumanAgedHours: 7, draftWithdrawnAgedHours: 5, waitingFixerMinutes: 60 };
    const tool = { fixerInfraLoop: 5, needsHumanAgedHours: 8, draftWithdrawnAgedHours: 6, waitingFixerMinutes: 75 };
    const envValue = { fixerInfraLoop: 6, needsHumanAgedHours: 9, draftWithdrawnAgedHours: 7, waitingFixerMinutes: 90 };
    expect(resolve(undefined, {}, platform)).toMatchObject(platform);
    expect(resolve(tool, {}, platform)).toMatchObject(tool);
    expect(resolve(tool, { WE_JUDGE_SWEEP_STALL: JSON.stringify(envValue) }, platform)).toMatchObject(envValue);
  });
  it.each(['{bad json', 'null', '[]', JSON.stringify({ fixerInfraLoop: -1, needsHumanAgedHours: 'six',
    draftWithdrawnAgedHours: -4, waitingFixerMinutes: null })])('falls through invalid env values to defaults: %s', raw => {
    expect(resolve(undefined, { WE_JUDGE_SWEEP_STALL: raw })).toMatchObject(stallDefaults);
  });
  it('falls through unreadable settings with an empty environment to standard defaults', () => {
    expect(judgeSweepFactsIo.resolveStallThresholds({ env: {}, platform: null,
      readFile: () => { throw new Error('unreadable'); } })).toMatchObject(stallDefaults);
  });
});

describe('next responsible owner from existing facts', () => {
  const ownerCases = [
    ['fixer', { fixerRunning: true }],
    ...['status:answered-waiting-fixer', 'review:changes'].flatMap(label => [
      ['fixer', { labels: [label], minutesSinceFixDispatch: 0 }],
      ['fixer', { labels: [label], minutesSinceFixDispatch: 45 }],
      ['nobody', { labels: [label], minutesSinceFixDispatch: null }],
      ['nobody', { labels: [label], minutesSinceFixDispatch: 46 }],
    ]),
    ['drain', { labels: ['review:accepted', 'ready-to-merge'] }],
    ...['review:accepted', 'review:human', 'status:needs-you'].map(label => ['operator', { labels: [label] }]),
    ['red-team', { redTeam: { state: 'pending' } }],
    ['red-team', { labels: ['red-team:pending'] }],
    ...['review:pending', 'status:awaiting-review'].map(label => ['review', { labels: [label] }]),
    ['judge', { evidenceErrors: ['comments unreadable'] }],
    ['judge', { infraFailStreak: 3 }],
    ['judge', { round: 5 }],
    ['judge', { openReferrals: [{ ruled: false, superseded: false }] }],
    ['judge', { labels: ['status:needs-human'], minutesSinceHeadChange: 361 }],
    ['judge', { labels: ['review-status:needs-human'], minutesSinceHeadChange: 361 }],
    ['orchestrator', { labels: ['review-status:draft-withdrawn'] }],
    ['orchestrator', { isDraft: true }],
    ['orchestrator', { labels: ['status:needs-human'] }],
    ['orchestrator', { labels: ['review-status:needs-human'] }],
    ['nobody', {}],
  ];
  it.each(ownerCases)('derives %s with a nonempty one-line next step from %j', (nextOwner, patch) => {
    const input = facts(patch);
    const before = structuredClone(input);
    const result = judgeSweepFacts.deriveNextOwner(input);
    expect(result).toEqual({ nextOwner, nextStep: expect.any(String) });
    expect(result.nextStep.trim()).not.toBe('');
    expect(result.nextStep).not.toMatch(/[\r\n]/);
    expect(judgeSweepFacts.deriveNextOwner(input)).toEqual(result);
    expect(input).toEqual(before);
  });
  it('keeps a running fixer responsible for a needs-human PR', () => {
    expect(judgeSweepFacts.deriveNextOwner(facts({ fixerRunning: true, labels: ['status:needs-human'] })))
      .toMatchObject({ nextOwner: 'fixer' });
  });
  it('adds owner, next step and numeric age to every bundle row without mutating inputs', () => {
    const prs = ownerCases.map(([, patch], i) => facts({ ...patch, number: i + 1 }));
    const before = structuredClone(prs);
    const bundle = buildJudgeSweepBundle({ generatedAt: at(0), elapsedMs: 12, prs });
    expect(bundle.prs).toHaveLength(prs.length);
    bundle.prs.forEach((row, i) => {
      expect(row).toMatchObject({ ...judgeSweepFacts.deriveNextOwner(prs[i]), ownerSince: 1 });
      expect(Number.isFinite(row.ownerSince)).toBe(true);
    });
    expect(prs).toEqual(before);
  });
  it.each([
    [{ minutesSinceFixLoop: 12, minutesSinceUpdate: 90 }, 12],
    [{ minutesSinceFixLoop: 0, minutesSinceUpdate: 90 }, 0],
    [{ minutesSinceFixLoop: null, minutesSinceUpdate: 23 }, 23],
    [{ minutesSinceUpdate: 23 }, 23],
  ])('derives ownerSince from fix-loop age with update age as fallback: %j', (patch, ownerSince) => {
    expect(buildJudgeSweepBundle({ prs: [facts(patch)] }).prs[0].ownerSince).toBe(ownerSince);
  });
});

describe('unowned is a last-resort stall reason', () => {
  const unownedRow = (patch, thresholds) => buildJudgeSweepBundle({ thresholds,
    prs: [facts({ minutesSinceUpdate: 1, minutesSinceFixLoop: 90, ...patch })] }).prs[0];
  it.each([[], ['status:needs-human'], ['review-status:draft-withdrawn']])(
    'judges an unowned PR after 45 minutes: %j', labels => {
      const row = unownedRow({ labels });
      expect(['orchestrator', 'nobody']).toContain(row.nextOwner);
      expect(row).toMatchObject({ ownerSince: 90, needsJudgment: true, reason: expect.stringMatching(/^unowned/) });
    });
  it.each([0, 44, 45])('does not fire for nobody or orchestrator at owner age %s minutes', ownerSince => {
    for (const labels of [[], ['status:needs-human'], ['review-status:draft-withdrawn']]) {
      const row = unownedRow({ labels, minutesSinceFixLoop: ownerSince });
      expect(row.ownerSince).toBe(ownerSince);
      expect(row.reason).not.toMatch(/^unowned/);
    }
  });
  it('uses the supplied unownedMinutes threshold with a strict greater-than boundary', () => {
    expect(unownedRow({}, { unownedMinutes: 90 }).reason).not.toMatch(/^unowned/);
    expect(unownedRow({ minutesSinceFixLoop: 91 }, { unownedMinutes: 90 }))
      .toMatchObject({ needsJudgment: true, reason: expect.stringMatching(/^unowned/) });
  });
  it.each([
    ['fixer', { fixerRunning: true }],
    ['review', { labels: ['review:pending'] }],
    ['red-team', { redTeam: { state: 'pending' } }],
    ['drain', { labels: ['review:accepted', 'ready-to-merge'] }],
    ['judge', { round: 5 }],
    ['operator', { labels: ['status:needs-you'] }],
  ])('never fires for %s even after the threshold', (nextOwner, patch) => {
    const row = unownedRow(patch);
    expect(row).toMatchObject({ nextOwner, ownerSince: 90 });
    expect(row.reason).not.toMatch(/^unowned/);
  });
  it.each([
    ['evidence-unavailable', { evidenceErrors: ['unreadable'] }],
    ['unruled-referral', { openReferrals: [{ ruled: false }] }],
    ['fixer-infra-loop', { infraFailStreak: 3 }],
    ['needs-human-aged', { labels: ['status:needs-human'], minutesSinceHeadChange: 361 }],
    ['draft-withdrawn-aged', { isDraft: true, minutesSinceHeadChange: 241 }],
    ['at-cap', { round: 5 }],
    ['stalled>45min-no-owner', { minutesSinceUpdate: 91 }],
  ])('preserves existing %s precedence over unowned', (reason, patch) => {
    // No recent fix loop: avoid the existing active-loop early return as well as the new age boundary.
    expect(unownedRow(patch)).toMatchObject({ needsJudgment: true,
      reason: expect.stringMatching(new RegExp(`^${reason}`)) });
  });
  it.each([[5972, 'status:answered-waiting-fixer'], [5996, 'review:changes']])(
    '#%s waiting-fixer without dispatch keeps waiting-fixer-not-dispatched ahead of unowned', (number, label) => {
      const row = unownedRow({ number, labels: [label], minutesSinceFixDispatch: null, minutesSinceUpdate: 120 });
      expect(['orchestrator', 'nobody']).toContain(row.nextOwner);
      expect(row).toMatchObject({ number, ownerSince: 90, needsJudgment: true, reason: 'waiting-fixer-not-dispatched' });
    });
});

describe('unownedMinutes policy cascade with injected IO', () => {
  const resolve = (platform, tool, envValue, log) => judgeSweepFactsIo.resolveStallThresholds({
    platform, env: envValue === undefined ? {} : { WE_JUDGE_SWEEP_STALL: JSON.stringify({ unownedMinutes: envValue }) },
    readFile: () => JSON.stringify({ judgeSweepStall: tool }), log,
  });
  it('resolves standard, platform, tool and environment values in order', () => {
    expect(resolve(null).unownedMinutes).toBe(45);
    expect(resolve({ unownedMinutes: 60 }).unownedMinutes).toBe(60);
    expect(resolve({ unownedMinutes: 60 }, { unownedMinutes: 75 }).unownedMinutes).toBe(75);
    expect(resolve({ unownedMinutes: 60 }, { unownedMinutes: 75 }, 90).unownedMinutes).toBe(90);
  });
  it.each([0, -1, '90', null, Infinity])('falls through invalid unownedMinutes %j to a valid lower layer', value => {
    expect(resolve({ unownedMinutes: 60 }, { unownedMinutes: value }, value).unownedMinutes).toBe(60);
  });
});

describe('injected reader and shared evidence readers', () => {
  it('lists once, includes every PR, and reads comments for in-flight first-round PRs', () => {
    const f = fixture({ gh: vi.fn(() => JSON.stringify([pr({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }), pr({ number: 2 })])),
      readJobs: () => [{ repo: REPO, pr: 2, kind: 'fix-run' }] });
    const bundle = buildJudgeSweepBundle(f.read());
    expect(bundle.prs.map(p => p.reason)).toEqual(['in CI', 'fixer running']);
    expect(bundle.prs.map(p => p.number)).toEqual([1, 2]);
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(f.readComments).toHaveBeenCalledTimes(2);
    expect(f.shape).not.toHaveBeenCalled();
    const args = f.gh.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    for (const field of ['labels', 'headRefOid', 'baseRefOid', 'updatedAt', 'files', 'author']) expect(args.at(-1)).toContain(field);
  });
  it('retries a thrown comment read once and clears evidence errors after success', () => {
    const readComments = vi.fn().mockImplementationOnce(() => { throw new Error('transient'); })
      .mockReturnValueOnce([]);
    const f = fixture({ readComments });
    const row = f.read().prs[0];
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(readComments.mock.calls[1][0]).toEqual(readComments.mock.calls[0][0]);
    expect(row.evidenceErrors).toEqual([]);
    expect(needsJudgment(row)).toEqual({ needsJudgment: false, reason: 'waiting on review' });
  });
  it.each([true, false])('reads draft state and the latest listed commit time (draft=%s)', isDraft => {
    const gh = vi.fn(() => JSON.stringify([pr({ isDraft, updatedAt: at(1),
      commits: [{ oid: OLD, committedDate: at(500) }, { oid: SHA, committedDate: at(241) }] })]));
    const f = fixture({ gh });
    expect(f.read().prs[0]).toMatchObject({ isDraft, minutesSinceHeadChange: 241, minutesSinceUpdate: 1 });
    expect(gh.mock.calls[0][0].at(-1)).toContain('isDraft');
    // Listing 200 PRs with commits exceeds GitHub's GraphQL node limit, so it is read only when supplied.
    expect(gh.mock.calls[0][0].at(-1)).not.toContain('commits');
  });
  it('reports unknown head age and no dispatch as null when listing commits and fix rows are absent', () => {
    expect(fixture().read().prs[0]).toMatchObject({ minutesSinceHeadChange: null, minutesSinceFixDispatch: null });
  });
  const fixRow = (minutes, patch = {}) => ({ repo: 'we', pr: 1, head: SHA, kind: 'outcome',
    outcome: 'failed', infra: true, session: `fixture-${minutes}`, at: at(minutes), ...patch });
  it('counts three trailing infra failures for this head, ignoring dispatches and unrelated rows', () => {
    const rows = [fixRow(10), fixRow(30), fixRow(20),
      fixRow(1, { repo: 'frontierui' }), fixRow(2, { pr: 2 }), fixRow(3, { head: OLD }),
      fixRow(4, { kind: 'fix', outcome: undefined, infra: undefined }),
      fixRow(40, { outcome: 'pushed', infra: false })];
    const row = fixture({ readFixRows: () => rows }).read().prs[0];
    expect(row).toMatchObject({ infraFailStreak: 3, minutesSinceFixDispatch: 4 });
    judgmentReason(row, 'fixer-infra-loop');
  });
  it('resets the infra failure streak on a pushed outcome and starts counting anew', () => {
    const rows = [fixRow(30), fixRow(20), fixRow(10)];
    const f = fixture({ readFixRows: () => rows });
    expect(f.read().prs[0].infraFailStreak).toBe(3);
    rows.push(fixRow(5, { outcome: 'pushed', infra: false }));
    expect(f.read().prs[0].infraFailStreak).toBe(0);
    rows.push(fixRow(1));
    expect(f.read().prs[0].infraFailStreak).toBe(1);
  });
  it('counts failed lease reasons case-insensitively when infra is not true', () => {
    const row = fixture({ readFixRows: () => [fixRow(3, { infra: false, reason: 'LEASE unavailable' }),
      fixRow(2, { infra: undefined, reason: 'lease busy' }), fixRow(1)] }).read().prs[0];
    expect(row.infraFailStreak).toBe(3);
  });
  it.each([
    { outcome: 'no-change', infra: false },
    { outcome: 'failed', infra: false, reason: 'unit tests failed' },
    { outcome: 'pushed', infra: false, reason: 'lease recovered' },
  ])('stops counting consecutive infra failures at %j', reset => {
    const row = fixture({ readFixRows: () => [fixRow(40), fixRow(30), fixRow(20, reset), fixRow(10)] }).read().prs[0];
    expect(row.infraFailStreak).toBe(1);
  });
  it.each(['ci-heal', 'fix', 'rearm'])('ages the newest %s dispatch for the PR, ignoring newer outcomes', kind => {
    const row = fixture({ readFixRows: () => [fixRow(80, { kind: 'fix' }),
      fixRow(46, { kind, head: OLD }), fixRow(1, { outcome: 'pushed', infra: false }),
      fixRow(2, { kind, repo: 'frontierui' }), fixRow(3, { kind, pr: 2 })] }).read().prs[0];
    expect(row.minutesSinceFixDispatch).toBe(46);
  });
  it('uses ledger rounds instead of a label guess and retains the latest fix-loop outcome', () => {
    const f = fixture({ readLedgerRows: () => ['b', 'c', 'd', 'e'].map(h => ({ repo: REPO, pr: 1, type: 'review-run', headSha: h.repeat(40), at: at(20) })),
      readFixRows: () => [{ repo: 'we', pr: 1, kind: 'fix', at: at(80) }, { repo: 'we', pr: 1, kind: 'outcome', outcome: 'no-change', at: at(70) },
        { repo: 'frontierui', pr: 1, kind: 'outcome', outcome: 'pushed', at: at(61) }] });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ round: 5, cap: 5, reason: 'at-cap',
      lastFixLoop: { kind: 'outcome', outcome: 'no-change', at: at(70) } });
  });
  it('extracts findings/lens verdicts and detects a key present in consecutive published verdicts', () => {
    const f = fixture({ readComments: () => [advisory({ head: OLD, findings: [finding], minutes: 20 }), advisory({ findings: [finding] })] });
    const row = buildJudgeSweepBundle(f.read()).prs[0];
    expect(row.reason).toBe('finding-back-unfixed-more-than-once');
    expect(row.latestVerdict).toMatchObject({ lensVerdicts: { correctness: 'changes' },
      findings: [{ key: referralFindingKey('correctness', finding), severity: 'broken', class: 'correctness' }] });
  });
  it('credits a trusted grant using the shared additive floor and grant-time round anchor', () => {
    const grant = buildRoundExtensionComment({ repo: REPO, pr: 1, by: 1, actor: 'chalbert',
      channel: 'fixture', reason: 'progress', at: at(1) });
    const f = fixture({ readComments: () => [comment(grant)], readLedgerRows: () =>
      ['b', 'c', 'd', 'e', 'f', '1', '2'].map(h => ({ repo: REPO, pr: 1, type: 'review-run', headSha: h.repeat(40), at: at(20) })) });
    // Seven reviewed heads at grant time + one grant exceeds the additive floor of six.
    expect(f.read().prs[0]).toMatchObject({ round: 8, cap: 8 });
    const forged = fixture({ readComments: () => [comment(grant, 1, 'untrusted-user')] });
    expect(forged.read().prs[0].cap).toBe(5);
  });
  it('requires trusted, live-head acceptance AND red-team evidence before reporting owed approval', () => {
    const comments = [advisory({ outcome: 'accept' }), comment(redTeamMarker(1, SHA))];
    const f = fixture({ gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]), readComments: () => comments });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ reason: 'clean-and-owed-approval', humanRequired: false,
      redTeam: { state: 'clear', latestResultId: expect.any(String) } });
    comments[0] = advisory({ outcome: 'accept', login: 'untrusted-user' });
    expect(buildJudgeSweepBundle(f.read()).prs[0].needsJudgment).toBe(false);
    comments[0] = advisory({ outcome: 'accept', head: OLD });
    expect(buildJudgeSweepBundle(f.read()).prs[0].needsJudgment).toBe(false);
  });
  it('reads active referrals through the shared reader and reports an unruled finding', () => {
    const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-fixture';
    const record = { version: 1, repo: REPO, pr: 1, head: SHA, runId,
      reviewer: mandatoryReferralReviewer(runId), authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key: referralFindingKey(seat, finding), seat, original: finding, finding: normalizeFinding(finding) }], rulings: [] };
    const f = fixture({ readComments: () => [comment(renderReferralRecord(record))] });
    const row = f.read().prs[0];
    expect(row.evidenceErrors).toEqual([]);
    expect(row.openReferrals).toEqual([{ key: referralFindingKey(seat, finding), ruled: false, superseded: false }]);
    expect(needsJudgment(row)).toEqual({ needsJudgment: true, reason: 'unruled-referral' });
  });
  const referralSignals = [
    ['comments only', {}],
    ['body', { body: '<!-- authored-by-actor: author -->\nMandatory REFERRALS await a ruling.' }],
    ['title', { title: 'Resolve mandatory referral' }],
    ['label', { labels: [{ name: 'review:referral' }] }],
  ];
  const inFlight = [
    ['CI', { statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }, []],
    ['fixer', {}, [{ repo: REPO, pr: 1, kind: 'fix-run' }]],
    ['pending review', { labels: [{ name: 'review:pending' }] }, []],
  ];
  it.each(inFlight)('reads comments for a plain round-one PR during %s', (_activity, active, jobs) => {
    const f = fixture({ gh: () => JSON.stringify([pr(active)]), readJobs: () => jobs });
    expect(buildJudgeSweepBundle(f.read()).prs[0].needsJudgment).toBe(false);
    expect(f.readComments).toHaveBeenCalledTimes(1);
  });
  it.each(['body', 'title'])('reads comments when an in-flight PR has no readable %s', field => {
    const f = fixture({ gh: () => JSON.stringify([pr({ [field]: null,
      statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] })]) });
    expect(f.read().prs[0].openReferrals).toEqual([]);
    expect(f.readComments).toHaveBeenCalledTimes(1);
  });
  it.each(referralSignals.flatMap(([signal, evidence]) => inFlight.map(([activity, active, jobs]) =>
    ({ signal, activity, evidence, active, jobs }))))(
    'reads an unruled referral signaled by $signal during $activity on round one',
    ({ evidence, active, jobs }) => {
      const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-fixture';
      const record = { version: 1, repo: REPO, pr: 1, head: SHA, runId,
        reviewer: mandatoryReferralReviewer(runId), authorBody: '<!-- authored-by-actor: author -->', attempted: true,
        referrals: [{ key: referralFindingKey(seat, finding), seat, original: finding, finding: normalizeFinding(finding) }], rulings: [] };
      const gh = vi.fn(() => JSON.stringify([pr({ ...active, ...evidence,
        labels: [...(active.labels ?? []), ...(evidence.labels ?? [])] })]));
      const readComments = vi.fn(() => [comment(renderReferralRecord(record))]);
      const f = fixture({ gh, readJobs: () => jobs, readComments });
      const row = f.read().prs[0];
      expect(row.round).toBe(1);
      expect(row.evidenceErrors).toEqual([]);
      expect(row.openReferrals).toEqual([{ key: referralFindingKey(seat, finding), ruled: false, superseded: false }]);
      expect(needsJudgment(row)).toEqual({ needsJudgment: true, reason: 'unruled-referral' });
      expect(readComments).toHaveBeenCalledTimes(1);
      expect(gh).toHaveBeenCalledTimes(1);
    });
  it('fails closed after exactly two failed in-flight referral comment reads', () => {
    const readComments = vi.fn(() => { throw new Error('offline'); });
    const f = fixture({ gh: () => JSON.stringify([pr({
      statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] })]), readComments });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ needsJudgment: true,
      reason: 'evidence-unavailable: inspect PR evidence and rerun',
      evidenceErrors: ['comment evidence unreadable or budget exhausted'] });
    expect(readComments).toHaveBeenCalledTimes(2);
  });
  it('fails closed on malformed markers, a failed comment read, and unavailable process evidence', () => {
    for (const overrides of [
      { readComments: () => [comment('<!-- mandatory-referrals-v1: corrupt -->')] },
      { readComments: () => { throw new Error('offline'); } },
      { readJobs: () => { throw new Error('ps unavailable'); } },
    ]) {
      const row = buildJudgeSweepBundle(fixture(overrides).read()).prs[0];
      expect(row.needsJudgment).toBe(true);
      expect(row.evidenceErrors.length).toBeGreaterThan(0);
    }
  });
  it.each(['red-team:blocked', 'red-team:clear'].flatMap(label => [
    { trigger: 'no shortcut', pending: false, ci: false, fixer: false },
    { trigger: 'review:pending', pending: true, ci: false, fixer: false },
    { trigger: 'in-progress CI', pending: false, ci: true, fixer: false },
    { trigger: 'fixer running', pending: false, ci: false, fixer: true },
    { trigger: 'all shortcuts', pending: true, ci: true, fixer: true },
  ].map(trigger => ({ label, ...trigger }))))(
    'refuses a blocked red-team label without a trusted live result ($label; $trigger)',
    ({ label, pending, ci, fixer }) => {
      const gh = vi.fn(() => JSON.stringify([pr({
        labels: [label, ...(pending ? ['review:pending'] : [])].map(name => ({ name })),
        statusCheckRollup: ci ? [{ name: 'test', status: 'IN_PROGRESS' }] : [],
      })]));
      const f = fixture({ gh, readJobs: () => fixer ? [{ repo: REPO, pr: 1, kind: 'fix-run' }] : [] });
      // Operator rule: unreadable evidence always needs judgment, including during fixer/CI activity.
      expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject(
        { needsJudgment: true, reason: 'evidence-unavailable: inspect PR evidence and rerun',
          evidenceErrors: ['red-team label lacks live result evidence'] });
      expect(f.readComments).toHaveBeenCalledTimes(1);
      expect(gh).toHaveBeenCalledTimes(1);
    });
  it('refuses incomplete/oversized listings with an explicit operator fallback', () => {
    for (const listing of [Array.from({ length: 200 }, (_, i) => pr({ number: i + 1 })), [pr({ labels: null })], [pr({ headRefOid: '' })]]) {
      expect(() => fixture({ gh: () => JSON.stringify(listing) }).read()).toThrow(/inspect PR evidence.*operator query/);
    }
  });
  it('shares a hard 128-call budget across comment pages and PRs', () => {
    const tsv = Array.from({ length: 100 }, () => `ordinary\t${at(1)}\tchalbert\tcomment-id\thttps://example.test/comment`).join('\n');
    const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify([pr({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }),
      pr({ number: 2, labels: [{ name: 'review:pending' }] })]) : tsv);
    const f = fixture({ gh, readComments: undefined });
    const row = buildJudgeSweepBundle(f.read());
    expect(gh).toHaveBeenCalledTimes(128);
    expect(gh.mock.calls.filter(([args]) => args[0] === 'pr')).toHaveLength(1);
    expect(row.prs.every(p => p.needsJudgment && p.evidenceErrors.length)).toBe(true);
    for (const pr of row.prs) expect(pr).toMatchObject({ needsJudgment: true,
      reason: 'evidence-unavailable: inspect PR evidence and rerun',
      evidenceErrors: ['comment evidence unreadable or budget exhausted'] });
    expect(gh.mock.calls.at(-1)[0]).toContain('page=127');
    expect(gh.mock.calls.slice(1).every(([args]) => !args.includes('--paginate'))).toBe(true);
  });
  it('fetches complete short comment threads through the shared paged TSV reader', () => {
    const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify([pr()]) : `hello\\nworld\t${at(1)}\tchalbert\tid\thttps://example.test\n`);
    const f = fixture({ gh, readComments: undefined });
    expect(f.read().prs[0].evidenceErrors).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[1][0]).toContain(`repos/${REPO}/issues/1/comments`);
  });
});

describe('shape cache and operator credential boundary', () => {
  it('calls shape only on a human PR cache miss, persists false, and misses again on a new head', () => {
    let head = SHA;
    const cache = memoryCache();
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ headRefOid: head, labels: [{ name: 'review:human' }] })]) });
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.shape).toHaveBeenCalledTimes(1);
    expect(f.shape).toHaveBeenCalledWith(['scripts/x.mjs'], resolveHumanReviewSurfaces());
    head = OLD;
    f.read();
    expect(f.shape).toHaveBeenCalledTimes(2);
  });
  it('recomputes humanRequired after base changes with an unchanged head', () => {
    let base = BASE;
    let files = ['README.md'];
    const f = fixture({ gh: () => JSON.stringify([pr({ baseRefOid: base, headRefOid: SHA,
      labels: [{ name: 'review:human' }], files: files.map(path => ({ path })), changedFiles: files.length })]),
      shape: vi.fn(paths => ({ humanRequired: paths.includes('AGENTS.md') })) });
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.shape).toHaveBeenCalledTimes(1);
    base = OLD;
    files = ['README.md', 'AGENTS.md'];
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(2);
    expect(f.shape).toHaveBeenLastCalledWith(['README.md', 'AGENTS.md'], resolveHumanReviewSurfaces());
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(2);
  });
  it('loads a persisted head-and-base cache without shape or net-file reads', () => {
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ rulesVersion: 1, entries: { [shapeCacheKey()]: true } }), write: () => { throw new Error('no write'); } });
    const gh = vi.fn(() => JSON.stringify([pr({ files: null, labels: [{ name: 'review:human' }] })]));
    const f = fixture({ cache, gh });
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).not.toHaveBeenCalled();
    expect(gh).toHaveBeenCalledTimes(1); // Only the PR list; no net-file read.
  });
  it('discards historical head-only false entries and recomputes from the net files', () => {
    const oldKey = `${REPO}:${SHA}`;
    let saved;
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ [oldKey]: false }),
      write: (_p, data) => { saved = JSON.parse(data); } });
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]),
      shape: vi.fn(() => ({ humanRequired: true })) });
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(1);
    expect(f.shape).toHaveBeenCalledWith(['scripts/x.mjs'], resolveHumanReviewSurfaces());
    expect(saved).toEqual({ rulesVersion: 1, entries: { [shapeCacheKey()]: true } });
  });
  it.each([undefined, '', 'unreadable'])('fails closed when base identity is unavailable: %s', baseRefOid => {
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ rulesVersion: 1, entries: { [shapeCacheKey()]: false } }),
      write: () => { throw new Error('no cache write'); } });
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ baseRefOid, labels: [{ name: 'review:human' }] })]) });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ humanRequired: null, needsJudgment: true,
      evidenceErrors: ['shape unavailable; inspect full diff before delegating'] });
    expect(f.shape).not.toHaveBeenCalled();
  });
  it('treats corrupt cache as a miss and bounds persisted cache size', () => {
    let saved;
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => '{bad', write: (_p, data) => { saved = data; } });
    expect(cache.get(shapeCacheKey())).toBeUndefined();
    const keys = Array.from({ length: 300 }, (_, i) => shapeCacheKey(i.toString(16).padStart(40, '0')));
    for (const key of keys) cache.set(key, false);
    const persisted = JSON.parse(saved);
    expect(persisted.rulesVersion).toBe(1);
    expect(Object.keys(persisted.entries)).toEqual(keys.slice(-256));
    expect(Object.values(persisted.entries)).toEqual(Array(256).fill(false));
    expect(Buffer.byteLength(saved, 'utf8')).toBeLessThan(128 * 1024);
    const reloaded = createShapeCache({ cacheDir: '/scratch', read: () => saved, write: () => {} });
    expect(reloaded.get(keys[0])).toBeUndefined();
    expect(reloaded.get(keys[299])).toBe(false);
  });
  it('fails closed on a truncated net-file list or malformed shape instead of caching false', () => {
    for (const overrides of [
      { gh: () => JSON.stringify([pr({ files: [], changedFiles: 200, labels: [{ name: 'review:human' }] })]) },
      { gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]), shape: () => ({}) },
    ]) {
      const row = buildJudgeSweepBundle(fixture(overrides).read()).prs[0];
      expect(row).toMatchObject({ humanRequired: null, needsJudgment: true });
      expect(row.evidenceErrors).toContain('shape unavailable; inspect full diff before delegating');
    }
  });
  it('unsets both environment tokens and uses the operator binary inside gh-throttle with no retries', () => {
    const call = vi.spyOn(throttle, 'runGhSync').mockReturnValue('[]');
    operatorGh(['pr', 'list']);
    expect(call).toHaveBeenCalledWith(['pr', 'list'], expect.objectContaining({
      throttle: { bin: '/opt/homebrew/bin/gh', personalRoute: false, maxAttempts: 1 },
    }));
    const options = call.mock.calls[0][1];
    expect(options.env).not.toHaveProperty('GH_TOKEN');
    expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('pure sweep report coverage', () => {
  const bundle = { prs: [{ number: 5996 }, { number: 12 }, { number: 5972 }] };
  it('lists missing bundle PRs in numeric order and counts covered PRs once', () => {
    const before = structuredClone(bundle);
    const report = [5972, 5972, 9999];
    expect(judgeSweepFacts.checkSweepCoverage(bundle, report)).toEqual({ missing: [12, 5996], covered: 1 });
    expect(bundle).toEqual(before);
    expect(report).toEqual([5972, 5972, 9999]);
  });
  it('handles complete, empty and wholly missing coverage', () => {
    expect(judgeSweepFacts.checkSweepCoverage(bundle, [12, 5972, 5996])).toEqual({ missing: [], covered: 3 });
    expect(judgeSweepFacts.checkSweepCoverage(bundle, [])).toEqual({ missing: [12, 5972, 5996], covered: 0 });
    expect(judgeSweepFacts.checkSweepCoverage({ prs: [] }, [5972])).toEqual({ missing: [], covered: 0 });
  });
  it.each([undefined, null, {}, '5972', [5972, '5996'], [1.5], [NaN], [Infinity], [null]])(
    'fails closed on non-array or non-integer report numbers: %j', report => {
      expect(() => judgeSweepFacts.checkSweepCoverage(bundle, report)).toThrow(TypeError);
    });
  it.each([null, {}, { prs: null }, { prs: {} }, { prs: [null] },
    { prs: [{ number: '5972' }] }, { prs: [{ number: 1.5 }] }])(
    'fails closed on malformed bundle PR numbers: %j', input => {
      expect(() => judgeSweepFacts.checkSweepCoverage(input, [])).toThrow(TypeError);
    });
  it('parses #N and PR N report tokens into numeric PR numbers', () => {
    expect(judgeSweepFacts.parseReportPrNumbers('Handled #12, PR 5972.\n#5996.'))
      .toEqual([12, 5972, 5996]);
  });
  it('ignores bare numbers and treats shell-looking report text as inert data', () => {
    expect(judgeSweepFacts.parseReportPrNumbers('2026-10-28: 5972 items; $(touch sentinel); #5996'))
      .toEqual([5996]);
    expect(judgeSweepFacts.parseReportPrNumbers('')).toEqual([]);
  });
  it.each([null, undefined, 5972, ['#5972'], {}])('rejects non-text reports: %j', text => {
    expect(() => judgeSweepFacts.parseReportPrNumbers(text)).toThrow(TypeError);
  });
});

describe('coverage CLI with an injected report reader', () => {
  const reportFile = 'reports/judge sweep $(touch sentinel).txt';
  const outcome = (input = { 'check-coverage': reportFile }) => ({ code: 0, lines: [],
    run: { input, verdict: { prs: [{ number: 5996 }, { number: 5972 }, { number: 12 }] } } });
  it('declares --check-coverage as a CLI input and carries the report path to finish', async () => {
    const declaration = judgeSweepFactsOperation({ readFacts: fixture().read });
    const registry = createRegistry();
    registry.register(declaration);
    const result = await runOperationCli({ declaration, registry, sinks: {}, store: createMemoryRunStore(),
      argv: [`--check-coverage=${reportFile}`], newRunId: () => 'judge-sweep-coverage-fixture' });
    expect(result.code).toBe(0);
    expect(result.run.input['check-coverage']).toBe(reportFile);
    const readFile = vi.fn(() => '#1');
    expect(finishJudgeSweep(result, { readFile }).code).toBe(0);
    expect(readFile.mock.calls[0][0]).toBe(reportFile);
  });
  it('lists every missing PR and returns nonzero when coverage is incomplete', () => {
    const readFile = vi.fn(() => 'Reviewed PR 5972');
    const result = finishJudgeSweep(outcome(), { readFile });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0][0]).toBe(reportFile);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/missing/i);
    expect(result.lines.join('\n')).toMatch(/#12\b/);
    expect(result.lines.join('\n')).toMatch(/#5996\b/);
  });
  it('returns zero when all bundle PRs appear as either supported token', () => {
    const readFile = vi.fn(() => '#5996; PR 5972; PR 12; #5996');
    const result = finishJudgeSweep(outcome(), { readFile });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
  });
  it.each(['', 'Only 5996 and 5972 and 12, without PR tokens'])('does not claim coverage from report %j', text => {
    expect(finishJudgeSweep(outcome(), { readFile: () => text }).code).not.toBe(0);
  });
  it('fails closed with an operator-visible report error when the report is unreadable', () => {
    const result = finishJudgeSweep(outcome(), { readFile: () => { throw new Error('report unreadable'); } });
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/report|coverage/i);
    expect(result.lines.join('\n')).toMatch(/read|inspect|rerun/i);
  });
  it('preserves an upstream failure without reading the report', () => {
    const readFile = vi.fn();
    const failure = { ...outcome(), code: 2, lines: ['evidence unavailable'] };
    expect(finishJudgeSweep(failure, { readFile })).toEqual({ code: 2, lines: failure.lines });
    expect(readFile).not.toHaveBeenCalled();
  });
  it('keeps the ordinary JSON path and does not read a report when no coverage flag was supplied', () => {
    const readFile = vi.fn();
    const result = finishJudgeSweep(outcome({}), { readFile });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0])).toEqual(outcome().run.verdict);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('declared CLI registration', () => {
  it('registers compute-only with no sinks', () => {
    const { declaration, sinks } = resolveOperation('judge-sweep-facts');
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(sinks).toEqual({});
  });
  it('escapes terminal and bidi controls while preserving inert untrusted titles in JSON', () => {
    const title = '$(touch sentinel)\u001b[31m\u009b\u202e';
    const result = finishJudgeSweep({ code: 0, run: { verdict: { prs: [{ title }] } } });
    expect(result.lines[0]).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(JSON.parse(result.lines[0]).prs[0].title).toBe(title);
  });
  it('prints exactly one JSON bundle with or without --json using only an in-memory run store', async () => {
    for (const argv of [[], ['--json']]) {
      const declaration = judgeSweepFactsOperation({ readFacts: fixture().read });
      const registry = createRegistry();
      registry.register(declaration);
      const store = createMemoryRunStore();
      const outcome = await runOperationCli({ declaration, registry, sinks: {}, store, argv, newRunId: () => 'judge-sweep-fixture' });
      const printed = finishJudgeSweep(outcome);
      expect(printed.code).toBe(0);
      expect(printed.lines).toHaveLength(1);
      expect(JSON.parse(printed.lines[0])).toMatchObject({ counts: { needsJudgment: 0, noAction: 1 }, prs: [{ number: 1 }] });
    }
  });
});
