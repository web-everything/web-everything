/**
 * @file scripts/conveyor/__tests__/auto-round-grant.test.mjs
 * @description The automated standing-ruling round grant (operator option B, 2026-10-20): the operator's ruling
 *   record, the narrowed trust rule for automation-posted grants, eligibility (card-only NET diff, repo, note
 *   kind), the per-PR cap (ledger seeded from existing grants + reservations), idempotency, the expected-head check
 *   right before the write, redaction, and the daemon hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_GRANT_CHANNEL, autoGrantKey, countAutoRoundGrants, decideAutoGrant, isCardOnlyNetDiff,
  resolveAutoRoundGrantSettings, screenAutoGrantNote, STANDING_RULING,
} from '../auto-round-grant.mjs';
import { autoRoundGrant, withPrLedger, redact, readPrThread, stuckAfterGrant, STUCK_AFTER_GRANT_MS } from '../auto-round-grant-io.mjs';
import { buildRoundExtensionComment, countGrantedRoundExtensions, countStandingRulingGrantRecords, roundExtensionGrants, standingRulingGrantEpisodes } from '../round-extension-mark.mjs';
import { buildStandingRulingBody, citedGrantHeads, pickStandingRuling, verifyStandingRuling } from '../standing-ruling-mark.mjs';
import { enrichPrsWithStandingRulingGrants, headIsCardOnly, readStandingRuling, readUneditedCommentIds, standingRulingScope } from '../standing-ruling-io.mjs';
import { planRoundExtension } from '../../operations/extend-rounds.mjs';
import { gateRoundCap } from '../../lib/red-team-gate.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

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

describe('complete App thread reads', () => {
  it('includes grants beyond the first page using the same App transport', () => {
    const grant = autoGrant();
    const rows = [...Array.from({ length: 100 }, () => 'filler\t2026-10-20T12:00:00Z\tweb-everything[bot]'),
      `${grant.body.replace(/\n/g, '\\n')}\t${grant.createdAt}\t${grant.author.login}\t${grant.id}`].join('\n');
    const gh = vi.fn((args) => args[0] === 'pr' ? JSON.stringify({ state: 'OPEN', headRefOid: HEAD }) : rows);
    const thread = readPrThread(WE, 5654, { gh });
    expect(thread.comments).toHaveLength(101);
    expect(thread.comments[100]).toMatchObject(grant);
    expect(gh.mock.calls[0][0]).toContain('--paginate');
    expect(gh.mock.calls[0][0]).toContain(`repos/${WE}/issues/5654/comments`);
    expect(gh.mock.calls[1][0]).toContain('state,headRefOid');
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
    const s = standingRulingScope({ repo: WE, pr: { number: 5654, comments: [autoGrant(), autoGrant({ head: HEAD2 })] } }, { readRuling, cardOnly, unedited: () => ['IC_x'] });
    expect(s.cardOnlyHeads).toEqual({ [HEAD]: true, [HEAD2]: false });
    expect(s.uneditedComments).toEqual(['IC_x']);
    expect(citedGrantHeads([autoGrant()])).toEqual([HEAD]);
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

const tmpLedger = () => { const dir = mkdtempSync(join(tmpdir(), 'arg-')); return (slug, pr, fn) => withPrLedger(slug, pr, fn, { dir }); };
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
    expect(call(d)).toMatchObject({ action: 'skip', why: expect.stringMatching(/^already claimed/) });
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
    expect(call(d, later)).toMatchObject({ action: 'skip', why: expect.stringMatching(/^already claimed/) });
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
    expect(call(deps(gh))).toMatchObject({ action: 'skip', why: `already claimed: ${key}` });
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
