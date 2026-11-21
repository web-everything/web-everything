/** Bounded observations must expose grants that need evidence beyond list + comments. */
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveHumanReviewSurfaces } from '../../lib/human-review-surfaces.mjs';
import { runGhSync } from '../../lib/gh-throttle.mjs';
import { createJudgeSweepFactsReader, createShapeCache, JUDGE_SWEEP_REPO, operatorGh, readCheckoutState, readFromFreshOrigin } from '../judge-sweep-facts-io.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgeSweepBundle } from '../judge-sweep-facts.mjs';
import { buildShapePlan } from '../../review-core-cli.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord,
  REFERRAL_DROP_REASON, REFERRAL_SUPERSEDE_REASON, validateReferralRecord } from '../../lib/jury-core.mjs';

vi.mock('../../lib/gh-throttle.mjs', async original => ({ ...await original(), runGhSync: vi.fn() }));

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

const repo = 'o/r', head = 'a'.repeat(40), at = '2026-10-22T13:00:00Z';
// Keep the production cap; detail fixtures explicitly use round three (cap - 2).
const baseCap = 5;
const exec = vi.fn();
const policyHash = () => createHash('sha256').update(JSON.stringify(resolveHumanReviewSurfaces().categories)).digest('hex');

it.each([
  ['automatic standing grant', 'web-everything[bot]', true, baseCap, true],
  ['operator grant', OPERATOR_LOGINS[0], false, baseCap + 1, false],
  ['untrusted grant', 'untrusted-contributor', true, baseCap, false],
])('keeps %s scope explicit within the list-and-comments budget', (_name, login, standing, cap, incomplete) => {
  const comments = [{ id: 'IC_grant', author: { login }, createdAt: at,
    body: buildRoundExtensionComment({ repo, pr: 1, by: 1, actor: OPERATOR_LOGINS[0],
      channel: 'test', reason: 'one more round', at,
      ...(standing ? { standingRuling: `${repo}#6000`, head, episode: `${repo}#1@${head}:review:12/12` } : {}),
    }) }];
  const calls = [];
  const reader = createJudgeSweepFactsReader({ findSuspendedRuns: () => [],
    checkoutState: () => ({ behind: 0 }),
    gh: args => {
      calls.push(args);
      if (args[0] !== 'pr' || !['list', 'view'].includes(args[1])) throw new Error('unexpected extra GitHub read');
      const value = { number: 1, title: 'scope fixture', headRefOid: head,
        labels: [], assignees: [], updatedAt: at, body: '', createdAt: at, statusCheckRollup: [], commits: [] };
      return JSON.stringify(args[1] === 'list' ? [value] : value);
    },
    now: () => Date.parse(at), baseCap,
    readLedgerRows: () => rounds(1, 3), readFixRows: () => [], readJobs: () => [],
    readComments: () => comments,
  });
  const facts = reader({ repo }).prs[0];
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(expect.arrayContaining(['--repo', repo]));
  expect(facts.cap).toBe(cap);
  expect(facts.evidenceErrors).toEqual(incomplete
    ? ['standing ruling unverified; inspect ruling and grant scope before judging'] : []);
});

const pr = (extra = {}) => ({ number: 1, title: 'IO fixture', headRefOid: head,
  baseRefOid: 'b'.repeat(40), labels: [], assignees: [], updatedAt: at,
  body: '<!-- authored-by-actor: author -->', createdAt: at, statusCheckRollup: [], commits: [], ...extra });
const options = (extra = {}) => {
  const opts = ({
  findSuspendedRuns: () => [],
  checkoutState: () => ({ behind: 0 }),
  exec,
  gh: () => JSON.stringify([pr()]), now: () => Date.parse(at), baseCap,
  readLedgerRows: () => Array.from({ length: 199 }, (_, i) => rounds(i + 1, 3)).flat(),
  readFixRows: () => [], readJobs: () => [], readComments: () => [],
  cache: createShapeCache({ read: () => '{}', write: () => {} }), ...extra,
  });
  // Legacy fixtures hold full PR objects; model gh view returning one object.
  const transport = opts.gh;
  opts.gh = args => {
    const value = transport(args);
    if (args[1] !== 'view') return value;
    const parsed = JSON.parse(value);
    return JSON.stringify(Array.isArray(parsed) ? parsed.find(p => p.number === Number(args[2])) : parsed);
  };
  return opts;
};
const read = extra => createJudgeSweepFactsReader(options(extra))({ repo }).prs[0];
const comment = body => ({ id: 'IC_referral', body, author: { login: 'web-everything' }, createdAt: at });

// Every failed source must leave independently readable list and comment evidence intact.
function unreadableSource(source) {
  return read({
    [source]: () => { throw new Error('source unavailable'); },
    gh: () => JSON.stringify([pr({ labels: [{ name: 'review:pending' }] })]),
    now: () => Date.parse(at) + 30 * 60_000,
    readComments: () => [comment(renderRedTeamComment({ pr: 1, rev: head,
      provider: 'codex', model: 'fixture', findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }))],
  });
}
function expectIndependentEvidence(facts) {
  expect(facts.labels).toEqual(['review:pending']);
  expect(facts.headSha).toBe(head);
  expect(facts.minutesSinceUpdate).toBe(30);
  expect(facts.redTeam).toEqual({ state: 'clear', latestResultId: expect.stringMatching(/^[a-f0-9]{16}$/), latestOutcome: null });
}

it('reports verdict ledger unreadable and preserves unrelated evidence', () => {
  const facts = unreadableSource('readLedgerRows');
  expect(facts.evidenceErrors).toEqual(['verdict ledger unreadable']);
  expect(facts.round).toBeNull();
  expectIndependentEvidence(facts);
});

it('reports fix-loop ledger unreadable and preserves unrelated evidence', () => {
  const facts = unreadableSource('readFixRows');
  expect(facts.evidenceErrors).toEqual(['fix-loop ledger unreadable']);
  expect(facts.lastFixLoop).toBeNull();
  expect(facts.minutesSinceFixLoop).toBeNull();
  expectIndependentEvidence(facts);
});

it('reports live jobs unreadable and preserves unrelated evidence', () => {
  const facts = unreadableSource('readJobs');
  expect(facts.evidenceErrors).toEqual(['live jobs unreadable']);
  expect(facts.fixerRunning).toBeNull();
  expect(facts.owner).toBe('unknown');
  expectIndependentEvidence(facts);
});

it('reports worker repository unknown for an unscoped worker with no assignee', () => {
  const facts = read({ readJobs: () => [{ pr: 1, kind: 'fix-run' }] });
  expect(facts.evidenceErrors).toEqual(['worker repository unknown']);
  expect(facts.fixerRunning).toBeNull();
  expect(facts.owner).toBe('unknown');
});

