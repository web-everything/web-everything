/**
 * @file scripts/conveyor/__tests__/auto-round-grant.test.mjs
 * @description The automated standing-ruling round grant (operator option B, 2026-10-20): the operator's ruling
 *   record, the narrowed trust rule for automation-posted grants, eligibility (card-only NET diff, repo, note
 *   kind), the per-PR cap (ledger seeded from existing grants + reservations), idempotency, the expected-head check
 *   right before the write, redaction, and the daemon hook.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../../lib/atomic-json-file.mjs';
import { COORDINATION_ROOT_ENV } from '../../operations/coordination-root.mjs';
import {
  AUTO_GRANT_CHANNEL, autoGrantKey, countAutoRoundGrants, decideAutoGrant, isCardOnlyNetDiff,
  resolveAutoRoundGrantSettings, screenAutoGrantNote, STANDING_RULING,
} from '../auto-round-grant.mjs';
import { autoRoundGrant, claimDir, LEDGER_BUSY_DEFER_MS, withPrLedger, redact, readPrThread, postPrComment, stuckAfterGrant, STUCK_AFTER_GRANT_MS } from '../auto-round-grant-io.mjs';
import { buildRoundExtensionComment, countGrantedRoundExtensions, countStandingRulingGrantRecords, roundExtensionGrants, standingRulingGrantEpisodes } from '../round-extension-mark.mjs';
import { buildStandingRulingBody, citedGrantHeads, pickStandingRuling, verifyStandingRuling } from '../standing-ruling-mark.mjs';
import { enrichPrsWithStandingRulingGrants, headBelongsToPr, headIsCardOnly, readOperatorIssues, readStandingRuling, readUneditedCommentIds, standingRulingScope } from '../standing-ruling-io.mjs';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';
import { planRoundExtension } from '../../operations/extend-rounds.mjs';
import { gateRoundCap } from '../../lib/red-team-gate.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

// The real transport, mocked only to read the options every default App-identity call passes (no test reaches GitHub).
vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => ({ ...(await importOriginal()), execFileSyncThrottled: vi.fn() }));

const WE = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const RULING_ID = `${WE}#6000`;
const note = { kind: 'round-cap-exhausted', prNumber: 5654, attempts: 8, cap: 7, capKind: 'review', text: 'PR #5654: review auto-repair rounds exhausted (8/7) — a person must take it over' };
const ON = { enabled: true, maxPerPr: 3, repos: [WE], sources: {} };
const rulingBody = buildStandingRulingBody({ repos: [WE], ruledAt: '2026-10-19', confirmedAt: '2026-10-20', words: 'automate, capped at 3 per PR' });
const rulingIssue = (over = {}) => ({ number: 6000, state: 'OPEN', body: rulingBody, author: { login: 'chalbert' }, lastEditedAt: null, editor: null, ...over });
const RULING = { ok: true, id: RULING_ID, author: 'chalbert', by: 1, maxPerPr: 3, repos: [WE] };
let ids = 0;
const scope = (heads = { [HEAD]: true }, over = {}) => ({ ...RULING, cardOnlyHeads: heads, uneditedComments: [...Array(10000).keys()].map((i) => `IC_${i}`), ...over });
let eps = 0;
const autoGrant = ({ head = HEAD, login = 'web-everything[bot]', ruling = RULING_ID, by = 1, pr = 5654, repo = WE, actor = 'chalbert', episode = `${WE}#${pr}@${head}:review:${++eps}/0` } = {}) => ({
  id: `IC_${++ids}`, author: { login }, createdAt: '2026-10-20T12:00:00Z',
  body: buildRoundExtensionComment({ repo, pr, by, actor, channel: AUTO_GRANT_CHANNEL, reason: 'r', at: '2026-10-20T00:00:00Z', standingRuling: ruling, head, episode }),
});
const manualGrant = (login = 'chalbert') => ({ author: { login },
  body: buildRoundExtensionComment({ repo: WE, pr: 5654, by: 1, actor: 'chalbert', channel: 'claude-code-chat', reason: 'r', at: '2026-10-20T00:00:00Z' }) });

// PR #5758 review: every test injected its own gh, so dropping `personalRoute: false` reddened nothing.
describe('App identity only, personal read routing off', () => {
  it('every default standing-ruling read and automatic-grant read or post passes throttle.personalRoute=false', () => {
    execFileSyncThrottled.mockReset();
    execFileSyncThrottled.mockImplementation((_file, args) => {
      if (String(args[2]).endsWith('/pulls')) return '5654\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', headRefOid: HEAD });
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      return '';
    });
    readOperatorIssues(WE);
    expect(headBelongsToPr({ repo: WE, number: 5654, head: HEAD })).toBe(true);
    readUneditedCommentIds({ repo: WE, number: 5654 }, { readEdits: (_n, { exec }) => { exec('gh', ['api', 'graphql', '-f', 'query=x']); return []; } });
    readPrThread(WE, 5654, { readComments: (_n, { exec }) => { exec('gh', ['api', `repos/${WE}/issues/5654/comments`]); return []; } });
    postPrComment(WE, 5654, 'body');
    const calls = execFileSyncThrottled.mock.calls;
    expect(calls.map(([, args]) => args[0] === 'pr' ? `pr ${args[1]}` : args.find((a) => a === 'graphql' || a.startsWith('repos/')))).toEqual(expect.arrayContaining(
      ['graphql', `repos/${WE}/commits/${HEAD}/pulls`, `repos/${WE}/issues/5654/comments`, 'pr view', 'pr comment']));
    for (const [file, , opts] of calls) {
      expect(file).toBe('gh');
      expect(opts.throttle).toEqual({ personalRoute: false });
    }
    // No later test may fall through to canned data: the default transport is an empty mock again.
    execFileSyncThrottled.mockReset();
  });
});

describe('complete App thread reads', () => {
  it('includes grants beyond the first page using the same App transport', () => {
    const grant = autoGrant();
    const comments = [...Array.from({ length: 100 }, (_, i) => `filler\t2026-10-20T12:00:00Z\tweb-everything[bot]\tIC_filler_${i}`),
      `${grant.body.replace(/\n/g, '\\n')}\t${grant.createdAt}\t${grant.author.login}\t${grant.id}`];
    const gh = vi.fn((args) => {
      if (args[0] === 'pr') return JSON.stringify({ state: 'OPEN', headRefOid: HEAD });
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });
      return comments.join('\n');
    });
    const thread = readPrThread(WE, 5654, { gh });
    expect(thread.comments).toHaveLength(101);
    expect(thread.comments[100]).toMatchObject(grant);
    expect(gh.mock.calls[0][0]).toContain('--paginate');
    expect(gh.mock.calls[0][0]).toContain(`repos/${WE}/issues/5654/comments`);
    expect(gh.mock.calls[2][0]).toContain('state,headRefOid');
  });

  it('propagates incomplete comment reads instead of counting zero grants', () => {
    const gh = () => JSON.stringify({ state: 'OPEN', headRefOid: HEAD });
    expect(() => readPrThread(WE, 5654, { gh, readComments: () => { throw new Error('page failed'); } })).toThrow('page failed');
    expect(() => readPrThread(WE, 5654, { gh, readComments: () => null })).toThrow('no array');
  });

  it('checks edit history across pages and excludes edited comments', () => {
    const gh = vi.fn((args) => JSON.stringify({ data: { repository: { pullRequest: { comments: {
      nodes: args.includes('cursor=next')
        ? [{ id: 'IC_late', lastEditedAt: null }, { id: 'IC_edited', lastEditedAt: '2026-10-20T12:00:00Z' }]
        : Array.from({ length: 100 }, (_, i) => ({ id: `IC_${i}`, lastEditedAt: null })),
      pageInfo: { hasNextPage: !args.includes('cursor=next'), endCursor: 'next' },
    } } } } }));
    const ids = readUneditedCommentIds({ repo: 'we', number: 5654 }, { gh });
    expect(ids).toHaveLength(101);
    expect(ids).toContain('IC_late');
    expect(ids).not.toContain('IC_edited');
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[0][0]).toContain('owner=web-everything');
    expect(gh.mock.calls[1][0]).toContain('cursor=next');
  });
});

describe('the operator ruling record', () => {
  it('verifies an open, operator-authored, unedited ruling and returns its bounds', () => {
    expect(verifyStandingRuling(rulingIssue(), { repo: WE })).toMatchObject({ ok: true, id: RULING_ID, by: 1, maxPerPr: 3, repos: [WE], author: 'chalbert' });
  });
  it.each([
    ['App-authored', { author: { login: 'web-everything[bot]' } }],
    ['closed (revoked)', { state: 'CLOSED' }],
    ['edited by a non-operator', { lastEditedAt: '2026-10-21T00:00:00Z', editor: { login: 'web-everything[bot]' } }],
    ['no marker', { body: rulingBody.replace('🧭', '') }],
    ['two records', { body: `${rulingBody}\n<!-- standing-ruling: {} -->` }],
    ['bigger by', { body: rulingBody.replace('"by":1', '"by":2') }],
    ['repo not covered', { body: rulingBody.replaceAll(WE, 'other/repo') }],
  ])('refuses a ruling that is %s', (_, over) => {
    expect(verifyStandingRuling(rulingIssue(over), { repo: WE }).ok).toBe(false);
  });
  it('an operator edit keeps it valid; the newest valid ruling wins', () => {
    expect(verifyStandingRuling(rulingIssue({ lastEditedAt: 'x', editor: { login: 'chalbert' } }), { repo: WE }).ok).toBe(true);
    expect(pickStandingRuling([rulingIssue(), rulingIssue({ number: 6100 }), rulingIssue({ number: 6200, state: 'CLOSED' })], { repo: WE }).id).toBe(`${WE}#6100`);
  });
});

describe('trust rule for grants (round-extension-mark)', () => {
  it('ignores untrusted and missing authors before reading candidate heads or reserving grant room', () => {
    const grant = autoGrant();
    for (const untrusted of [
      { ...grant, author: { login: 'mallory' } },
      { ...grant, author: undefined },
      grant.body, null,
    ]) {
      expect(citedGrantHeads([untrusted])).toEqual([]);
      expect(countStandingRulingGrantRecords([untrusted], { repo: WE, pr: 5654 })).toBe(0);
      expect(standingRulingGrantEpisodes([untrusted], { repo: WE, pr: 5654 })).toEqual({ episodes: [], unrecoverable: 0 });
    }
    expect(citedGrantHeads([grant])).toEqual([HEAD]);
    expect(countStandingRulingGrantRecords([grant], { repo: WE, pr: 5654 })).toBe(1);
    expect(standingRulingGrantEpisodes([grant], { repo: WE, pr: 5654 }).episodes).toHaveLength(1);
    const operator = { ...grant, author: { login: 'chalbert' } };
    expect(citedGrantHeads([operator])).toEqual([HEAD]);
    expect(countStandingRulingGrantRecords([operator], { repo: WE, pr: 5654 })).toBe(0);
    expect(standingRulingGrantEpisodes([operator], { repo: WE, pr: 5654 })).toEqual({ episodes: [], unrecoverable: 0 });
  });
  it('without a verified scope an automation-posted grant never counts; manual operator grants still do', () => {
    expect(countGrantedRoundExtensions([autoGrant(), manualGrant()], { repo: WE, pr: 5654 })).toBe(1);
  });
  it('an App grant counts only inside every bound of the cited ruling', () => {
    const s = scope({ [HEAD]: true, [HEAD2]: false });
    expect(countGrantedRoundExtensions([autoGrant()], { repo: WE, pr: 5654, standingRuling: s })).toBe(1);
    for (const bad of [autoGrant({ head: HEAD2 }), autoGrant({ ruling: `${WE}#1` }), autoGrant({ by: 2 }),
      autoGrant({ login: 'mallory' }), autoGrant({ actor: 'web-everything' }), autoGrant({ head: 'c'.repeat(40) })]) {
      expect(countGrantedRoundExtensions([bad], { repo: WE, pr: 5654, standingRuling: s })).toBe(0);
    }
    expect(countGrantedRoundExtensions([autoGrant()], { repo: 'other/repo', pr: 5654, standingRuling: s })).toBe(0);
  });
  it('a 4th automation grant never counts (read-time cap)', () => {
    const four = [autoGrant(), autoGrant(), autoGrant(), autoGrant()];
    expect(countGrantedRoundExtensions(four, { repo: WE, pr: 5654, standingRuling: scope() })).toBe(3);
  });
  it('an edited App grant never counts (bound to the never-edited comment)', () => {
    const g = autoGrant();
    expect(countGrantedRoundExtensions([g], { repo: WE, pr: 5654, standingRuling: scope(undefined, { uneditedComments: [] }) })).toBe(0);
  });
  it('the ruling record cannot raise the cap past 3 and needs its dates', () => {
    expect(verifyStandingRuling(rulingIssue({ body: rulingBody.replace('"maxPerPr":3', '"maxPerPr":4') }), { repo: WE }).ok).toBe(false);
    expect(verifyStandingRuling(rulingIssue({ body: rulingBody.replace('"ruledAt":"2026-10-19",', '') }), { repo: WE }).ok).toBe(false);
  });
  it('an App-posted body impersonating a manual operator grant is still refused', () => {
    expect(countGrantedRoundExtensions([manualGrant('web-everything[bot]')], { repo: WE, pr: 5654, standingRuling: scope() })).toBe(0);
  });
});

describe('read-time scope (standing-ruling-io)', () => {
  it('re-judges every cited head on current main; no cited grant = no reads', () => {
    const readRuling = vi.fn(() => RULING);
    const cardOnly = vi.fn(({ head }) => head === HEAD);
    expect(standingRulingScope({ repo: WE, pr: { number: 5654, comments: [manualGrant()] } }, { readRuling, cardOnly })).toBeNull();
    expect(readRuling).not.toHaveBeenCalled();
    const s = standingRulingScope({ repo: WE, pr: { number: 5654, headRefOid: HEAD, comments: [autoGrant(), autoGrant({ head: HEAD2 })] } }, { readRuling, cardOnly, unedited: () => ['IC_x'] });
    expect(s.cardOnlyHeads).toEqual({ [HEAD]: true, [HEAD2]: false });
    expect(s.uneditedComments).toEqual(['IC_x']);
    expect(cardOnly.mock.calls.filter(([a]) => a.head === HEAD)).toHaveLength(1);
    expect(citedGrantHeads([autoGrant()])).toEqual([HEAD]);
  });
  // PR #5758 review: a grant cited a card-only head, then the author pushed code. The ruling covers card-only PRs only.
  it('a grant on a card-only head does not count once the current head carries non-card files', () => {
    const readRuling = () => RULING;
    const cardOnly = ({ head }) => head === HEAD;
    const comments = [autoGrant({ head: HEAD })];
    const on = (headRefOid) => standingRulingScope({ repo: WE, pr: { number: 5654, headRefOid, comments } }, { readRuling, cardOnly, unedited: () => [comments[0].id] });
    expect(countGrantedRoundExtensions(comments, { repo: WE, pr: 5654, standingRuling: on(HEAD) })).toBe(1);
    expect(on(HEAD2)).toBeNull();
    expect(countGrantedRoundExtensions(comments, { repo: WE, pr: 5654, standingRuling: on(HEAD2) })).toBe(0);
    for (const unknown of [undefined, '', 'not-a-sha', HEAD.slice(0, 12)]) expect(on(unknown)).toBeNull();
    // A current-head judgement that throws is not card-only (fail closed).
    expect(standingRulingScope({ repo: WE, pr: { number: 5654, headRefOid: HEAD2, comments } },
      { readRuling, cardOnly: ({ head }) => { if (head === HEAD2) throw new Error('git'); return true; }, unedited: () => [] })).toBeNull();
  });
  it('stuckAfterGrant judges the PR\'s current head, not only the cited one', () => {
    const scopeOf = vi.fn(() => null);
    const p = { number: 5654, headRefOid: HEAD, labels: [{ name: 'status:at-round-limit' }], comments: [autoGrant()] };
    stuckAfterGrant({ repo: 'we', pr: p }, { scopeOf, now: () => Date.now() });
    expect(scopeOf.mock.calls[0][0].pr).toMatchObject({ number: 5654, headRefOid: HEAD });
  });
  // PR #5758 review: the ruling lookup read only the 30 newest open operator issues.
  it('finds the ruling behind any number of newer operator issues (pagination), and fails closed at the page bound', () => {
    const newer = Array.from({ length: 250 }, (_, i) => ({ number: 7000 + i, state: 'OPEN', body: 'x', author: { login: 'chalbert' } }));
    const all = [...newer, rulingIssue()];
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      const after = args.find((a) => a.startsWith('after='))?.slice(6);
      const by = args.find((a) => a.startsWith('by='))?.slice(3);
      const mine = by === 'chalbert' ? all : [];
      const start = after ? Number(after) : 0;
      const nodes = mine.slice(start, start + 100);
      const hasNextPage = start + 100 < mine.length;
      return JSON.stringify({ data: { repository: { issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + 100) : null } } } } });
    };
    const issues = readOperatorIssues(WE, { gh });
    expect(issues).toHaveLength(251);
    expect(calls.filter((a) => a.includes('by=chalbert'))).toHaveLength(3);
    expect(readStandingRuling(WE, { readIssues: (repo) => readOperatorIssues(repo, { gh }) })).toMatchObject({ id: RULING_ID });
    const log = vi.fn();
    expect(readStandingRuling(WE, { log, readIssues: (repo) => readOperatorIssues(repo, { gh, maxPages: 2 }) })).toBeNull();
    expect(log.mock.calls[0][0]).toMatch(/exceed 2 pages/);
    const noCursor = () => JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } });
    expect(() => readOperatorIssues(WE, { gh: noCursor })).toThrow(/without a cursor/);
    expect(() => readOperatorIssues(WE, { gh: () => JSON.stringify({ errors: [{ message: 'x' }] }) })).toThrow(/unexpected response/);
  });
  it('a ruling read failure fails closed and logs redacted', () => {
    const log = vi.fn();
    expect(readStandingRuling(WE, { log, readIssues: () => { throw new Error('rate limited ghs_abcdefghijklmnop'); } })).toBeNull();
    expect(log.mock.calls[0][0]).toContain('[redacted]');
  });
  it('never caches: a closed ruling stops counting at the next read', () => {
    let state = 'OPEN';
    const readIssues = () => [rulingIssue({ state })];
    expect(readStandingRuling(WE, { readIssues })).not.toBeNull();
    state = 'CLOSED';
    expect(readStandingRuling(WE, { readIssues })).toBeNull();
  });
  it('reads every page of a commit\'s PRs (the PR may be past the first page)', () => {
    const gh = vi.fn(() => `${Array.from({ length: 30 }, (_, i) => 9000 + i).join('\n')}\n5654\n`);
    expect(headBelongsToPr({ repo: WE, number: 5654, head: HEAD }, { gh })).toBe(true);
    expect(gh.mock.calls[0][0]).toContain('--paginate');
    expect(headBelongsToPr({ repo: WE, number: 5654, head: HEAD }, { gh: () => '' })).toBe(false);
  });
  it('a cited head of another PR is not card-only for this PR', () => {
    const readNet = vi.fn(() => ({ ok: true, files: ['backlog/x.md'] }));
    expect(headIsCardOnly({ repo: WE, number: 5654, head: HEAD }, { readNet, belongs: () => false })).toBe(false);
    expect(readNet).not.toHaveBeenCalled();
    expect(headIsCardOnly({ repo: WE, number: 5654, head: HEAD }, { readNet, belongs: () => true })).toBe(true);
  });
  it('the enrich step attaches the scope only where a grant is cited and never throws', () => {
    const prs = [{ number: 1, comments: [autoGrant()] }, { number: 2, comments: [] }];
    const readRuling = vi.fn(() => RULING);
    const out = enrichPrsWithStandingRulingGrants(prs, { repo: WE, readRuling, scope: ({ pr }) => (pr.number === 1 ? scope() : null) });
    expect(readRuling).toHaveBeenCalledTimes(1);
    expect(out[0].standingRuling.id).toBe(RULING_ID); expect(out[1].standingRuling).toBeUndefined();
    expect(enrichPrsWithStandingRulingGrants(prs, { repo: WE, readRuling, scope: () => { throw new Error('x'); } })).toEqual(prs);
  });
});

const tmpDirs = [];
const tmpDir = () => { const dir = mkdtempSync(join(tmpdir(), 'arg-')); tmpDirs.push(dir); return dir; };
afterAll(() => { for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true }); });
const tmpLedger = () => { const dir = tmpDir(); return (slug, pr, fn) => withPrLedger(slug, pr, fn, { dir }); };
/** A fake GitHub thread: posts append App-authored comments; head can be moved by a test. */
const fakeGh = ({ comments = [], head = HEAD, state = 'OPEN' } = {}) => {
  const t = { comments: [...comments], head, state };
  return { t, readThread: vi.fn(() => ({ state: t.state, headRefOid: t.head, comments: t.comments })),
    post: vi.fn((repo, pr, body) => { t.comments.push({ id: `IC_${++ids}`, author: { login: 'web-everything[bot]' }, createdAt: '2026-10-20T12:00:00Z', body }); }) };
};
const deps = (gh = fakeGh(), over = {}) => ({
  settings: ON, readRuling: () => RULING, readThread: gh.readThread, post: gh.post, ledger: tmpLedger(),
  // Read-time scope stand-in: HEAD is a card-only commit of the PR, HEAD2 is not; nothing edited.
  scopeOf: ({ pr, ruling }) => ({ ...ruling, cardOnlyHeads: { [HEAD]: true, [HEAD2]: false }, uneditedComments: (pr.comments ?? []).map((c) => c.id) }),
  readNet: () => ({ ok: true, files: ['backlog/x8js7c9-prevention.md', 'backlog/raised-by/x8js7c9.json'], added: [] }), ...over,
});
const call = (d, n = note, head = HEAD) => autoRoundGrant({ repo: 'we', note: n, pr: { headRefOid: head } }, d);

