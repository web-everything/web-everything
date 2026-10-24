/** Bounded observations must expose grants that need evidence beyond list + comments. */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { runGhSync } from '../../lib/gh-throttle.mjs';
import { createJudgeSweepFactsReader, createShapeCache, operatorGh } from '../judge-sweep-facts-io.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord,
  REFERRAL_DROP_REASON, REFERRAL_SUPERSEDE_REASON, validateReferralRecord } from '../../lib/jury-core.mjs';

vi.mock('node:child_process', async original => ({ ...await original(), execFileSync: vi.fn() }));
vi.mock('../../lib/gh-throttle.mjs', async original => ({ ...await original(), runGhSync: vi.fn() }));

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

const repo = 'o/r', head = 'a'.repeat(40), at = '2026-10-22T13:00:00Z';
const baseCap = 12;

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
  const reader = createJudgeSweepFactsReader({
    gh: args => {
      calls.push(args);
      if (args[0] !== 'pr' || args[1] !== 'list') throw new Error('unexpected extra GitHub read');
      return JSON.stringify([{ number: 1, title: 'scope fixture', headRefOid: head,
        labels: [], assignees: [], updatedAt: at }]);
    },
    now: () => Date.parse(at), baseCap,
    readLedgerRows: () => [], readFixRows: () => [], readJobs: () => [],
    readComments: () => comments,
  });
  const facts = reader({ repo }).prs[0];
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(expect.arrayContaining(['--repo', repo]));
  expect(facts.cap).toBe(cap);
  expect(facts.evidenceErrors).toEqual(incomplete
    ? ['standing ruling unverified; inspect ruling and grant scope before judging'] : []);
});

const pr = (extra = {}) => ({ number: 1, title: 'IO fixture', headRefOid: head,
  baseRefOid: 'b'.repeat(40), labels: [], assignees: [], updatedAt: at,
  body: '<!-- authored-by-actor: author -->', createdAt: at, ...extra });
const options = (extra = {}) => ({
  gh: () => JSON.stringify([pr()]), now: () => Date.parse(at), baseCap,
  readLedgerRows: () => [], readFixRows: () => [], readJobs: () => [], readComments: () => [],
  cache: createShapeCache({ read: () => '{}', write: () => {} }), ...extra,
});
const read = extra => createJudgeSweepFactsReader(options(extra))({ repo }).prs[0];
const comment = body => ({ id: 'IC_referral', body, author: { login: 'web-everything' }, createdAt: at });
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
  expect(readComments).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repo, number: 1, exec: expect.any(Function) }));
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
  expect(gh).toHaveBeenCalledTimes(1);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(runGhSync).not.toHaveBeenCalled();
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: true, superseded: false }]);
});