it.each(['red-team:clear', 'red-team:blocked'])('reports red-team label lacks live result evidence (%s)', label => {
  const facts = read({ gh: () => JSON.stringify([pr({ labels: [{ name: label }] })]) });
  expect(facts.evidenceErrors).toEqual(['red-team label lacks live result evidence']);
  expect(facts.redTeam).toEqual({ state: 'unknown', latestResultId: null, latestOutcome: null });
});

it('reports round-limit label disagrees with round evidence below the cap', () => {
  const facts = read({ gh: () => JSON.stringify([pr({ labels: [{ name: 'status:at-round-limit' }] })]) });
  expect(facts.round).toBe(3);
  expect(facts.cap).toBe(baseCap);
  expect(facts.evidenceErrors).toEqual(['round-limit label disagrees with round evidence']);
});

it.each(['advisory:accepted', 'review:accepted'])('reports accepted label lacks live verdict evidence (%s)', label => {
  const facts = read({ gh: () => JSON.stringify([pr({ labels: [{ name: label }] })]) });
  expect(facts.evidenceErrors).toEqual(['accepted label lacks live verdict evidence']);
  expect(facts.latestVerdict).toBeNull();
});

it('fails closed on verdict findings incomplete when the header count differs from parsed findings', () => {
  const verdict = count => comment([
    '**Verdict:** changes requested',
    `Net basis: \`${'b'.repeat(40)}..${head}\``,
    `### Findings (${count})`,
    '**correctness** (1)',
    '- `scripts/x.mjs:10` — Missing evidence _[CONFIRMED]_ [impact if unfixed: broken]',
  ].join('\n'));
  // The same trusted verdict parses normally when its declared count is complete.
  const complete = read({ readComments: () => [verdict(1)] });
  expect(complete.evidenceErrors).toEqual([]);
  expect(complete.latestVerdict.findings).toHaveLength(1);
  const incomplete = read({ readComments: () => [verdict(2)] });
  // commentVerdict's internal 'verdict findings incomplete' error is surfaced by the comment boundary.
  expect(incomplete.evidenceErrors).toEqual(['comment evidence unreadable or budget exhausted']);
  expect(incomplete.latestVerdict).toBeNull();
  expect(incomplete.verdictHistory).toEqual([]);
});

function referralRecord(summaries = ['active finding'], seat = 'judgeCorrectnessAdvisory') {
  const runId = 'review-pr-1';
  return { version: 1, repo, pr: 1, head, runId, reviewer: mandatoryReferralReviewer(runId),
    authorBody: pr().body, attempted: true, rulings: [],
    referrals: summaries.map(summary => {
      const original = { summary, file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
      return { key: referralFindingKey(seat, original), seat, original, finding: normalizeFinding(original) };
    }) };
}

it.each([
  ['fixer', true, false], ['CI', false, true], ['fixer and CI', true, true],
])('reads mandatory referrals while %s runs', (_name, fixerRunning, inCi) => {
  const record = referralRecord();
  expect(validateReferralRecord(record)).toBe(true);
  const readComments = vi.fn(() => [comment(renderReferralRecord(record))]);
  const facts = read({ readComments,
    readJobs: () => fixerRunning ? [{ repo, pr: 1, kind: 'fix-run' }] : [],
    gh: () => JSON.stringify([pr({ statusCheckRollup: inCi
      ? [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] : [] })]),
  });
  expect(facts.fixerRunning).toBe(fixerRunning);
  expect(facts.inCi).toBe(inCi);
  expect(readComments).toHaveBeenCalledTimes(1);
  expect(readComments).toHaveBeenCalledWith(expect.objectContaining({ repo, number: 1, exec: expect.any(Function) }));
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: false, superseded: false }]);
  expect(facts.evidenceErrors).toEqual([]);
});

it('excludes superseded and dropped findings while retaining an active referral', () => {
  const record = referralRecord(['active', 'retired finding', 'dropped'], 'judgeAntigravityReview');
  const owner = referralRecord(['retired finding']);
  owner.runId = 'owner-review';
  owner.reviewer = mandatoryReferralReviewer(owner.runId);
  owner.rulings = [{ id: 'owner-ruling', key: owner.referrals[0].key, reviewerId: owner.reviewer.id,
    lens: owner.reviewer.lens, result: 'not-real', rationale: 'checked', evidence: ['diff'] }];
  record.superseded = [{ key: record.referrals[1].key, reason: REFERRAL_SUPERSEDE_REASON,
    by: { runId: owner.runId, key: owner.referrals[0].key, rulingId: 'owner-ruling' } }];
  record.dropped = [{ key: record.referrals[2].key, reason: REFERRAL_DROP_REASON }];
  expect(validateReferralRecord(record)).toBe(true);
  expect(validateReferralRecord(owner)).toBe(true);
  const facts = read({ readComments: () => [comment(renderReferralRecord(record)),
    { ...comment(renderReferralRecord(owner)), id: 'IC_owner' }] });
  expect(facts.evidenceErrors).toEqual([]);
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: false, superseded: false }]);
});

it('keeps an unbacked supersession open instead of silently retiring it', () => {
  const record = referralRecord();
  record.superseded = [{ key: record.referrals[0].key, reason: REFERRAL_SUPERSEDE_REASON,
    by: { runId: 'missing-run', key: 'missing-key', rulingId: 'missing-ruling' } }];
  expect(validateReferralRecord(record)).toBe(true);
  const facts = read({ readComments: () => [comment(renderReferralRecord(record))] });
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: false, superseded: false }]);
});

it('keeps a dropped finding with an existing block open', () => {
  const record = referralRecord(['blocked optional finding'], 'judgeAntigravityReview');
  record.dropped = [{ key: record.referrals[0].key, reason: REFERRAL_DROP_REASON }];
  record.rulings = [{ id: 'ruling-1', key: record.referrals[0].key, reviewerId: record.reviewer.id,
    lens: record.reviewer.lens, result: 'block', rationale: 'must repair', evidence: ['diff'] }];
  expect(validateReferralRecord(record)).toBe(true);
  const facts = read({ readComments: () => [comment(renderReferralRecord(record))] });
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: true, superseded: false }]);
});

it('remote card verification refuses additional GitHub reads and leaves the referral open', () => {
  const record = referralRecord();
  record.rulings = [{ id: 'ruling-1', key: record.referrals[0].key, reviewerId: record.reviewer.id,
    lens: record.reviewer.lens, result: 'card', rationale: 'filed', evidence: ['diff'],
    card: 'we:backlog/123-fixture.md@pr55' }];
  expect(validateReferralRecord(record)).toBe(true);
  const gh = vi.fn(() => JSON.stringify([pr()]));
  const facts = read({ gh, readComments: () => [comment(renderReferralRecord(record))] });
  expect(gh).toHaveBeenCalledTimes(2);
  expect(exec).not.toHaveBeenCalled();
  expect(runGhSync).not.toHaveBeenCalled();
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: true, superseded: false }]);
});