describe('settings cascade', () => {
  it('standard is off with cap 3; the tool layer turns it on; never above 3', () => {
    expect(resolveAutoRoundGrantSettings({})).toMatchObject({ enabled: false, maxPerPr: 3, repos: [WE] });
    expect(resolveAutoRoundGrantSettings({ tool: { autoRoundGrant: { cardOnly: { enabled: true, maxPerPr: 5 } } } })).toMatchObject({ enabled: true, maxPerPr: 3 });
  });
});

describe('card-only is judged on the NET diff', () => {
  it('accepts cards and raised-by sidecars only', () => {
    expect(isCardOnlyNetDiff(['backlog/a.md', 'backlog/raised-by/a.json'])).toBe(true);
    for (const bad of [['backlog/a.md', 'scripts/x.mjs'], [], ['backlog/../scripts/x.mjs'], ['backlogs/a.md']]) expect(isCardOnlyNetDiff(bad)).toBe(false);
  });
  it('an inflated three-dot list does not matter: the net read decides', () => {
    const gh = fakeGh(); const readNet = vi.fn(() => ({ ok: true, files: ['backlog/x.md'] }));
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD, files: [{ path: 'scripts/foo.mjs' }] } }, deps(gh, { readNet }))).toMatchObject({ action: 'granted', count: 1, max: 3 });
    expect(readNet).toHaveBeenCalledWith({ repo: WE, number: 5654, headRefOid: HEAD }, { log: expect.any(Function) });
  });
  it('a code PR is refused and nothing is posted; an unreadable net diff fails closed', () => {
    const gh = fakeGh();
    expect(call(deps(gh, { readNet: () => ({ ok: true, files: ['backlog/x.md', 'scripts/conveyor/foo.mjs'] }) }))).toEqual({ action: 'skip', why: 'not card-only: scripts/conveyor/foo.mjs' });
    expect(call(deps(gh, { readNet: () => ({ ok: false, reason: 'fetch failed' }) }))).toMatchObject({ action: 'skip', why: 'net diff unreadable: fetch failed' });
    expect(gh.post).not.toHaveBeenCalled();
  });
});