// Exercise the shared, real TSV comment reader, including the adapter's page loop.
const tsv = (body = 'ordinary comment') => `${body}\t${at}\tweb-everything\tIC_fixture\n`;
it('default transport issues only repository-scoped reads and preserves a referral on page two', () => {
  const record = referralRecord();
  const escaped = renderReferralRecord(record).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  runGhSync.mockImplementation(args => args[0] === 'pr' ? JSON.stringify([pr()])
    : args.includes('page=1') ? tsv().repeat(100) : tsv(escaped));
  const { gh: _gh, readComments: _comments, ...defaults } = options();
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs[0];
  expect(facts.openReferrals).toEqual([{ key: record.referrals[0].key, ruled: false, superseded: false }]);
  expect(facts.evidenceErrors).toEqual([]);
  expect(execFileSync).not.toHaveBeenCalled();
  const calls = runGhSync.mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[0][0]).toEqual(expect.arrayContaining(['pr', 'list', '--repo', repo]));
  expect(calls[0][0][calls[0][0].indexOf('--repo') + 1]).toBe(repo);
  for (const [args, opts] of calls) {
    expect(opts).toMatchObject({ timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      throttle: { maxAttempts: 1, personalRoute: false } });
    if (args[0] === 'api') {
      // gh api takes an explicit repository endpoint; it has no --repo flag.
      expect(args).toEqual(expect.arrayContaining(['--method', 'GET', `repos/${repo}/issues/1/comments`]));
      expect(args).not.toContain('--paginate');
    } else expect(args.slice(0, 2)).toEqual(['pr', 'list']);
  }
  expect(calls[1][0]).toContain('page=1');
  expect(calls[2][0]).toContain('page=2');
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

it.each([126, 127])('each comment page consumes the 128-call budget (%i full pages)', fullPages => {
  let page = 0;
  const gh = vi.fn(args => {
    if (args[0] === 'pr') return JSON.stringify([pr()]);
    page++;
    return page <= fullPages ? tsv().repeat(100) : '';
  });
  const { readComments: _comments, ...defaults } = options({ gh });
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs[0];
  expect(gh).toHaveBeenCalledTimes(128);
  expect(page).toBe(127);
  expect(facts.openReferrals).toEqual(fullPages === 126 ? [] : null);
  expect(facts.evidenceErrors).toEqual(fullPages === 126 ? [] : ['comment evidence unreadable or budget exhausted']);
});

it('shares the call budget across PRs and withholds unread comments after exhaustion', () => {
  const listing = Array.from({ length: 129 }, (_, i) => pr({ number: i + 1 }));
  const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify(listing) : '');
  const { readComments: _comments, ...defaults } = options({ gh });
  const facts = createJudgeSweepFactsReader(defaults)({ repo }).prs;
  expect(gh).toHaveBeenCalledTimes(128);
  expect(facts[126].openReferrals).toEqual([]);
  expect(facts.slice(127).map(p => p.openReferrals)).toEqual([null, null]);
  expect(facts[128].evidenceErrors).toContain('comment evidence unreadable or budget exhausted');
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
  expect(shape).toHaveBeenCalledExactlyOnceWith(['README.md']);
});

it('a shape-rules version bump invalidates a cached non-human result in a fresh reader', () => {
  let disk = '{}';
  const io = { read: () => disk, write: (_path, data) => { disk = data; } };
  const old = createShapeCache({ ...io, rulesVersion: 1 });
  const key = `${repo}:${head}:${'b'.repeat(40)}`;
  old.set(key, false);
  expect(createShapeCache({ ...io, rulesVersion: 1 }).get(key)).toBe(false);
  const shape = vi.fn(() => ({ humanRequired: true }));
  const facts = read({ cache: createShapeCache({ ...io, rulesVersion: 2 }), shape,
    gh: () => JSON.stringify([humanPr()]) });
  expect(facts.humanRequired).toBe(true);
  expect(shape).toHaveBeenCalledExactlyOnceWith(['README.md']);
  expect(createShapeCache({ ...io, rulesVersion: 2 }).get(key)).toBe(true);
  expect(createShapeCache({ ...io, rulesVersion: 1 }).get(key)).toBeUndefined();
});

it('cache retains at most 256 entries on both load and write, evicting the oldest entry', () => {
  const keys = Array.from({ length: 257 }, (_, i) => `${repo}:${i.toString(16).padStart(40, '0')}:${head}`);
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
  const key = `${repo}:${head}:${'b'.repeat(40)}`;
  const cache = createShapeCache({ read: () => disk, write: (_path, data) => { disk = data; } });
  expect(cache.get(key)).toBeUndefined();
  cache.set(key, true);
  expect(JSON.parse(disk)).toEqual({ rulesVersion: 1, entries: { [key]: true } });
});

it('shape child receives filenames unchanged as JSON stdin with bounded output and runtime', () => {
  const files = ['with,comma.md', 'with space.md', 'with\ttab.md', 'with\nnewline.md', 'with\rreturn.md',
    'with\u2028separator.md', '`backtick`.md', "quote'\".md", '$(shell).md', '--leading.md',
    '../parent.md', 'invisible\u200b.md', 'ｆullwidth.md', 'back\\slash.md'];
  execFileSync.mockReturnValue('{"humanRequired":true}');
  const facts = read({ gh: () => JSON.stringify([humanPr({ files: files.map(path => ({ path })), changedFiles: files.length })]) });
  expect(facts.humanRequired).toBe(true);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  const [bin, args, opts] = execFileSync.mock.calls[0];
  expect(bin).toBe(process.execPath);
  expect(args).toEqual([expect.stringMatching(/scripts\/review-core-cli\.mjs$/), 'shape', '--json']);
  expect(JSON.parse(opts.input)).toEqual(files);
  expect(opts).toMatchObject({ encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
});