// Exercise the shared, real TSV comment reader, including the adapter's page loop.
const tsv = (body = 'ordinary comment') => `${body}\t${at}\tweb-everything\tIC_fixture\n`;
it('default transport issues only repository-scoped reads and preserves a referral on page two', () => {
  const record = referralRecord();
  const escaped = renderReferralRecord(record).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  runGhSync.mockImplementation(args => args[0] === 'pr' ? JSON.stringify(args[1] === 'list' ? [pr()] : pr())
    : args.includes('page=1') ? tsv().repeat(100) : tsv(escaped));
  const { gh: _gh, readComments: _comments, ...defaults } = options();
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs[0];
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: false, superseded: false }]);
  expect(facts.evidenceErrors).toEqual([]);
  expect(exec).not.toHaveBeenCalled();
  const calls = runGhSync.mock.calls;
  expect(calls).toHaveLength(4);
  expect(calls[0][0]).toEqual(expect.arrayContaining(['pr', 'list', '--repo', repo]));
  expect(calls[0][0][calls[0][0].indexOf('--repo') + 1]).toBe(repo);
  for (const [args, opts] of calls) {
    expect(opts).toMatchObject({ timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      throttle: { maxAttempts: 1, personalRoute: false } });
    if (args[0] === 'api') {
      // gh api takes an explicit repository endpoint; it has no --repo flag.
      expect(args).toEqual(expect.arrayContaining(['--method', 'GET', `repos/${repo}/issues/1/comments`]));
      expect(args).not.toContain('--paginate');
    } else expect(['list', 'view']).toContain(args[1]);
    expect(opts.env).not.toHaveProperty('GH_TOKEN');
    expect(opts.env).not.toHaveProperty('GITHUB_TOKEN');
  }
  expect(calls[1][0]).toEqual(expect.arrayContaining(['pr', 'view', '1']));
  expect(calls[1][0].at(-1).split(',')).toEqual(expect.arrayContaining(['headRefOid', 'files', 'body', 'commits', 'baseRefOid', 'statusCheckRollup']));
  expect(calls[2][0]).toContain('page=1');
  expect(calls[3][0]).toContain('page=2');
});

it('operatorGh strips both token variables and disables retries without modifying the parent environment', () => {
  vi.stubEnv('GH_TOKEN', 'fixture-gh-token');
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
  runGhSync.mockReturnValue('output');
  const args = ['pr', 'list', '--repo', repo];
  expect(operatorGh(args, { timeout: 123, env: { GH_TOKEN: 'override-token' }, throttle: { maxAttempts: 9 } })).toBe('output');
  const [actualArgs, opts] = runGhSync.mock.calls[0];
  expect(actualArgs).toEqual(args);
  expect(opts.env).not.toHaveProperty('GH_TOKEN');
  expect(opts.env).not.toHaveProperty('GITHUB_TOKEN');
  expect(opts.throttle).toEqual({ bin: '/opt/homebrew/bin/gh', personalRoute: false, maxAttempts: 1 });
  expect(opts.timeout).toBe(123);
  expect(process.env.GH_TOKEN).toBe('fixture-gh-token');
  expect(process.env.GITHUB_TOKEN).toBe('fixture-github-token');
});

it.each([125, 126])('each comment page consumes the 128-call budget (%i full pages)', fullPages => {
  let page = 0;
  const gh = vi.fn(args => {
    if (args[0] === 'pr') return JSON.stringify([pr()]);
    page++;
    return page <= fullPages ? tsv().repeat(100) : '';
  });
  const { readComments: _comments, ...defaults } = options({ gh });
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs[0];
  expect(gh).toHaveBeenCalledTimes(128);
  expect(page).toBe(126);
  expect(facts.openReferrals).toEqual(fullPages === 125 ? [] : null);
  expect(facts.evidenceErrors).toEqual(fullPages === 125 ? [] : ['comment evidence unreadable or budget exhausted']);
});

it('shares the call budget across PRs and withholds unread comments after exhaustion', () => {
  const listing = Array.from({ length: 129 }, (_, i) => pr({ number: i + 1 }));
  const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify(listing) : '');
  const findSuspendedRuns = vi.fn(() => []);
  const { readComments: _comments, ...defaults } = options({ gh, findSuspendedRuns });
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs;
  expect(findSuspendedRuns).toHaveBeenCalledTimes(129);
  expect(gh).toHaveBeenCalledTimes(128);
  expect(facts[62].openReferrals).toEqual([]);
  expect(facts[63]).toMatchObject({ detail: 'read', openReferrals: null,
    evidenceErrors: ['comment evidence unreadable or budget exhausted'] });
  expect(buildJudgeSweepBundle({ prs: [facts[63]] }).prs[0].needsJudgment).toBe(true);
  expect(facts.slice(64).every(p => p.openReferrals === null && p.detail === 'error')).toBe(true);
  expect(facts[128].evidenceErrors.join(' ')).toMatch(/detail/);
});

it.each([199, 200, 201])('refuses a potentially truncated listing at the 200-PR limit (received %i)', count => {
  const readComments = vi.fn(() => []);
  const reader = createJudgeSweepFactsReader(options({ readComments,
    gh: () => JSON.stringify(Array.from({ length: count }, (_, i) => pr({ number: i + 1 }))),
  }));
  if (count < 200) expect(reader({ repo }).prs).toHaveLength(count);
  else {
    expect(() => reader({ repo })).toThrow(/listing incomplete.*exhaustive operator listing/);
    expect(readComments).not.toHaveBeenCalled();
  }
});