describe('the grant', () => {
  it('posts an App comment citing the ruling and its head, which the trusted reader then counts', () => {
    const gh = fakeGh();
    expect(call(deps(gh))).toMatchObject({ action: 'granted', count: 1, max: 3 });
    const body = gh.post.mock.calls[0][2];
    const grants = roundExtensionGrants(gh.t.comments, { repo: WE, pr: 5654, standingRuling: scope() });
    expect(grants).toEqual([expect.objectContaining({ by: 1, standingRuling: RULING_ID, head: HEAD })]);
    expect(body).toContain(STANDING_RULING); expect(body).toContain('Automatic grant 1/3'); expect(body).toContain(RULING_ID);
  });
  // PR #5758: every scope the hook reads judges the PR's live head too, not only the head a grant cites.
  it('passes the live thread head to every scope read', () => {
    const gh = fakeGh(); const scopeOf = vi.fn(deps(gh).scopeOf);
    expect(call(deps(gh, { scopeOf }))).toMatchObject({ action: 'granted' });
    expect(scopeOf.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [a] of scopeOf.mock.calls) expect(a.pr).toMatchObject({ number: 5654, headRefOid: HEAD });
  });
  it('no recorded ruling: nothing is posted', () => {
    const gh = fakeGh();
    expect(call(deps(gh, { readRuling: () => null }))).toMatchObject({ action: 'skip', why: expect.stringContaining('no standing ruling') });
    expect(gh.post).not.toHaveBeenCalled();
  });
  it('screens other kinds, repos and disabled settings before any read', () => {
    const readRuling = vi.fn(() => RULING); const d = deps(fakeGh(), { readRuling });
    expect(call(d, { ...note, kind: 'ci-heal-exhausted' })).toBeNull();
    expect(autoRoundGrant({ repo: 'plateau-app', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'skip' });
    expect(call({ ...d, settings: { ...ON, enabled: false } })).toBeNull();
    expect(readRuling).not.toHaveBeenCalled();
    expect(screenAutoGrantNote({ note: { ...note, takeoverNotConverging: true }, repo: 'we', pr: { headRefOid: HEAD }, settings: ON }).ok).toBe(false);
  });
  it('expected-head check right before the write: a head moved after judging is never granted', () => {
    const gh = fakeGh(); let reads = 0;
    gh.readThread.mockImplementation(() => { reads += 1; if (reads === 2) gh.t.head = HEAD2; return { state: gh.t.state, headRefOid: gh.t.head, comments: gh.t.comments }; });
    expect(call(deps(gh))).toMatchObject({ action: 'skip', why: expect.stringContaining('head moved') });
    expect(gh.post).not.toHaveBeenCalled();
    expect(call(deps(fakeGh({ head: HEAD2 })))).toMatchObject({ action: 'skip', why: expect.stringContaining('head moved') });
  });
  it('a post the reader does not trust is a failure (never reported as granted)', () => {
    const gh = fakeGh(); gh.post.mockImplementation(() => {});
    expect(call(deps(gh))).toMatchObject({ action: 'failed' });
  });
});

describe('per-PR cap: ledger seeded from existing grants + reservations', () => {
  it('grants up to 3 then reports cap reached with the cap reason', () => {
    const gh = fakeGh(); const d = deps(gh);
    for (const [a, c] of [[8, 7], [9, 8], [10, 9]]) expect(call(d, { ...note, attempts: a, cap: c }).action).toBe('granted');
    const out = call(d, { ...note, attempts: 11, cap: 10 });
    expect(out).toMatchObject({ action: 'cap-reached', used: 3, max: 3 });
    expect(out.reason).toMatch(/^auto-grant cap reached \(3\/3\): PR #5654/);
    expect(gh.post).toHaveBeenCalledTimes(3);
  });
  it('seeds from grants already on the PR (even ones it cannot verify) and adds reservations on top', () => {
    const gh = fakeGh({ comments: [autoGrant({ head: HEAD2 }), autoGrant({ head: HEAD2 })] });
    const d = deps(gh);
    expect(call(d)).toMatchObject({ action: 'granted', count: 3 });
    expect(call(d, { ...note, attempts: 9, cap: 8 })).toMatchObject({ action: 'cap-reached', used: 3 });
  });
  it('a failed reservation keeps its slot even with historical grants (round-2 finding)', () => {
    const gh = fakeGh({ comments: [autoGrant({ head: HEAD2 }), autoGrant({ head: HEAD2 })] });
    gh.post.mockImplementationOnce(() => { throw new Error('network'); });
    const d = deps(gh);
    expect(call(d)).toMatchObject({ action: 'failed' });
    expect(call(d, { ...note, attempts: 9, cap: 8 })).toMatchObject({ action: 'cap-reached', used: 3 });
  });
  it('idempotent per limit hit; a busy lock never grants', () => {
    const gh = fakeGh(); const d = deps(gh);
    expect(call(d).action).toBe('granted');
    expect(call(d)).toEqual({ action: 'already-granted', key: `${WE}#5654@${HEAD}:review:8/7` });
    expect(gh.post).toHaveBeenCalledTimes(1);
    expect(autoGrantKey({ repo: 'we', note, head: HEAD })).toBe(`${WE}#5654@${HEAD}:review:8/7`);
    const busy = fakeGh();
    expect(call(deps(busy, { ledger: () => { throw new Error('withFileLock: timed out'); } }))).toMatchObject({ action: 'skip' });
    expect(busy.post).not.toHaveBeenCalled();
  });
  it('the ruling can lower the cap', () => {
    const gh = fakeGh(); const d = deps(gh, { readRuling: () => ({ ...RULING, maxPerPr: 1 }) });
    expect(call(d).action).toBe('granted');
    expect(call(d, { ...note, attempts: 9, cap: 8 })).toMatchObject({ action: 'cap-reached', max: 1 });
  });
  it('countAutoRoundGrants needs a scope', () => {
    expect(countAutoRoundGrants([autoGrant()], { repo: WE, pr: 5654 })).toBe(0);
    expect(countAutoRoundGrants([autoGrant()], { repo: WE, pr: 5654, standingRuling: scope() })).toBe(1);
    expect(decideAutoGrant({ netRead: { ok: true, files: ['backlog/a.md'] }, used: 0, max: 3, state: 'MERGED' }).action).toBe('skip');
  });
});

// PR #5758 review: the concurrency and durable-before-post guarantees were only exercised through an in-memory
// lock stub. These run the real file lock and the on-disk ledger, as two daemons on one host would.
describe('concurrency and durable-before-post, on the real file lock and ledger', () => {
  const ledgerPath = (dir) => `${join(dir, createHash('sha256').update(`${WE}#5654`).digest('hex').slice(0, 32))}.json`;
  // Each worker gets its own ledger closure over the SAME directory, as two checkouts sharing one coordination root.
  const worker = (dir, lockOpts = { timeoutMs: 150, pollMs: 10 }) =>
    (slug, pr, fn) => withPrLedger(slug, pr, fn, { dir, lock: (p, f) => withFileLock(p, f, lockOpts) });
  const later = { ...note, attempts: 9, cap: 8 };
  const landed = (gh, body) => gh.t.comments.push({ id: `IC_${++ids}`, author: { login: 'web-everything[bot]' }, createdAt: '2026-10-20T12:00:00Z', body });

  it('every checkout resolves the same ledger directory from the coordination root, never from its cwd', () => {
    expect(claimDir({ [COORDINATION_ROOT_ENV]: '/coord' })).toBe(join('/coord', 'auto-round-grant'));
    expect(claimDir({})).toBe(join(homedir(), 'workspace', '.operations', 'coordination', 'auto-round-grant'));
  });
  it('a second worker on the same PR while the first is deciding is refused by the lock: no read, no post', () => {
    const dir = tmpDir(); const gh = fakeGh(); let inner; let innerReads = 0;
    const innerGh = { readThread: vi.fn(() => { innerReads += 1; return gh.readThread(); }), post: vi.fn() };
    gh.readThread.mockImplementationOnce(() => {
      inner = call(deps(gh, { ledger: worker(dir), readThread: innerGh.readThread, post: innerGh.post }), later);
      return { state: gh.t.state, headRefOid: gh.t.head, comments: gh.t.comments };
    });
    expect(call(deps(gh, { ledger: worker(dir) }))).toMatchObject({ action: 'granted', count: 1 });
    expect(inner).toEqual({ action: 'deferred', why: expect.stringMatching(/^ledger: withFileLock: timed out/) });
    expect(innerReads).toBe(0); expect(innerGh.post).not.toHaveBeenCalled();
    // The lock is released afterwards: the next limit hit is decided normally.
    expect(call(deps(gh, { ledger: worker(dir) }), later)).toMatchObject({ action: 'granted', count: 2 });
    expect(gh.post).toHaveBeenCalledTimes(2);
    // Control: the same interleaving with no lock lets the second worker into the decision.
    const open = tmpDir(); const gh2 = fakeGh(); let openReads = 0;
    const noLock = (slug, pr, fn) => withPrLedger(slug, pr, fn, { dir: open, lock: (_p, f) => f() });
    gh2.readThread.mockImplementationOnce(() => {
      inner = call(deps(gh2, { ledger: noLock, readThread: () => { openReads += 1; return gh2.readThread(); } }), later);
      return { state: gh2.t.state, headRefOid: gh2.t.head, comments: gh2.t.comments };
    });
    call(deps(gh2, { ledger: noLock }));
    expect(openReads).toBeGreaterThan(0);
  });
  it('the production default takes the PR\'s file lock around the ledger section', () => {
    const dir = tmpDir(); let held;
    withPrLedger(WE, 5654, () => { held = existsSync(ledgerPath(dir).replace(/\.json$/, '.lock')); }, { dir });
    expect(held).toBe(true);
    expect(existsSync(ledgerPath(dir).replace(/\.json$/, '.lock'))).toBe(false);
  });
  it('the ledger is read after the lock is taken: a reservation written while waiting is honoured', () => {
    const dir = tmpDir(); const gh = fakeGh();
    const key = autoGrantKey({ repo: 'we', note, head: HEAD });
    // Another worker's reservation lands between this worker's call and its lock acquisition.
    const lateWriter = (slug, pr, fn) => withPrLedger(slug, pr, fn, { dir, lock: (p, f) => {
      writeFileSync(ledgerPath(dir), JSON.stringify({ repo: WE, pr: 5654, baseline: 0, entries: [{ key, outcome: 'reserved' }] }));
      return withFileLock(p, f, { timeoutMs: 150, pollMs: 10 });
    } });
    expect(call(deps(gh, { ledger: lateWriter }))).toEqual({ action: 'skip', why: `already claimed: ${key}` });
    expect(gh.post).not.toHaveBeenCalled();
  });
  // The hold here is LEDGER_BUSY_DEFER_MS+ old, so the note is not deferred: it alerts as usual (never silently stuck).
  it('a slow holder that is still alive keeps its lock past the stale age: no read, no post', () => {
    const dir = tmpDir(); const gh = fakeGh();
    const lockFile = ledgerPath(dir).replace(/\.json$/, '.lock');
    writeFileSync(lockFile, `${process.ppid}\n`); // a live process other than this one
    utimesSync(lockFile, new Date(0), new Date(0));
    expect(call(deps(gh, { ledger: worker(dir, { timeoutMs: 150, pollMs: 10, staleMs: 50 }) })))
      .toEqual({ action: 'skip', why: expect.stringMatching(/^ledger: withFileLock: timed out/) });
    expect(gh.readThread).not.toHaveBeenCalled(); expect(gh.post).not.toHaveBeenCalled();
    expect(readFileSync(lockFile, 'utf8')).toBe(`${process.ppid}\n`);
  });
  it('a second worker at the moment of the post is refused too: the lock spans the post', () => {
    const dir = tmpDir(); const gh = fakeGh(); let inner;
    gh.post.mockImplementationOnce((_r, _p, body) => { inner = call(deps(gh, { ledger: worker(dir) }), later); landed(gh, body); });
    expect(call(deps(gh, { ledger: worker(dir) }))).toMatchObject({ action: 'granted' });
    expect(inner).toMatchObject({ action: 'deferred', why: expect.stringMatching(/^ledger: withFileLock: timed out/) });
    expect(gh.post).toHaveBeenCalledTimes(1);
  });
  it('the reservation is on disk before the post; a crash at the post still holds the slot for the next worker', () => {
    const dir = tmpDir(); const gh = fakeGh(); let atPost;
    const key = autoGrantKey({ repo: 'we', note, head: HEAD });
    // The post never reaches GitHub; snapshot what a process killed at this instant would leave behind.
    gh.post.mockImplementationOnce(() => { atPost = readFileSync(ledgerPath(dir), 'utf8'); throw new Error('killed'); });
    const one = { readRuling: () => ({ ...RULING, maxPerPr: 1 }) };
    expect(call(deps(gh, { ledger: worker(dir), ...one }))).toMatchObject({ action: 'failed' });
    expect(JSON.parse(atPost).entries).toEqual([expect.objectContaining({ key, outcome: 'reserved' })]);
    // Simulate the crash: only the pre-post ledger survives, and the dead process's lock file is left behind.
    writeFileSync(ledgerPath(dir), atPost);
    const lockFile = ledgerPath(dir).replace(/\.json$/, '.lock');
    writeFileSync(lockFile, '999999999\n'); // outside any real pid range: always "no such process"
    utimesSync(lockFile, new Date(0), new Date(0));
    expect(gh.t.comments).toEqual([]);
    const next = worker(dir, { timeoutMs: 2000, pollMs: 10, staleMs: 50 });
    expect(call(deps(gh, { ledger: next, ...one }))).toMatchObject({ action: 'skip', why: `already claimed: ${key}` });
    expect(call(deps(gh, { ledger: next, ...one }), later)).toMatchObject({ action: 'cap-reached', used: 1, max: 1 });
    expect(gh.post).toHaveBeenCalledTimes(1);
    expect(existsSync(lockFile)).toBe(false);
  });
  it('an unreadable ledger fails closed before any thread read or post', () => {
    const dir = tmpDir(); const gh = fakeGh();
    writeFileSync(ledgerPath(dir), '{"baseline":');
    expect(call(deps(gh, { ledger: worker(dir) }))).toEqual({ action: 'skip', why: expect.stringContaining('ledger unreadable') });
    expect(gh.readThread).not.toHaveBeenCalled(); expect(gh.post).not.toHaveBeenCalled();
  });

  // PR #5758 red team (round 6): two daemons hold the same snapshot of a card-only PR at its fix cap. Worker A grants;
  // worker B's stale note must not publish the round-limit alert, comment, or park the PR to a person.
  describe('a stale concurrent cap note after another worker answered it', () => {
    const fixNote = { ...note, capKind: 'fix', parkToHuman: true };
    const safety = { value: { alertAtRoundCap: true }, sources: { alertAtRoundCap: 'test' } };
    const snapshot = () => ({ notes: [fixNote], prsByNumber: new Map([[5654, { number: 5654, headRefOid: HEAD, labels: [], comments: [] }]]) });
    const daemon = (d) => {
      const effects = { publish: vi.fn(), postComment: vi.fn(() => ({ ok: true })), parkToHuman: vi.fn(() => ({ ok: true })) };
      const out = runReconcileNotesAllRepos({ repos: ['we'], tick: snapshot, dryRun: false, safety, ...effects,
        stuckAfterGrant: () => null, autoRoundGrant: (a) => autoRoundGrant(a, d) });
      return { out, ...effects };
    };
    it('worker B, after A granted the same limit hit, parks nothing and publishes nothing', () => {
      const dir = tmpDir(); const gh = fakeGh();
      expect(call(deps(gh, { ledger: worker(dir) }), fixNote)).toMatchObject({ action: 'granted' });
      const b = daemon(deps(gh, { ledger: worker(dir) }));
      expect(b.out.autoGrants).toEqual([expect.objectContaining({ action: 'already-granted' })]);
      expect(b.parkToHuman).not.toHaveBeenCalled(); expect(b.publish).not.toHaveBeenCalled(); expect(b.postComment).not.toHaveBeenCalled();
      expect(gh.post).toHaveBeenCalledTimes(1);
    });
    it('worker B while A is still deciding (lock held) defers the note instead of parking', () => {
      const dir = tmpDir(); const gh = fakeGh(); let b;
      gh.post.mockImplementationOnce((_r, _p, body) => { b = daemon(deps(gh, { ledger: worker(dir) })); landed(gh, body); });
      expect(call(deps(gh, { ledger: worker(dir) }), fixNote)).toMatchObject({ action: 'granted' });
      expect(b.out.autoGrants).toEqual([expect.objectContaining({ action: 'deferred' })]);
      expect(b.parkToHuman).not.toHaveBeenCalled(); expect(b.publish).not.toHaveBeenCalled(); expect(b.postComment).not.toHaveBeenCalled();
    });
    it('a lock held past the deferral bound (hung holder, reused pid) does not defer: the note alerts and parks', () => {
      const dir = tmpDir(); const gh = fakeGh();
      const lockFile = ledgerPath(dir).replace(/\.json$/, '.lock');
      writeFileSync(lockFile, `${process.ppid}\n`);
      const old = new Date(Date.now() - LEDGER_BUSY_DEFER_MS - 60_000); utimesSync(lockFile, old, old);
      const b = daemon(deps(gh, { ledger: worker(dir, { timeoutMs: 150, pollMs: 10, staleMs: 3_600_000 }) }));
      expect(b.out.autoGrants).toEqual([expect.objectContaining({ action: 'skip', why: expect.stringMatching(/^ledger: withFileLock: timed out/) })]);
      expect(b.parkToHuman).toHaveBeenCalledTimes(1); expect(b.publish).toHaveBeenCalledTimes(1);
    });
    it('an operator grant posted after the snapshot defers the note one pass; the next snapshot re-judges it', () => {
      const gh = fakeGh({ comments: [manualGrant()] });
      const b = daemon(deps(gh));
      expect(b.out.autoGrants).toEqual([expect.objectContaining({ action: 'deferred', why: expect.stringContaining('operator grant landed after') })]);
      expect(b.parkToHuman).not.toHaveBeenCalled(); expect(b.publish).not.toHaveBeenCalled(); expect(gh.post).not.toHaveBeenCalled();
      // Bounded: once the snapshot itself carries that grant, the note is judged as usual.
      const seen = { notes: [fixNote], prsByNumber: new Map([[5654, { number: 5654, headRefOid: HEAD, labels: [], comments: [manualGrant()] }]]) };
      const out = runReconcileNotesAllRepos({ repos: ['we'], tick: () => seen, dryRun: false, safety, publish: vi.fn(), postComment: () => ({ ok: true }),
        parkToHuman: () => ({ ok: true }), stuckAfterGrant: () => null, autoRoundGrant: (a) => autoRoundGrant(a, deps(gh)) });
      expect(out.autoGrants[0].action).not.toBe('deferred');
    });
    it('a claimed limit hit whose grant never landed (failed post) still alerts and parks', () => {
      const dir = tmpDir(); const gh = fakeGh();
      gh.post.mockImplementationOnce(() => { throw new Error('network'); });
      expect(call(deps(gh, { ledger: worker(dir) }), fixNote)).toMatchObject({ action: 'failed' });
      const b = daemon(deps(gh, { ledger: worker(dir) }));
      expect(b.out.autoGrants).toEqual([expect.objectContaining({ action: 'skip', why: expect.stringMatching(/^already claimed/) })]);
      expect(b.parkToHuman).toHaveBeenCalledTimes(1); expect(b.publish).toHaveBeenCalledTimes(1);
    });
    it('an untrusted record for the same limit hit does not make the note moot', () => {
      const key = autoGrantKey({ repo: 'we', note: fixNote, head: HEAD });
      const gh = fakeGh({ comments: [{ ...autoGrant({ episode: key }), author: { login: 'mallory' } }, autoGrant({ episode: key, head: HEAD2 })] });
      const b = daemon(deps(gh));
      expect(b.out.autoGrants[0].action).not.toBe('already-granted');
      expect(b.parkToHuman).toHaveBeenCalledTimes(1);
    });
    it('a note suppressed by a grant still gets the never-silently-stuck check', () => {
      const dir = tmpDir(); const gh = fakeGh(); const publish = vi.fn();
      call(deps(gh, { ledger: worker(dir) }), fixNote);
      runReconcileNotesAllRepos({ repos: ['we'], tick: snapshot, dryRun: false, safety, publish, postComment: () => ({ ok: true }), parkToHuman: () => ({ ok: true }),
        stuckAfterGrant: () => 'auto-grant did not free a round: x', autoRoundGrant: (a) => autoRoundGrant(a, deps(gh, { ledger: worker(dir) })) });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ pr: 5654, kind: 'at-round-limit', reason: 'auto-grant did not free a round: x' }));
    });
  });
});