const humanPr = extra => pr({ labels: [{ name: 'review:human' }], files: [{ path: 'README.md' }], changedFiles: 1, ...extra });
it.each([
  ['narrow', 'broad', false, true],
  ['broad', 'narrow', true, false],
  ['workflow', 'workflow,statute', false, true],
])('invalidates serialized and in-memory shape results when policy changes from %s to %s', (before, after, initial, expected) => {
  let disk = '{}';
  const io = { read: () => disk, write: (_path, data) => { disk = data; } };
  const changedFiles = ['docs/agent/platform-decisions.md'];
  const shape = vi.fn(files => buildShapePlan({ changedFiles: files }));
  const readerOptions = options({ shape,
    gh: () => JSON.stringify([humanPr({ files: changedFiles.map(path => ({ path })) })]),
  });
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', before);
  const reader = createJudgeSweepFactsReader({ findSuspendedRuns: () => [], ...readerOptions, cache: createShapeCache(io) });
  expect(reader({ repo }).prs[0].humanRequired).toBe(initial);
  expect(reader({ repo }).prs[0].humanRequired).toBe(initial);
  expect(shape).toHaveBeenCalledTimes(1);
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', after);
  expect(buildShapePlan({ changedFiles }).humanRequired).toBe(expected);
  const fresh = createJudgeSweepFactsReader({ findSuspendedRuns: () => [], ...readerOptions, cache: createShapeCache(io) });
  const facts = fresh({ repo }).prs[0];
  expect(facts.evidenceErrors).toEqual([]);
  expect(facts.humanRequired).toBe(expected);
  expect(reader({ repo }).prs[0].humanRequired).toBe(expected);
  expect(shape).toHaveBeenCalledTimes(3);
  const reloaded = createJudgeSweepFactsReader({ findSuspendedRuns: () => [], ...readerOptions, cache: createShapeCache(io) });
  expect(reloaded({ repo }).prs[0].humanRequired).toBe(expected);
  expect(shape).toHaveBeenCalledTimes(3);
});