describe('ten-round ceiling over both kinds', () => {
  it('extend-rounds counts standing-ruling grant records toward its ceiling', () => {
    const comments = Array.from({ length: 9 }, () => manualGrant()).concat([autoGrant()]);
    expect(() => planRoundExtension({ state: 'OPEN', comments, now: 'x' }, { repo: WE, pr: 5654, by: 1, actor: 'chalbert', channel: 'c', reason: 'r' })).toThrow(/ceiling/);
  });
  it('the writer refuses when the ceiling leaves no room, never reporting a no-op grant', () => {
    const gh = fakeGh({ comments: Array.from({ length: 10 }, () => manualGrant()) });
    expect(call(deps(gh))).toMatchObject({ action: 'skip', why: expect.stringContaining('ceiling') });
    expect(gh.post).not.toHaveBeenCalled();
  });
  it('a later unverified automation record still counts toward used', () => {
    const gh = fakeGh(); const d = deps(gh);
    expect(call(d).action).toBe('granted');
    gh.t.comments.push(autoGrant({ head: HEAD2 }), autoGrant({ head: HEAD2 }));
    expect(call(d, { ...note, attempts: 9, cap: 8 })).toMatchObject({ action: 'cap-reached', used: 3 });
  });
});

describe('audit round 3 patches', () => {
  it('credits a limit-hit episode only once, even across separate unedited App comments', () => {
    const episode = `${WE}#5654@${HEAD}:review:8/7`;
    const comments = [autoGrant({ episode }), autoGrant({ episode }), autoGrant({ episode })];
    expect(countGrantedRoundExtensions(comments, { repo: WE, pr: 5654, standingRuling: scope() })).toBe(1);
  });
  it('imports later thread episodes into a seeded ledger before deciding another hit', () => {
    const gh = fakeGh();
    gh.post.mockImplementationOnce(() => { throw new Error('network'); });
    const d = deps(gh);
    expect(call(d)).toMatchObject({ action: 'failed' });
    const later = { ...note, attempts: 9, cap: 8 };
    gh.t.comments.push(autoGrant({ episode: autoGrantKey({ repo: WE, note: later, head: HEAD }) }));
    expect(call(d, later)).toMatchObject({ action: 'already-granted' });
    // A failed reservation and two externally posted grants consume all three slots.
    gh.t.comments.push(autoGrant());
    expect(call(d, { ...note, attempts: 10, cap: 9 })).toMatchObject({ action: 'cap-reached', used: 3 });
    expect(gh.post).toHaveBeenCalledTimes(1);
  });
  it('(a) a non-automation author never consumes room or blocks a manual grant', () => {
    const forged = { ...autoGrant(), author: { login: 'mallory' } };
    expect(countStandingRulingGrantRecords([forged, forged, forged], { repo: WE, pr: 5654 })).toBe(0);
    expect(() => planRoundExtension({ state: 'OPEN', comments: [...Array(9).fill(manualGrant()), forged], now: 'x' },
      { repo: WE, pr: 5654, by: 1, actor: 'chalbert', channel: 'c', reason: 'r' })).not.toThrow();
    expect(countStandingRulingGrantRecords([autoGrant()], { repo: WE, pr: 5654 })).toBe(1);
  });
  it('(b) a head moved during the slow verification, just before the post, is never granted and keeps the slot', () => {
    const gh = fakeGh(); let reads = 0;
    gh.readThread.mockImplementation(() => { reads += 1; if (reads === 3) gh.t.head = HEAD2; return { state: gh.t.state, headRefOid: gh.t.head, comments: gh.t.comments }; });
    const d = deps(gh);
    expect(call(d)).toMatchObject({ action: 'skip', why: expect.stringContaining('right before the post') });
    expect(gh.post).not.toHaveBeenCalled();
    gh.t.head = HEAD;
    expect(call(d)).toMatchObject({ action: 'skip', why: expect.stringMatching(/^already claimed/) });
  });
  it('(c) a historical grant for the same limit hit blocks a second one on a fresh ledger', () => {
    const key = `${WE}#5654@${HEAD}:review:8/7`;
    const gh = fakeGh({ comments: [autoGrant({ episode: key })] });
    expect(call(deps(gh))).toEqual({ action: 'already-granted', key });
    expect(gh.post).not.toHaveBeenCalled();
  });
  it('(c) a historical record without a recoverable key fails closed', () => {
    const gh = fakeGh({ comments: [autoGrant({ episode: null })] });
    expect(call(deps(gh))).toMatchObject({ action: 'skip', why: expect.stringContaining('recoverable') });
    expect(gh.post).not.toHaveBeenCalled();
  });
  it('(c) the posted record carries its limit-hit key, and the reader requires it to name this PR and head', () => {
    const gh = fakeGh(); call(deps(gh));
    expect(gh.post.mock.calls[0][2]).toContain(`"episode":"${WE}#5654@${HEAD}:review:8/7"`);
    expect(countGrantedRoundExtensions([autoGrant({ episode: `${WE}#5654@${HEAD2}:review:1/0` })], { repo: WE, pr: 5654, standingRuling: scope() })).toBe(0);
    expect(standingRulingGrantEpisodes([autoGrant({ episode: 'x' })], { repo: WE, pr: 5654 })).toEqual({ episodes: [], unrecoverable: 1 });
  });
});

describe('anchor time of an automatic grant', () => {
  it('is GitHub createdAt, never the body at; missing/invalid createdAt is not trusted; manual unchanged', () => {
    const future = { ...autoGrant(), createdAt: '2026-10-20T12:00:00Z' };
    future.body = future.body.replace('"at":"2026-10-20T00:00:00Z"', '"at":"2099-01-01T00:00:00Z"');
    expect(roundExtensionGrants([future], { repo: WE, pr: 5654, standingRuling: scope() })).toEqual([expect.objectContaining({ at: '2026-10-20T12:00:00Z' })]);
    expect(roundExtensionGrants([{ ...autoGrant(), createdAt: undefined }], { repo: WE, pr: 5654, standingRuling: scope() })).toEqual([]);
    expect(roundExtensionGrants([{ ...autoGrant(), createdAt: 'not-a-date' }], { repo: WE, pr: 5654, standingRuling: scope() })).toEqual([]);
    expect(roundExtensionGrants([{ ...manualGrant(), createdAt: '2030-01-01T00:00:00Z' }], { repo: WE, pr: 5654 })).toEqual([expect.objectContaining({ at: '2026-10-20T00:00:00Z' })]);
  });
  it('a future body timestamp cannot make one grant advance the red-team cap as ledger rows grow', () => {
    const future = { ...autoGrant(), createdAt: '2026-10-20T12:00:00Z' };
    future.body = future.body.replace('"at":"2026-10-20T00:00:00Z"', '"at":"2099-01-01T00:00:00Z"');
    const grants = roundExtensionGrants([future], { repo: WE, pr: 5654, standingRuling: scope() });
    // The ledger's round as of the anchor: fixed at 12 for the real post time, growing for any later time.
    for (const reviewedHeads of [12, 13, 20]) {
      const roundAt = (at) => (Date.parse(at) <= Date.parse('2026-10-20T12:00:00Z') ? 12 : reviewedHeads);
      expect(gateRoundCap({ cap: 5, grants, roundAt })).toBe(13);
    }
  });
});