it.each(['base', 'head'])('recomputes shape when only the %s changes and reuses an identical identity', changed => {
  let current = humanPr();
  const shape = vi.fn().mockReturnValueOnce({ humanRequired: false }).mockReturnValueOnce({ humanRequired: true });
  const reader = createJudgeSweepFactsReader(options({ gh: () => JSON.stringify([current]), shape }));
  expect(reader({ repo }).prs[0].humanRequired).toBe(false);
  expect(reader({ repo }).prs[0].humanRequired).toBe(false);
  current = { ...current, [changed === 'head' ? 'headRefOid' : 'baseRefOid']: 'c'.repeat(40) };
  expect(reader({ repo }).prs[0].humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledTimes(2);
});

it('reuses equivalent effective policies across presets, reordered categories, and cascade sources', () => {
  let disk = '{}';
  const io = { read: () => disk, write: (_path, data) => { disk = data; } };
  const shape = vi.fn(() => ({ humanRequired: false }));
  const evaluate = () => read({ cache: createShapeCache(io), shape,
    gh: () => JSON.stringify([humanPr()]) });
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', 'narrow');
  expect(evaluate().humanRequired).toBe(false);
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', ' secrets, identity, permission, protection, workflow,workflow ');
  expect(evaluate().humanRequired).toBe(false);
  expect(shape).toHaveBeenCalledTimes(1);
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', undefined);
  expect(evaluate().humanRequired).toBe(false);
  const calls = shape.mock.calls.length;
  vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', resolveHumanReviewSurfaces().categories.join(','));
  expect(evaluate().humanRequired).toBe(false);
  expect(shape).toHaveBeenCalledTimes(calls);
});

it('rejects a policy-free head-and-base entry in a current rules envelope', () => {
  const key = `${repo}:${head}:${'b'.repeat(40)}`;
  const cache = createShapeCache({
    read: () => JSON.stringify({ rulesVersion: 1, entries: { [key]: false } }), write: () => {},
  });
  expect(cache.get(key)).toBeUndefined();
  const shape = vi.fn(() => ({ humanRequired: true }));
  expect(read({ cache, shape, gh: () => JSON.stringify([humanPr()]) }).humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledTimes(1);
});

it('normalizes head and base SHA case consistently before cache lookup', () => {
  let current = humanPr();
  const shape = vi.fn(() => ({ humanRequired: false }));
  const reader = createJudgeSweepFactsReader(options({ gh: () => JSON.stringify([current]), shape }));
  expect(reader({ repo }).prs[0].humanRequired).toBe(false);
  current = { ...current, headRefOid: head.toUpperCase(), baseRefOid: current.baseRefOid.toUpperCase() };
  expect(reader({ repo }).prs[0].humanRequired).toBe(false);
  expect(shape).toHaveBeenCalledTimes(1);
});

it.each([undefined, '', 'unknown', 'b'.repeat(39)])('withholds shape when base identity is missing or unreadable (%s)', baseRefOid => {
  const cache = { get: vi.fn(() => false), set: vi.fn() }, shape = vi.fn(() => ({ humanRequired: false }));
  const facts = read({ cache, shape, gh: () => JSON.stringify([humanPr({ baseRefOid })]) });
  expect(facts.humanRequired).toBeNull();
  expect(facts.evidenceErrors).toContain('shape unavailable; inspect full diff before delegating');
  expect(cache.get).not.toHaveBeenCalled();
  expect(shape).not.toHaveBeenCalled();
});

it('ignores legacy head-only cache entries and recomputes a permissive result', () => {
  const cache = createShapeCache({ read: () => JSON.stringify({ [`${repo}:${head}`]: false }), write: () => {} });
  const shape = vi.fn(() => ({ humanRequired: true }));
  const facts = read({ cache, shape, gh: () => JSON.stringify([humanPr()]) });
  expect(facts.humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledTimes(1);
  expect(shape).toHaveBeenCalledWith(['README.md'], resolveHumanReviewSurfaces());
});

it('a shape-rules version bump invalidates a cached non-human result in a fresh reader', () => {
  let disk = '{}';
  const io = { read: () => disk, write: (_path, data) => { disk = data; } };
  const old = createShapeCache({ ...io, rulesVersion: 1 });
  const key = `${repo}:${head}:${'b'.repeat(40)}:${policyHash()}`;
  old.set(key, false);
  expect(createShapeCache({ ...io, rulesVersion: 1 }).get(key)).toBe(false);
  const shape = vi.fn(() => ({ humanRequired: true }));
  const facts = read({ cache: createShapeCache({ ...io, rulesVersion: 2 }), shape,
    gh: () => JSON.stringify([humanPr()]) });
  expect(facts.humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledTimes(1);
  expect(shape).toHaveBeenCalledWith(['README.md'], resolveHumanReviewSurfaces());
  expect(createShapeCache({ ...io, rulesVersion: 2 }).get(key)).toBe(true);
  expect(createShapeCache({ ...io, rulesVersion: 1 }).get(key)).toBeUndefined();
});

it('cache retains at most 256 entries on both load and write, evicting the oldest entry', () => {
  const keys = Array.from({ length: 257 }, (_, i) => `${repo}:${i.toString(16).padStart(40, '0')}:${head}:${policyHash()}`);
  let disk = JSON.stringify({ rulesVersion: 1, entries: Object.fromEntries(keys.map(key => [key, false])) });
  const io = { read: () => disk, write: (_path, data) => { disk = data; } };
  const cache = createShapeCache(io);
  expect(cache.get(keys[0])).toBeUndefined();
  expect(cache.get(keys[1])).toBe(false);
  cache.set(keys[1], true); // Rewriting refreshes insertion order.
  cache.set(keys[0], true);
  expect(cache.get(keys[2])).toBeUndefined();
  const saved = JSON.parse(disk).entries;
  expect(Object.keys(saved)).toHaveLength(256);
  expect(saved[keys[0]]).toBe(true);
  expect(saved[keys[1]]).toBe(true);
  const fresh = createShapeCache(io);
  expect(fresh.get(keys[2])).toBeUndefined();
  expect(fresh.get(keys[0])).toBe(true);
});

it('ignores unversioned head-and-base cache entries after upgrading the cache format', () => {
  const key = `${repo}:${head}:${'b'.repeat(40)}`;
  const cache = createShapeCache({ read: () => JSON.stringify({ [key]: false }), write: () => {} });
  const shape = vi.fn(() => ({ humanRequired: true }));
  expect(read({ cache, shape, gh: () => JSON.stringify([humanPr()]) }).humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledTimes(1);
});

it('rejects a legacy head-only entry even inside the current version envelope', () => {
  const cache = createShapeCache({
    read: () => JSON.stringify({ rulesVersion: 1, entries: { [`${repo}:${head}`]: false } }), write: () => {},
  });
  expect(cache.get(`${repo}:${head}`)).toBeUndefined();
});

it.each(['null', '[]', '{', '{"rulesVersion":1,"entries":null}', '{"rulesVersion":1,"entries":[]}'])
('treats an unreadable cache envelope as a miss and replaces it (%s)', contents => {
  let disk = contents;
  const key = `${repo}:${head}:${'b'.repeat(40)}:${policyHash()}`;
  const cache = createShapeCache({ read: () => disk, write: (_path, data) => { disk = data; } });
  expect(cache.get(key)).toBeUndefined();
  cache.set(key, true);
  expect(JSON.parse(disk)).toEqual({ rulesVersion: 1, entries: { [key]: true } });
});

it('shape child receives filenames unchanged as JSON stdin with bounded output and runtime', () => {
  const files = ['with,comma.md', 'with space.md', 'with\ttab.md', 'with\nnewline.md', 'with\rreturn.md',
    'with\u2028separator.md', '`backtick`.md', "quote'\".md", '$(shell).md', '--leading.md',
    '../parent.md', 'invisible\u200b.md', 'ｆullwidth.md', 'back\\slash.md'];
  exec.mockReturnValue('{"humanRequired":true}');
  const facts = read({ gh: () => JSON.stringify([humanPr({ files: files.map(path => ({ path })), changedFiles: files.length })]) });
  expect(facts.humanRequired).toBe(true);
  expect(exec).toHaveBeenCalledTimes(1);
  const [bin, args, opts] = exec.mock.calls[0];
  expect(bin).toBe(process.execPath);
  expect(args).toEqual([expect.stringMatching(/scripts\/review-core-cli\.mjs$/), 'shape', '--json']);
  expect(JSON.parse(opts.input)).toEqual(files);
  expect(opts).toMatchObject({ encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  expect(opts.env.WE_HUMAN_REVIEW_SURFACES).toBe(resolveHumanReviewSurfaces().categories.join(','));
});

// A verdict row in the ledger at the PR head is real evidence even before its advisory comment is published.
const ledgerRow = (extra = {}) => ({ type: 'verdict', repo, pr: 1, verdict: 'changes', at, coverage: { headSha: head }, ...extra });
const ledgerFacts = (rows, labels = [{ name: 'review:pending' }]) => read({
  gh: () => JSON.stringify([pr({ labels })]), readLedgerRows: () => [...rounds(1, 3), ...rows] });

it('takes the verdict from a ledger row at the PR head when no advisory comment exists', () => {
  const facts = ledgerFacts([ledgerRow()]);
  expect(facts.latestVerdict).toMatchObject({ accepted: false, findings: null, evidence: 'ledger' });
  expect(facts.evidenceErrors).toEqual([]);
});

it('takes an accepting ledger verdict at the PR head as accepted', () => {
  const facts = ledgerFacts([ledgerRow({ verdict: 'accepted' })]);
  expect(facts.latestVerdict).toMatchObject({ accepted: true, evidence: 'ledger' });
  expect(facts.evidenceErrors).toEqual([]);
});

it('fails closed when the ledger row head differs from the PR head', () => {
  const facts = ledgerFacts([ledgerRow({ coverage: { headSha: 'c'.repeat(40) } })], [{ name: 'review:accepted' }]);
  expect(facts.latestVerdict).toBeNull();
  expect(facts.evidenceErrors).toContain('accepted label lacks live verdict evidence');
});

it.each([
  ['missing verdict', { verdict: undefined }],
  ['non-string verdict', { verdict: 7 }],
  ['unparseable time', { at: 'not-a-time' }],
  ['malformed head', { coverage: { headSha: head.slice(0, 7) } }],
])('fails closed on a malformed ledger row (%s)', (_name, extra) => {
  const facts = ledgerFacts([ledgerRow(extra)]);
  expect(facts.latestVerdict).toBeNull();
});

it('flags a ledger row that names the PR head but is malformed as unreadable evidence', () => {
  const facts = ledgerFacts([ledgerRow({ verdict: 7 })]);
  expect(facts.evidenceErrors).toContain('verdict ledger row malformed');
});

// Evidence must never depend on how stale the caller's checkout is (R372).

const goodPr = { number: 7, headSha: head, labels: [], evidenceErrors: [], minutesSinceUpdate: 5 };
const freshFacts = { generatedAt: at, prs: [goodPr] };
const staleOptions = extra => options({ gh: vi.fn(() => { throw new Error('stale checkout must not read locally'); }), ...extra });

it('reads facts from a fresh origin/main when the checkout is behind', () => {
  const readFresh = vi.fn(() => freshFacts);
  const reader = createJudgeSweepFactsReader(staleOptions({ checkoutState: () => ({ behind: 1232 }), readFresh }));
  expect(reader({ repo })).toEqual(freshFacts);
  expect(readFresh).toHaveBeenCalledWith(expect.objectContaining({ repo, behind: 1232 }));
});

it('reads in place and never builds a fresh checkout when the checkout is current', () => {
  const readFresh = vi.fn();
  expect(createJudgeSweepFactsReader(options({ readFresh }))({ repo }).prs).toHaveLength(1);
  expect(readFresh).not.toHaveBeenCalled();
});

it('refuses loudly with checkout-stale (N behind) when the fresh read fails, with no local fallback', () => {
  const readFresh = vi.fn(() => { throw new Error('worktree add failed'); });
  const reader = createJudgeSweepFactsReader(staleOptions({ checkoutState: () => ({ behind: 1232 }), readFresh }));
  expect(() => reader({ repo })).toThrow(/checkout-stale \(1232 behind\)/);
});

it.each([null, {}, { prs: 'x' }, []])('refuses a malformed fresh read (%j) as checkout-stale', bad => {
  const reader = createJudgeSweepFactsReader(staleOptions({ checkoutState: () => ({ behind: 3 }), readFresh: () => bad }));
  expect(() => reader({ repo })).toThrow(/checkout-stale \(3 behind\)/);
});

it.each([() => { throw new Error('fetch failed'); }, () => ({ behind: -1 }), () => ({ behind: Number.NaN }), () => null])(
  'refuses when freshness cannot be proven, without reading locally', checkoutState => {
    const gh = vi.fn();
    const reader = createJudgeSweepFactsReader(options({ gh, checkoutState, readFresh: () => freshFacts }));
    expect(() => reader({ repo })).toThrow(/checkout-stale \(unknown behind\)/);
    expect(gh).not.toHaveBeenCalled();
  });

it('does not trust an inherited env flag: freshness is still checked and fails closed', () => {
  vi.stubEnv('WE_JUDGE_FACTS_FRESH_CHILD', '1');
  const gh = vi.fn();
  const reader = createJudgeSweepFactsReader(options({ gh, checkoutState: () => { throw new Error('fetch failed'); } }));
  expect(() => reader({ repo })).toThrow(/checkout-stale \(unknown behind\)/);
  expect(gh).not.toHaveBeenCalled();
});

it.each([
  ['an empty prs list shape is allowed', [], true],
  ['a PR with no fields', [{}], false],
  ['a non-numeric PR number', [{ ...goodPr, number: '7' }], false],
  ['a malformed head', [{ ...goodPr, headSha: 'abc' }], false],
  ['missing evidenceErrors', [{ ...goodPr, evidenceErrors: undefined }], false],
  ['non-array labels', [{ ...goodPr, labels: 'x' }], false],
  ['a non-finite age', [{ ...goodPr, minutesSinceUpdate: null }], false],
  ['a valid PR', [goodPr], true],
])('validates the fresh PR shape: %s', (_name, prs, ok) => {
  const reader = createJudgeSweepFactsReader(staleOptions({ checkoutState: () => ({ behind: 2 }),
    readFresh: () => ({ generatedAt: at, prs }) }));
  if (ok) expect(reader({ repo }).prs).toEqual(prs);
  else expect(() => reader({ repo })).toThrow(/checkout-stale \(2 behind\)/);
});

// Real git and a real child process: only the stub module the child imports is a fixture.
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function gitFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'jsf-real-'));
  const origin = join(tmp, 'origin'), clone = join(tmp, 'clone');
  mkdirSync(join(origin, 'scripts/operations'), { recursive: true });
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 'a@b.c'); git(origin, 'config', 'user.name', 'x');
  writeFileSync(join(origin, 'scripts/operations/judge-sweep-facts-io.mjs'),
    "import { existsSync } from 'node:fs';\nexport const createJudgeSweepFactsReader = o => () => ({ generatedAt: 't', source: 'fresh', behind: o.checkoutState().behind,\n  deps: existsSync('node_modules'), prs: [] });\n");
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'one');
  execFileSync('git', ['clone', '-q', origin, clone]);
  mkdirSync(join(clone, 'node_modules'));
  return { tmp, origin, clone, advance: () => { writeFileSync(join(origin, 'n.txt'), String(Math.random()));
    git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'more'); } };
}

it('counts commits behind origin/main with real git', () => {
  const f = gitFixture();
  try {
    expect(readCheckoutState({ root: f.clone })).toEqual({ behind: 0 });
    f.advance(); f.advance();
    expect(readCheckoutState({ root: f.clone })).toEqual({ behind: 2 });
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

it.each(['', '  ', 'abc', '-1', '1.5'])('treats a non-numeric count (%j) as unknown, never as 0 behind', out => {
  const run = (_bin, args) => (args.includes('rev-list') ? out : '');
  expect(() => readCheckoutState({ root: '/x', exec: run })).toThrow();
});

it('fails closed when the fetch fails', () => {
  const f = gitFixture();
  try {
    git(f.clone, 'remote', 'set-url', 'origin', join(f.tmp, 'missing'));
    expect(() => readCheckoutState({ root: f.clone })).toThrow();
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

it('reads from a real origin/main worktree, links dependencies, and leaves no worktree behind', () => {
  const f = gitFixture();
  try {
    f.advance(); git(f.clone, 'fetch', '-q', 'origin', 'main');
    const facts = readFromFreshOrigin({ repo, root: f.clone });
    expect(facts).toMatchObject({ source: 'fresh', behind: 0, deps: true });
    expect(git(f.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

it('cleans up the worktree registration and temp dir when the fresh child fails', () => {
  const f = gitFixture();
  try {
    // Preserve the child's named import so the fixture reaches the intended runtime failure.
    writeFileSync(join(f.origin, 'scripts/operations/judge-sweep-facts-io.mjs'),
      'export const createJudgeSweepFactsReader = () => { throw new Error("child boom"); };\n');
    git(f.origin, 'commit', '-qam', 'break'); git(f.clone, 'fetch', '-q', 'origin', 'main');
    const before = readdirSync(tmpdir()).filter(n => n.startsWith('judge-facts-fresh-')).length;
    expect(() => readFromFreshOrigin({ repo, root: f.clone })).toThrow(/fresh reader failed.*child boom/s);
    expect(git(f.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(readdirSync(tmpdir()).filter(n => n.startsWith('judge-facts-fresh-')).length).toBe(before);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

it('prunes the registration even when git cannot remove the worktree', () => {
  const f = gitFixture();
  try {
    f.advance(); git(f.clone, 'fetch', '-q', 'origin', 'main');
    const calls = [];
    const flaky = (bin, args, opts) => {
      if (bin === 'git') calls.push(args.filter(a => ['remove', 'prune', 'add'].includes(a))[0]);
      if (bin === 'git' && args.includes('remove')) throw new Error('remove failed');
      return execFileSync(bin, args, opts);
    };
    readFromFreshOrigin({ repo, root: f.clone, exec: flaky });
    expect(git(f.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(calls.filter(Boolean)).toEqual(['add', 'remove', 'prune']);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

it('fails closed when neither remove nor prune can clear the worktree registration', () => {
  const f = gitFixture();
  try {
    f.advance(); git(f.clone, 'fetch', '-q', 'origin', 'main');
    const broken = (bin, args, opts) => {
      if (bin === 'git' && (args.includes('remove') || args.includes('prune'))) throw new Error('git refused');
      return execFileSync(bin, args, opts);
    };
    expect(() => readFromFreshOrigin({ repo, root: f.clone, exec: broken })).toThrow(/worktree cleanup failed/);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});


it('R746 exposes a suspended run and alerts once per run past the sourced window without PR mutations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referral-alert-'));
  try {
    const publishAlert = vi.fn(), log = vi.fn(), alertRepo = JUDGE_SWEEP_REPO;
    const suspended = { id: 'review-pr-suspended', ageMs: 3600000, findings: [{ key: 'k', summary: 'broken guard' }] };
    const reader = createJudgeSweepFactsReader(options({ findSuspendedRuns: () => [suspended], publishAlert,
      readLedgerRows: () => rounds(1, 3).map(row => ({ ...row, repo: alertRepo })),
      alertClaimsDir: dir, log, env: { WE_REFERRAL_JUDGE_WINDOW_MIN: '60' } }));
    const first = reader({ repo: alertRepo }).prs[0];
    expect(first.suspendedReferralRun).toEqual({ runId: suspended.id, ageMinutes: 60, findings: suspended.findings });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0]).toMatchObject({ repo: alertRepo, pr: 1, head, kind: 'suspended-referral-no-ruling', pick: `https://github.com/${alertRepo}/pull/1`, reason: expect.stringContaining(suspended.id) });
    expect(log.mock.calls.flat().join(' ')).toMatch(/60.*source=env/);
    expect(reader({ repo: alertRepo }).prs[0]).toEqual(first);
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(first.labels).toEqual([]); expect(first.latestVerdict).toBeNull();
    suspended.id = 'review-pr-next'; suspended.ageMs = 59 * 60000;
    reader({ repo: alertRepo }); expect(publishAlert).toHaveBeenCalledTimes(1);
    suspended.ageMs = 60 * 60000; reader({ repo: alertRepo }); expect(publishAlert).toHaveBeenCalledTimes(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('R746 fails closed on unreadable suspended-run evidence', () => {
  expect(read({ findSuspendedRuns: () => { throw Error('bad'); } }).evidenceErrors)
    .toContain('suspended referral run evidence unreadable; inspect run store');
});

it('R746 does not alert when all suspended findings have recorded rulings', () => {
  const record = referralRecord(['ruled guard']);
  record.rulings = [{ id: 'ruling-1', key: record.referrals[0].key, reviewerId: record.reviewer.id,
    lens: record.reviewer.lens, result: 'block', rationale: 'repair it', evidence: ['diff'] }];
  const publishAlert = vi.fn();
  const row = read({ readComments: () => [comment(renderReferralRecord(record))], publishAlert,
    findSuspendedRuns: () => [{ id: 'review-pr-ruled', ageMs: 7200000,
      findings: [{ key: record.referrals[0].key, summary: 'ruled guard' }] }] });
  expect(row.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: true, superseded: false }]);
  expect(row.evidenceErrors).toEqual([]); expect(publishAlert).not.toHaveBeenCalled();
});
it('R746 never publishes or writes alert claims in tests without an injected publisher', () => {
  const exec = vi.fn();
  const row = read({ exec, alertClaimsDir: 'invalid-unwritable-claim-location',
    findSuspendedRuns: () => [{ id: 'review-pr-unruled', ageMs: 7200000, findings: [{ key: 'k', summary: 'guard' }] }] });
  expect(row.evidenceErrors).toEqual([]); expect(exec).not.toHaveBeenCalled();
});


it('list query stays slim: no files/body/statusCheckRollup in the 200-PR list', () => {
  const gh = vi.fn(() => '[]');
  createJudgeSweepFactsReader(options({ gh }))({ repo });
  const fields = gh.mock.calls[0][0].at(-1).split(',');
  for (const field of ['files', 'body', 'statusCheckRollup', 'changedFiles', 'baseRefOid', 'author', 'commits']) {
    expect(fields).not.toContain(field);
  }
  expect(fields.filter(f => f === 'updatedAt')).toHaveLength(1);
});

const rounds = (number, round) => Array.from({ length: round - 1 }, (_, i) => ({
  repo, pr: number, type: 'review-run', headSha: (i + 1).toString(16).padStart(40, '0'), at,
}));
const selectiveReader = ({ listing = [pr()], rows = [], detail = p => p, ...extra } = {}) => {
  const gh = vi.fn(args => {
    if (args[1] === 'list') return JSON.stringify(listing);
    if (args[1] === 'view') return JSON.stringify(detail(listing.find(p => p.number === Number(args[2]))));
    return '';
  });
  const reader = createJudgeSweepFactsReader({ ...options(), baseCap: 12, gh, readComments: undefined,
    readLedgerRows: () => rows, ...extra });
  return { gh, read: () => reader({ repo }) };
};

it('bounds 199 PRs including independent comments for PRs below cap-near', () => {
  const listing = Array.from({ length: 199 }, (_, i) => pr({ number: i + 1 }));
  const f = selectiveReader({ listing, rows: [1, 2, 3].flatMap(n => rounds(n, 10)) });
  const facts = f.read();
  expect(f.gh).toHaveBeenCalledTimes(128);
  expect(f.gh.mock.calls.filter(([a]) => a[1] === 'view').map(([a]) => Number(a[2]))).toEqual([1, 2, 3]);
  expect(f.gh.mock.calls.filter(([a]) => a[0] === 'api')).toHaveLength(124);
  expect(facts.prs[123].openReferrals).toEqual([]);
  expect(facts.prs.slice(124).every(p => p.openReferrals === null
    && p.evidenceErrors.includes('comment evidence unreadable or budget exhausted'))).toBe(true);
  expect(facts.prs.slice(3).every(p => p.detail === 'skipped' && p.inCi === null && p.evidenceErrors.length)).toBe(true);
});

it.each([9, 10, 11, 12, null])('selects detail at cap minus two or unknown round (round=%s)', round => {
  const f = selectiveReader({ rows: round === null ? [] : rounds(1, round),
    ...(round === null ? { readLedgerRows: () => { throw Error('unreadable'); } } : {}) });
  const row = f.read().prs[0];
  expect(row.round).toBe(round);
  expect(f.gh.mock.calls.filter(([a]) => a[1] === 'view')).toHaveLength(round === 9 ? 0 : 1);
});

it('skipped detail never counts as clear even with accepted labels and active CI or a fixer', () => {
  const f = selectiveReader({ listing: [pr({ labels: [{ name: 'review:accepted' }],
    statusCheckRollup: [{ status: 'IN_PROGRESS' }] })], readJobs: () => [{ repo, pr: 1, kind: 'fix-run' }] });
  const facts = f.read();
  expect(facts.prs[0]).toMatchObject({ detail: 'skipped', inCi: null, latestVerdict: null });
  expect(buildJudgeSweepBundle(facts).prs[0]).toMatchObject({ needsJudgment: true, reason: expect.stringContaining('evidence-unavailable') });
  expect(f.gh).toHaveBeenCalledTimes(2);
});

it.each(['504', 'invalid JSON', 'head mismatch', 'missing head'])('isolates per-PR detail failure (%s) and never caches or clears it', kind => {
  const cache = { get: vi.fn(), set: vi.fn() }, shape = vi.fn();
  const f = selectiveReader({ listing: [pr({ labels: [{ name: 'review:human' }] }), pr({ number: 2 })],
    rows: [1, 2].flatMap(n => rounds(n, 10)), cache, shape,
    detail: p => {
      if (p.number === 2) return p;
      if (kind === '504') throw Error('HTTP 504');
      if (kind === 'invalid JSON') return undefined;
      return { ...p, headRefOid: kind === 'missing head' ? undefined : 'c'.repeat(40) };
    } });
  const facts = f.read();
  expect(facts.prs[0]).toMatchObject({ detail: 'error', inCi: null, humanRequired: null });
  expect(facts.prs[0].evidenceErrors.join(' ')).toMatch(/detail/);
  expect(buildJudgeSweepBundle(facts).prs[0].needsJudgment).toBe(true);
  expect(facts.prs[1].evidenceErrors).toEqual([]);
  expect(facts.prs[1].detail).toBe('read');
  expect(cache.set).not.toHaveBeenCalled();
  expect(shape).not.toHaveBeenCalled();
  expect(f.gh.mock.calls.filter(([a]) => a[0] === 'api')).toHaveLength(2);
});

it('a round-limit label with unreadable ledger still reads detail', () => {
  const f = selectiveReader({ listing: [pr({ labels: [{ name: 'status:at-round-limit' }] })],
    readLedgerRows: () => { throw Error('unreadable'); } });
  expect(f.read().prs[0].detail).toBe('read');
  expect(f.gh.mock.calls.filter(([a]) => a[1] === 'view')).toHaveLength(1);
});

it('does not count the current head or another PR or repo as previous rounds', () => {
  const f = selectiveReader({ rows: [...rounds(1, 10).map(r => ({ ...r, headSha: head })),
    ...rounds(2, 12), ...rounds(1, 12).map(r => ({ ...r, repo: 'other/repo' }))] });
  expect(f.read().prs[0]).toMatchObject({ round: 1, detail: 'skipped' });
  expect(f.gh).toHaveBeenCalledTimes(2);
});


it.each([
  ['body', undefined], ['body', null], ['createdAt', 'invalid'],
  ['statusCheckRollup', undefined], ['statusCheckRollup', null], ['commits', undefined],
])('fails closed on incomplete detail %s=%s while still reading comments', (field, value) => {
  const f = selectiveReader({ rows: rounds(1, 10), detail: p => ({ ...p, [field]: value }) });
  const facts = f.read();
  expect(facts.prs[0]).toMatchObject({ detail: 'error', inCi: null });
  expect(buildJudgeSweepBundle(facts).prs[0].needsJudgment).toBe(true);
  expect(f.gh.mock.calls.filter(([args]) => args[0] === 'api')).toHaveLength(1);
});


it.each([
  { oid: 'b'.repeat(40), committedDate: at },
  { committedDate: at },
])('withholds head age when the last commit does not identify the listed head (%j)', lastCommit => {
  const facts = read({ gh: () => JSON.stringify([pr({ commits: [{ oid: head, committedDate: at }, lastCommit] })]) });
  expect(facts.minutesSinceHeadChange).toBeNull();
  expect(facts.evidenceErrors).toContain('last commit does not identify the listed head');
  expect(buildJudgeSweepBundle({ prs: [facts] }).prs[0].needsJudgment).toBe(true);
});

it.each([[{}], [{ name: 'test', status: 'COMPLETED' }], [null],
  [{ name: 'test', status: 'IN_PROGRESS' }, {}]].map(rollup => [rollup]))('withholds CI state on unreadable checks (%j)', statusCheckRollup => {
  const facts = read({ gh: () => JSON.stringify([pr({ statusCheckRollup })]) });
  expect(facts.inCi).toBeNull();
  expect(facts.evidenceErrors).toContain('status check evidence unreadable');
  expect(buildJudgeSweepBundle({ prs: [facts] }).prs[0].needsJudgment).toBe(true);
});

it.each([
  [1, false], [2, false], [3, true], [5, true],
].flatMap(([round, failDetail]) => [false, true].map(ruled => [round, failDetail, ruled])))('verifies comments and alerts for overdue suspended runs at cap 5 round %i (detail fails=%s, ruled=%s)', (round, failDetail, ruled) => {
  const dir = mkdtempSync(join(tmpdir(), 'referral-alert-independent-'));
  try {
    const record = { ...referralRecord(), repo: JUDGE_SWEEP_REPO }, publishAlert = vi.fn();
    if (ruled) record.rulings = [{ id: 'ruling-independent', key: record.referrals[0].key,
      reviewerId: record.reviewer.id, lens: record.reviewer.lens, result: 'block', rationale: 'repair it', evidence: ['diff'] }];
    const readComments = vi.fn(() => [comment(renderReferralRecord(record))]);
    const findSuspendedRuns = vi.fn(() => [{ id: 'review-pr-independent', ageMs: 7200000,
      findings: [{ key: record.referrals[0].key, summary: 'guard' }] }]);
    const gh = vi.fn(args => {
      if (args[1] === 'view') throw Error('detail unavailable');
      // The listing intentionally has no body or creation time.
      const { body, createdAt, ...listing } = pr();
      return JSON.stringify([listing]);
    });
    const facts = createJudgeSweepFactsReader(options({ gh,
      readLedgerRows: () => rounds(1, round).map(row => ({ ...row, repo: JUDGE_SWEEP_REPO })), readComments,
      findSuspendedRuns, publishAlert, alertClaimsDir: dir, log: () => {},
      env: { WE_REFERRAL_JUDGE_WINDOW_MIN: '60' } }))({ repo: JUDGE_SWEEP_REPO }).prs[0];
    expect(facts).toMatchObject({ round, cap: 5, detail: failDetail ? 'error' : 'skipped',
      openReferrals: [{ key: record.referrals[0].key, ruled, superseded: false }],
      suspendedReferralRun: { runId: 'review-pr-independent' } });
    expect(readComments).toHaveBeenCalledTimes(1);
    expect(findSuspendedRuns).toHaveBeenCalledTimes(1);
    expect(publishAlert).toHaveBeenCalledTimes(ruled ? 0 : 1);
    expect(gh).toHaveBeenCalledTimes(failDetail ? 2 : 1);
    expect(buildJudgeSweepBundle({ prs: [facts] }).prs[0].needsJudgment).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