describe('never silently stuck after a grant (live #5690)', () => {
  const T = Date.parse('2026-10-20T12:00:00Z');
  const pr = (labels, comments) => ({ number: 5654, headRefOid: HEAD, labels: labels.map((name) => ({ name })), comments });
  const credit = () => scope();
  it('a PR still at its round limit well after a grant on this head is reported', () => {
    const p = pr(['status:at-round-limit'], [autoGrant()]);
    expect(stuckAfterGrant({ repo: 'we', pr: p }, { scopeOf: credit, now: () => T + STUCK_AFTER_GRANT_MS + 60_000 })).toMatch(/did not free a round/);
    expect(stuckAfterGrant({ repo: 'we', pr: p }, { scopeOf: () => null, now: () => T + STUCK_AFTER_GRANT_MS + 60_000 })).toMatch(/not credited/);
  });
  it('an ordinary commenter mentioning the head cannot postpone an uncredited grant\'s alert', () => {
    const late = T + STUCK_AFTER_GRANT_MS + 60_000;
    const mention = { id: 'IC_m', author: { login: 'mallory' }, createdAt: new Date(late - 1000).toISOString(), body: `see @${HEAD}: please wait` };
    const forged = { ...autoGrant(), author: { login: 'mallory' }, createdAt: new Date(late - 1000).toISOString() };
    const p = pr(['status:at-round-limit'], [autoGrant(), mention, forged]);
    expect(stuckAfterGrant({ repo: 'we', pr: p }, { scopeOf: () => null, now: () => late })).toMatch(/not credited/);
  });
  it('is quiet before the grace, off the round limit, or for another head', () => {
    expect(stuckAfterGrant({ repo: 'we', pr: pr(['status:at-round-limit'], [autoGrant()]) }, { scopeOf: credit, now: () => T + 60_000 })).toBeNull();
    expect(stuckAfterGrant({ repo: 'we', pr: pr(['status:awaiting-review'], [autoGrant()]) }, { scopeOf: credit, now: () => T + 3_600_000 })).toBeNull();
    expect(stuckAfterGrant({ repo: 'we', pr: pr(['status:at-round-limit'], [autoGrant({ head: HEAD2 })]) }, { scopeOf: credit, now: () => T + 3_600_000 })).toBeNull();
  });
  it('the daemon publishes the needs-you for a stuck PR even with no note this pass', () => {
    const publish = vi.fn();
    const tick = () => ({ notes: [], prsByNumber: new Map([[5654, { number: 5654, headRefOid: HEAD, labels: [], comments: [] }]]) });
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, safety: { value: { alertAtRoundCap: true }, sources: {} },
      autoRoundGrant: () => null, stuckAfterGrant: () => 'auto-grant did not free a round: x' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ pr: 5654, kind: 'at-round-limit', reason: 'auto-grant did not free a round: x' }));
  });
});

describe('redaction', () => {
  it('credential-shaped strings never reach the reason', () => {
    const gh = fakeGh(); gh.post.mockImplementation(() => { throw new Error('gh failed: ghp_abcdefghijklmnop'); });
    expect(call(deps(gh)).why).toBe('gh failed: [redacted]');
    expect(redact('x github_pat_ABCDEFGHIJ123 y')).toBe('x [redacted] y');
  });
});

describe('daemon hook (runReconcileNotesAllRepos)', () => {
  const tick = () => ({ notes: [note], prsByNumber: new Map([[5654, { number: 5654, headRefOid: HEAD, labels: [], comments: [] }]]) });
  const safety = { value: { alertAtRoundCap: true }, sources: { alertAtRoundCap: 'test' } };
  it('a grant skips the needs-you event, the note comment and parking', () => {
    const publish = vi.fn(); const postComment = vi.fn(() => ({ ok: true })); const parkToHuman = vi.fn(() => ({ ok: true }));
    const out = runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment, parkToHuman, safety,
      autoRoundGrant: () => ({ action: 'granted', count: 1, max: 3 }) });
    expect(publish).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled(); expect(parkToHuman).not.toHaveBeenCalled();
    expect(out.autoGrants).toEqual([{ repo: 'we', prNumber: 5654, action: 'granted', count: 1, max: 3 }]);
  });
  it('at the cap the event is kept with the cap-reached reason', () => {
    const publish = vi.fn();
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment: () => ({ ok: true }), safety,
      autoRoundGrant: () => ({ action: 'cap-reached', used: 3, max: 3, reason: 'auto-grant cap reached (3/3): x' }) });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'at-round-limit', reason: 'auto-grant cap reached (3/3): x' }));
  });
  it('a throw is redacted and publishes the event unchanged; dry-run never grants', () => {
    const publish = vi.fn();
    const out = runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment: () => ({ ok: true }), safety,
      autoRoundGrant: () => { throw new Error('boom ghs_abcdefghijklmnop'); } });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: note.text }));
    expect(out.autoGrants[0].why).toBe('boom [redacted]');
    const grant = vi.fn();
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: true, publish, safety, autoRoundGrant: grant });
    expect(grant).not.toHaveBeenCalled();
  });
});
