import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_REVIEW_MODES, NATIVE_REVIEW_ENV, STANDARD_NATIVE_REVIEW_MODE, EVENT_STATE,
  parseNativeReviewMode, resolveNativeReviewMode, loadNativeReviewMode, planNativeReview,
  normaliseLogin, reviewerBotLogin, isReviewerBotUser, checkReviewerIdentity, findExistingNativeReview, ownStandingReviews,
  nativeReviewBody, formatComparisonLine, mirrorNativeReview, readReviewerToken, fileDismissalQueue, endorsedStates, QUEUE_CLAIM_STALE_MS,
  STANDARD_PROMOTION, resolvePromotionCriteria, loadPromotionCriteria, parseComparisonLine, summarizeReadiness, formatReadinessLine,
  approvalRestorable,
} from '../native-github-review.mjs';

// A write that opens its file, then pauses (running `beforeWrite`) before the bytes land, as appendFileSync and
// writeFileSync do internally. Pass-through while no hook is armed.
const fsHook = vi.hoisted(() => ({ beforeWrite: null }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const paused = (append) => (file, data, options) => {
    const hook = fsHook.beforeWrite;
    if (!hook) return (append ? real.appendFileSync : real.writeFileSync)(file, data, options);
    fsHook.beforeWrite = null;
    const fd = real.openSync(file, append ? 'a' : (options?.flag ?? 'w'));
    try { hook(); real.writeSync(fd, String(data)); } finally { real.closeSync(fd); }
    return undefined;
  };
  const patched = { ...real, appendFileSync: paused(true), writeFileSync: paused(false) };
  return { ...patched, default: patched };
});
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roleCachePath } from '../github-app-identity.mjs';
import { installationCachePath } from '../github-app-installations.mjs';
import { CACHE_VERSION } from '../github-app-auth-env.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { fileURLToPath } from 'node:url';

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const identity = { roles: { reviewer: { botLogin: 'plateau-reviewer[bot]', appId: 2 }, worker: { botLogin: 'web-everything[bot]', appId: 1 } } };
const review = (id, state, commit_id = head, login = 'plateau-reviewer[bot]', type = 'Bot') => ({ id, state, commit_id, user: { login, type } });
const bot = { login: 'plateau-reviewer', type: 'Bot' };
const author = { login: 'web-everything[bot]', type: 'Bot' };
const throws = () => { throw new Error('unreadable'); };
// The labels a verdict leaves live once review-set-label has swapped them (decideSetLabel): the state label replaced,
// review:human kept, except that clear-human lifts it and a review:human re-arm adds no review:pending.
const LABEL_FOR = { accepted: 'review:accepted', changes: 'review:changes', rearm: 'review:pending', restamp: 'review:accepted', 'clear-human': 'review:accepted' };
const liveLabelsFor = (verdict = 'accepted', kept = []) => {
  const names = kept.map(l => (typeof l === 'string' ? l : l.name))
    .filter(n => !['review:accepted', 'review:changes', 'review:pending'].includes(n) && !(verdict === 'clear-human' && n === 'review:human'));
  if (verdict === 'rearm' && names.includes('review:human')) return names;
  return [...names, ...(LABEL_FOR[verdict] ? [LABEL_FOR[verdict]] : [])];
};
function fixture(options = {}, responses = {}) {
  const calls = [];
  const log = vi.fn();
  const appendLog = vi.fn();
  const exec = (argv) => {
    calls.push(argv);
    if (argv.includes('POST')) {
      if (responses.postError) throw responses.postError;
      return '{}';
    }
    if (argv.includes('PUT')) {
      if (responses.dismissError) throw responses.dismissError;
      return '{}';
    }
    if (argv.includes('graphql')) return responses.viewer ?? 'Bot plateau-reviewer\n';
    if (argv.includes('--paginate')) {
      if (responses.reviewsError) throw responses.reviewsError;
      return responses.reviewsRaw ?? (responses.reviews ?? []).map(JSON.stringify).join('\n');
    }
    if (responses.prError) throw responses.prError;
    return responses.prRaw ?? JSON.stringify({ head: responses.head ?? head, author: responses.author ?? 'web-everything[bot]', authorType: responses.authorType ?? 'Bot', state: responses.state ?? 'open', labels: responses.labels ?? liveLabelsFor(options.verdict, options.labels) });
  };
  const result = mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'accepted', headSha: head, env: { WE_UNDER_TEST: '1' }, exec, identity, mode: { mode: 'mirror', source: 'tool' }, log, appendLog, ...options });
  return { result, calls, log, appendLog, posts: calls.filter(a => a.includes('POST')), puts: calls.filter(a => a.includes('PUT')) };
}
afterEach(() => vi.restoreAllMocks());

describe('native review policy and mapping', () => {
  it('declares frozen modes and states', () => {
    expect(NATIVE_REVIEW_MODES).toEqual(['off', 'mirror', 'authoritative']);
    expect(Object.isFrozen(NATIVE_REVIEW_MODES)).toBe(true);
    expect(STANDARD_NATIVE_REVIEW_MODE).toBe('off');
    expect(EVENT_STATE).toEqual({ APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' });
    expect(Object.isFrozen(EVENT_STATE)).toBe(true);
  });
  it.each([[' Mirror ', 'mirror'], ['AUTHORITATIVE', 'authoritative'], ['off', 'off'], ['bad', null], [undefined, null]])('parses %s', (value, expected) => expect(parseNativeReviewMode(value)).toBe(expected));
  it('resolves each layer with provenance', () => {
    expect(resolveNativeReviewMode()).toEqual({ mode: 'off', source: 'standard', invalid: [] });
    expect(resolveNativeReviewMode({ platform: { nativeGithubReview: 'mirror' } }).source).toBe('platform');
    expect(resolveNativeReviewMode({ platform: { nativeGithubReview: 'mirror' }, tool: { nativeGithubReview: 'authoritative' } })).toEqual({ mode: 'authoritative', source: 'tool', invalid: [] });
    expect(resolveNativeReviewMode({ tool: { nativeGithubReview: 'mirror' }, env: { [NATIVE_REVIEW_ENV]: 'off' } })).toEqual({ mode: 'off', source: 'env', invalid: [] });
  });
  it('skips empty and invalid layers without overriding valid lower layers', () => {
    expect(resolveNativeReviewMode({ platform: { nativeGithubReview: 'mirror' }, tool: { nativeGithubReview: 'x' }, env: { [NATIVE_REVIEW_ENV]: 'y' } })).toEqual({ mode: 'mirror', source: 'platform', invalid: ['tool.nativeGithubReview="x"', 'env.nativeGithubReview="y"'] });
    expect(resolveNativeReviewMode({ platform: { nativeGithubReview: 'x' }, tool: { nativeGithubReview: '   ' } })).toEqual({ mode: 'off', source: 'standard', invalid: ['platform.nativeGithubReview="x"'] });
  });
  it('loads injected readers and tolerates either reader throwing', () => {
    expect(loadNativeReviewMode({ env: {}, readPlatform: () => ({ nativeGithubReview: 'mirror' }), readTool: throws }).source).toBe('platform');
    expect(loadNativeReviewMode({ env: {}, readPlatform: throws, readTool: () => ({ nativeGithubReview: 'authoritative' }) }).source).toBe('tool');
    expect(loadNativeReviewMode({ env: {}, readPlatform: throws, readTool: throws }).mode).toBe('off');
  });
  it('the declared repo settings turn the standard off into mirror (tool layer)', () => {
    expect(loadNativeReviewMode({ env: {}, readPlatform: () => undefined })).toEqual({ mode: 'mirror', source: 'tool', invalid: [] });
  });
  it.each([
    ['accepted', 'APPROVE', ['CHANGES_REQUESTED']], ['changes', 'REQUEST_CHANGES', ['APPROVED']], ['advisory', 'COMMENT', []],
    ['clear-human', null, ['CHANGES_REQUESTED']], ['rearm', null, ['APPROVED', 'CHANGES_REQUESTED']], ['restamp', null, ['APPROVED', 'CHANGES_REQUESTED']],
  ])('maps %s', (verdict, event, dismiss) => {
    expect(planNativeReview({ verdict, headSha: head })).toMatchObject({ event, dismiss });
  });
  it.each([['review:human'], [{ name: 'review:human' }]])('keeps human approvals with the operator: %j', label => {
    expect(planNativeReview({ verdict: 'accepted', headSha: head, labels: [label] })).toEqual({ event: 'COMMENT', dismiss: ['APPROVED', 'CHANGES_REQUESTED'], reason: 'human-review: the approval must come from the operator' });
  });
  it('ignores anything that is not a verdict', () => expect(planNativeReview({ verdict: 'bogus', headSha: head })).toEqual({ event: null, dismiss: [], reason: 'not-a-review-verdict' }));
  it.each([undefined, 'bad', 'A'.repeat(40), 'a'.repeat(39)])('requires a reviewed head: %s', headSha => expect(planNativeReview({ verdict: 'accepted', headSha })).toEqual({ event: null, dismiss: [], reason: 'no-reviewed-head' }));
});

describe('identity and review history', () => {
  it('normalises app logins', () => expect(normaliseLogin(' APP/Plateau-Reviewer[bot] ')).toBe('plateau-reviewer'));
  it.each([['plateau-reviewer[bot]', 'plateau-reviewer[bot]'], [' Plateau-Reviewer ', 'plateau-reviewer[bot]'], ['app/plateau-reviewer', 'plateau-reviewer[bot]'], ['bad login', null], ['', null]])('the configured reviewer App %j is the exact REST login %j', (configured, exact) => {
    expect(reviewerBotLogin(configured)).toBe(exact);
  });
  const failures = [
    [{}, 'Bot plateau-reviewer', 'reviewer-role-unconfigured'],
    [{ roles: { reviewer: {} } }, 'Bot plateau-reviewer', 'reviewer-bot-login-unknown'],
    [{ roles: { reviewer: { botLogin: 'web-everything[bot]' } } }, 'Bot web-everything', 'reviewer-is-shared-app'],
    [{ roles: { reviewer: { botLogin: 'plateau-reviewer', appId: 1 }, worker: { appId: 1 } } }, 'Bot plateau-reviewer', 'reviewer-is-shared-app'],
    [{ roles: { reviewer: { botLogin: 'plateau-reviewer' }, worker: { botLogin: 'app/plateau-reviewer[bot]' } } }, 'Bot plateau-reviewer', 'reviewer-is-shared-app'],
    [identity, '', 'viewer-unreadable'],
    [identity, 'Bot web-everything', 'token-is-not-reviewer (viewer=web-everything Bot)'],
  ];
  it.each(failures)('fails closed for %j / %s', (configured, viewer, reason) => {
    const [type, login] = viewer ? viewer.split(' ') : ['', ''];
    expect(checkReviewerIdentity({ identity: configured, viewer: { login, type }, prAuthor: { login: 'operator', type: 'User' } })).toMatchObject({ ok: false, reason });
    const f = fixture({ identity: configured }, { viewer });
    expect(f.result).toMatchObject({ outcome: 'skipped', reason });
    expect(f.posts).toHaveLength(0);
    expect(f.puts).toHaveLength(0);
  });
  // Operator send-back #4 (2026-10-13): a human account whose login normalises to the reviewer App's never IS it.
  it.each([
    ['plateau-reviewer', 'User'], ['Plateau-Reviewer', 'User'], ['plateau-reviewer[bot]', 'User'], ['app/plateau-reviewer', 'Bot'], ['Plateau-Reviewer', 'Bot'],
  ])('refuses a live token whose viewer %j (%s) only normalises to the reviewer App', (login, type) => {
    expect(normaliseLogin(login)).toBe('plateau-reviewer');
    expect(checkReviewerIdentity({ identity, viewer: { login, type }, prAuthor: author })).toMatchObject({ ok: false, reason: expect.stringMatching(/^token-is-not-reviewer/) });
    const f = fixture({}, { viewer: `${type} ${login}` });
    expect(f.result.outcome).toBe('skipped');
    expect(f.posts).toHaveLength(0);
  });
  it('compares the viewer exactly: padding is not trimmed away inside the identity check', () => {
    expect(checkReviewerIdentity({ identity, viewer: { login: 'plateau-reviewer ', type: 'Bot' }, prAuthor: author }).ok).toBe(false);
    expect(checkReviewerIdentity({ identity, viewer: { login: 'plateau-reviewer', type: 'bot' }, prAuthor: author }).ok).toBe(false);
  });
  it('a human review whose login normalises to the reviewer App is never ours: no dedupe, no dismissal', () => {
    const human = [review(7, 'APPROVED', head, 'plateau-reviewer', 'User'), review(8, 'CHANGES_REQUESTED', head, 'Plateau-Reviewer', 'User'), review(9, 'APPROVED', head, 'plateau-reviewer[bot]', 'User')];
    expect(human.every(r => !isReviewerBotUser(r.user, 'plateau-reviewer[bot]'))).toBe(true);
    expect(findExistingNativeReview({ reviews: human, head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer[bot]' })).toBeNull();
    expect(ownStandingReviews({ reviews: human, reviewerLogin: 'plateau-reviewer[bot]', states: ['APPROVED', 'CHANGES_REQUESTED'] })).toEqual([]);
    const f = fixture({}, { reviews: human });
    expect(f.result.outcome).toBe('posted');
    expect(f.puts).toHaveLength(0);
    expect(fixture({ verdict: 'rearm' }, { reviews: human }).puts).toHaveLength(0);
  });
  it('refuses the PR author (the exact App), but not a human with the same name', () => {
    const f = fixture({}, { author: 'plateau-reviewer[bot]', authorType: 'Bot' });
    expect(f.result.reason).toBe('reviewer-is-pr-author');
    expect(f.posts).toHaveLength(0);
    expect(fixture({}, { author: 'plateau-reviewer', authorType: 'User' }).result.outcome).toBe('posted');
  });
  it.each([['plateau-reviewer'], ['plateau-reviewer[bot]']])('accepts the separate reviewer App as viewer %s', login => expect(checkReviewerIdentity({ identity, viewer: { login, type: 'Bot' }, prAuthor: author })).toEqual({ ok: true, reviewerLogin: 'plateau-reviewer[bot]' }));
  it('matches the latest decisive review by author, head and state', () => {
    const reviews = [review(1, 'APPROVED', otherHead), review(2, 'APPROVED', head, 'other'), review(3, 'COMMENTED'), review(4, 'APPROVED'), review(5, 'APPROVED')];
    expect(findExistingNativeReview({ reviews, head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer[bot]' })).toBe(reviews[4]);
    expect(findExistingNativeReview({ reviews, head, event: 'REQUEST_CHANGES', reviewerLogin: 'plateau-reviewer[bot]' })).toBeNull();
  });
  it('does not reuse a verdict superseded on another head', () => {
    const reviews = [review(7, 'APPROVED'), review(9, 'CHANGES_REQUESTED', otherHead)];
    expect(findExistingNativeReview({ reviews, head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer[bot]' })).toBeNull();
  });
  it('keeps comment idempotency independent of decisive reviews', () => {
    const reviews = [review(7, 'COMMENTED'), review(9, 'APPROVED')];
    expect(findExistingNativeReview({ reviews, head, event: 'COMMENT', reviewerLogin: 'plateau-reviewer[bot]' })).toBe(reviews[0]);
  });
  it('a later dismissal means nothing of ours stands: never reported already-posted', () => {
    const reviews = [review(7, 'CHANGES_REQUESTED'), review(9, 'APPROVED'), review(10, 'COMMENTED'), review(11, 'DISMISSED'), review(12, 'CHANGES_REQUESTED', head, 'other')];
    expect(findExistingNativeReview({ reviews, head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer[bot]' })).toBeNull();
    expect(findExistingNativeReview({ reviews: reviews.filter(r => r.id !== 11), head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer[bot]' })).toBe(reviews[1]);
  });
  it('lists only own standing numeric ids of the asked states across heads', () => {
    const reviews = [review(1, 'CHANGES_REQUESTED'), review(2, 'CHANGES_REQUESTED', otherHead), review(3, 'DISMISSED'), review(4, 'CHANGES_REQUESTED', head, 'other'), review(5, 'APPROVED')];
    expect(ownStandingReviews({ reviews, reviewerLogin: 'plateau-reviewer[bot]', states: ['CHANGES_REQUESTED'] })).toEqual([1, 2]);
    expect(ownStandingReviews({ reviews, reviewerLogin: 'plateau-reviewer[bot]', states: ['APPROVED', 'CHANGES_REQUESTED'] })).toEqual([1, 2, 5]);
    expect(ownStandingReviews({ reviews, reviewerLogin: '', states: ['CHANGES_REQUESTED'] })).toEqual([]);
  });
});

describe('body and comparison', () => {
  it.each([['accepted', 'APPROVE', 'review:accepted'], ['changes', 'REQUEST_CHANGES', 'the findings are in the verdict comment'], ['advisory', 'COMMENT', "operator's own approval is required"]])('builds %s body and marker', (verdict, event, text) => {
    const body = nativeReviewBody({ verdict, event, head });
    expect(body).toContain(text);
    expect(body.split('\n').at(-1)).toBe(`<!-- native-review: ${JSON.stringify({ head, verdict, event })} -->`);
  });
  it.each([['posted', 'APPROVE', 'yes'], ['already-posted', 'COMMENT', 'yes'], ['skipped', 'APPROVE', 'no'], ['failed', 'APPROVE', 'no'], ['dismissed', null, 'n/a']])('compares %s', (outcome, event, agree) => {
    expect(formatComparisonLine({ repo: 'o/r', pr: 1, head, labelVerdict: 'accepted', event, outcome, reason: ' a\n b ', mode: 'mirror', source: 'tool' })).toBe(`native-review: repo=o/r pr=1 head=${head.slice(0, 12)} label=accepted native=${event ?? 'none'} outcome=${outcome} agree=${agree} mode=mirror(tool) reason=a b`);
  });
});

describe('synchronous mirror shell', () => {
  it('posts one pinned approval and emits both comparison logs', () => {
    const f = fixture();
    expect(f.result.outcome).toBe('posted');
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toEqual(['api', '--method', 'POST', 'repos/owner/repo/pulls/123/reviews', '-f', `commit_id=${head}`, '-f', 'event=APPROVE', '-f', `body=${nativeReviewBody({ verdict: 'accepted', event: 'APPROVE', head })}`]);
    expect(f.calls[0]).toEqual(['api', 'repos/owner/repo/pulls/123', '--jq', '{head: .head.sha, author: .user.login, authorType: .user.type, state: .state, labels: [.labels[].name]}']);
    expect(f.calls[1]).toEqual(['api', 'graphql', '-f', 'query=query{viewer{__typename login}}', '--jq', '.data.viewer | "\\(.__typename) \\(.login)"']);
    expect(f.calls[2]).toEqual(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/owner/repo/pulls/123/reviews', '--jq', '.[] | {id, state, commit_id, user: {login: (.user.login // ""), type: (.user.type // "")}}']);
    expect(f.result.line).toMatch(/^native-review: /);
    expect(f.result.line).toContain('label=accepted native=APPROVE outcome=posted agree=yes mode=mirror(tool)');
    expect(f.log).toHaveBeenCalledWith(f.result.line);
    expect(f.appendLog).toHaveBeenCalledWith(f.result.line);
  });
  it.each([{ head: otherHead }, { state: 'closed' }, { prError: new Error('read failed') }, { prRaw: 'bad json' }])('refuses an unproven live PR: %j', responses => {
    const f = fixture({}, responses);
    expect(f.result.outcome).toBe('skipped');
    if (responses.head) expect(f.result.reason).toBe(`head-moved (live=${otherHead.slice(0, 12)})`);
    if (responses.state) expect(f.result.reason).toBe('pr-not-open');
    expect(f.posts).toHaveLength(0);
    expect(f.puts).toHaveLength(0);
  });
  it.each([['APPROVED', head, 'already-posted', 0], ['APPROVED', otherHead, 'posted', 1], ['COMMENTED', head, 'posted', 1]])('deduplicates %s on %s', (state, commit, outcome, posts) => {
    const f = fixture({}, { reviews: [review(7, state, commit)] });
    expect(f.result.outcome).toBe(outcome);
    expect(f.posts).toHaveLength(posts);
  });
  it.each([
    ['accepted', 'APPROVED', 'CHANGES_REQUESTED', 'APPROVE'],
    ['changes', 'CHANGES_REQUESTED', 'APPROVED', 'REQUEST_CHANGES'],
  ])('reposts %s after an intervening opposite verdict on the same head', (verdict, initial, opposite, event) => {
    // Deliberately unordered: review IDs, not array position, define recency.
    const f = fixture({ verdict }, { reviews: [review(9, opposite), review(7, initial), review(10, 'COMMENTED'), review(11, 'DISMISSED')] });
    expect(f.result.outcome).toBe('posted');
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toContain(`event=${event}`);
    expect(f.result.line).toContain(`native=${event} outcome=posted agree=yes`);
  });
  it('clear-human dismisses only own holds without posting', () => {
    const f = fixture({ verdict: 'clear-human' }, { reviews: [review(7, 'CHANGES_REQUESTED'), review(8, 'CHANGES_REQUESTED', head, 'other')] });
    expect(f.posts).toHaveLength(0);
    expect(f.puts).toEqual([['api', '--method', 'PUT', 'repos/owner/repo/pulls/123/reviews/7/dismissals', '-f', 'event=DISMISS', '-f', `message=Superseded: our review verdict is now clear-human on ${head.slice(0, 12)}.`]]);
    expect(f.result).toMatchObject({ outcome: 'dismissed', dismissed: 1, event: null });
  });
  it('clear-human with no holds is not applicable and emits no log', () => {
    const f = fixture({ verdict: 'clear-human' });
    expect(f.result).toMatchObject({ outcome: 'not-applicable', dismissed: 0, line: '' });
    expect(f.log).not.toHaveBeenCalled();
  });
  it.each(['posted', 'already-posted'])('an approval %s lifts holds without dismissal', outcome => {
    const f = fixture({}, { reviews: [review(7, 'CHANGES_REQUESTED'), ...(outcome === 'already-posted' ? [review(8, 'APPROVED')] : [])] });
    expect(f.result.outcome).toBe(outcome);
    expect(f.puts).toHaveLength(0);
  });
  it('head movement prevents posting, never the dismissal of our own review', () => {
    expect(fixture({}, { head: otherHead, reviews: [review(7, 'CHANGES_REQUESTED')] })).toMatchObject({ posts: [], puts: [] });
    for (const verdict of ['clear-human', 'rearm']) {
      const f = fixture({ verdict }, { head: otherHead, reviews: [review(7, 'CHANGES_REQUESTED')] });
      expect(f.puts).toHaveLength(1);
      expect(f.result.outcome).toBe('dismissed');
    }
  });
  it('a deleted account\'s review (user null) is nobody\'s, not an unreadable history', () => {
    const f = fixture({ verdict: 'rearm' }, { reviewsRaw: [JSON.stringify({ id: 6, state: 'APPROVED', commit_id: head, user: { login: '', type: '' } }), JSON.stringify(review(7, 'APPROVED'))].join('\n') });
    expect(f.result).toMatchObject({ outcome: 'dismissed', dismissed: 1 });
  });
  it('human accepted posts a comment and dismisses a prior own hold', () => {
    const f = fixture({ labels: ['review:human'] }, { reviews: [review(7, 'CHANGES_REQUESTED')] });
    expect(f.posts[0]).toContain('event=COMMENT');
    expect(f.puts).toHaveLength(1);
  });
  it('records dismissal failures, continues other dismissals and counts as disagreement', () => {
    const f = fixture({ verdict: 'clear-human' }, { reviews: [review(7, 'CHANGES_REQUESTED'), review(8, 'CHANGES_REQUESTED')], dismissError: new Error('denied') });
    expect(f.puts).toHaveLength(2);
    expect(f.result.reason).toContain('denied');
    expect(f.result).toMatchObject({ outcome: 'failed', dismissed: 0 });
    expect(f.result.line).toContain('agree=no dismissal=failed');
  });
  // Operator send-back #2: a pending label never sits beside a standing bot APPROVE or REQUEST_CHANGES.
  it.each(['rearm', 'restamp'])('%s dismisses every standing review of ours, approval and change request alike', verdict => {
    const f = fixture({ verdict }, { reviews: [review(5, 'APPROVED', otherHead), review(7, 'CHANGES_REQUESTED'), review(8, 'APPROVED'), review(9, 'DISMISSED'), review(10, 'COMMENTED'), review(11, 'APPROVED', head, 'other', 'User')] });
    expect(f.posts).toHaveLength(0);
    expect(f.puts.map(a => a[3])).toEqual([5, 7, 8].map(id => `repos/owner/repo/pulls/123/reviews/${id}/dismissals`));
    expect(f.result).toMatchObject({ outcome: 'dismissed', dismissed: 3, event: null });
    expect(f.result.line).toContain(`label=${verdict} native=none outcome=dismissed agree=n/a dismissal=ok`);
  });
  it('a changes verdict whose request did not land dismisses our standing approval', () => {
    const f = fixture({ verdict: 'changes' }, { reviews: [review(7, 'APPROVED')], postError: new Error('boom') });
    expect(f.result.outcome).toBe('failed');
    expect(f.puts).toHaveLength(1);
    expect(fixture({ verdict: 'changes' }, { reviews: [review(7, 'APPROVED')] }).puts).toHaveLength(0);
  });
  it('a review:human accept also dismisses a standing bot approval', () => {
    const f = fixture({ labels: ['review:human'] }, { reviews: [review(7, 'APPROVED'), review(8, 'CHANGES_REQUESTED')] });
    expect(f.posts[0]).toContain('event=COMMENT');
    expect(f.puts).toHaveLength(2);
  });
});

/** A fake GitHub: one PR whose review list the mirror reads, posts to and dismisses on, so a verdict SEQUENCE is real. */
function fakeGithub({ viewer = 'Bot plateau-reviewer', labels = [] } = {}) {
  const reviews = [];
  let nextId = 100;
  // The PR's live labels, mutable so a test can swap them the way review-set-label does before it mirrors.
  const gh = { labels };
  const exec = (argv) => {
    if (argv.includes('POST')) {
      const field = name => argv.find(a => a.startsWith(`${name}=`)).slice(name.length + 1);
      reviews.push(review(nextId++, { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[field('event')], field('commit_id')));
      return '{}';
    }
    if (argv.includes('PUT')) {
      const id = Number(/reviews\/(\d+)\/dismissals$/.exec(argv[3])[1]);
      reviews.find(r => r.id === id).state = 'DISMISSED';
      return '{}';
    }
    if (argv.includes('graphql')) return viewer;
    if (/\/issues\/\d+$/.test(argv[1])) return JSON.stringify(gh.labels);
    if (argv.includes('--paginate')) return reviews.map(JSON.stringify).join('\n');
    return JSON.stringify({ head, author: 'web-everything[bot]', authorType: 'Bot', state: 'open', labels: gh.labels });
  };
  // GitHub's standing verdict of one reviewer: its latest opinionated review, unless that one was dismissed.
  const standing = () => {
    const latest = reviews.filter(r => r.state !== 'COMMENTED').sort((a, b) => b.id - a.id)[0];
    return latest && latest.state !== 'DISMISSED' ? latest.state : 'none';
  };
  return Object.assign(gh, { reviews, exec, standing });
}
const NATIVE_FOR_LABEL = { accepted: 'APPROVED', changes: 'CHANGES_REQUESTED', rearm: 'none', restamp: 'none', 'clear-human': 'none' };

describe('verdict sequences on one head (operator send-back #1 and #2)', () => {
  // As review-set-label does: swap the label first, then mirror.
  const step = (gh, verdict, extra = {}) => {
    gh.labels = liveLabelsFor(verdict);
    return mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict, headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, ...extra });
  };
  it.each([
    [['accepted', 'changes', 'accepted']],
    [['changes', 'accepted', 'changes']],
    [['accepted', 'rearm', 'accepted']],
    [['changes', 'rearm', 'changes']],
    [['accepted', 'changes', 'rearm', 'accepted', 'changes', 'accepted']],
    [['changes', 'clear-human', 'changes']],
  ])('GitHub ends every step of %j agreeing with the label, and the log never claims a false agreement', (sequence) => {
    const gh = fakeGithub();
    for (const verdict of sequence) {
      const result = step(gh, verdict);
      expect(gh.standing(), `after ${verdict}`).toBe(NATIVE_FOR_LABEL[verdict]);
      if (verdict === 'accepted' || verdict === 'changes') {
        expect(result.outcome, `after ${verdict}`).toBe('posted');
        expect(result.line).toContain('agree=yes');
      }
    }
  });
  it('a repeated verdict with nothing in between is still deduplicated', () => {
    const gh = fakeGithub();
    expect(step(gh, 'accepted').outcome).toBe('posted');
    expect(step(gh, 'accepted').outcome).toBe('already-posted');
    expect(gh.reviews).toHaveLength(1);
  });
});

/** Red team x1b8hlo: a superseded run never overwrites the newer verdict's native review, at any point it resumes. */
describe('a stale verdict never overwrites a newer one on the same head', () => {
  const mirror = (gh, verdict, extra = {}) => mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict, headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, ...extra });
  // Run B: swap the label to its verdict, then mirror it, all while run A is paused.
  const runB = (gh, verdict) => { gh.labels = liveLabelsFor(verdict); return mirror(gh, verdict); };
  // Run A paused right before its first write of `kind` (POST or PUT): run B goes through in full, then A writes.
  const pausedBefore = (gh, kind, verdictB) => {
    let fired = false;
    return { ...gh, exec: (argv) => { if (!fired && argv.includes(kind)) { fired = true; runB(gh, verdictB); } return gh.exec(argv); } };
  };

  it.each([
    ['accepted', 'changes'], ['changes', 'accepted'], ['accepted', 'rearm'], ['changes', 'rearm'],
    ['rearm', 'changes'], ['rearm', 'accepted'], ['clear-human', 'changes'], ['restamp', 'changes'],
  ])('A=%s paused before mirroring, B=%s mirrors first: A writes nothing, GitHub keeps B', (verdictA, verdictB) => {
    const gh = fakeGithub({ labels: liveLabelsFor(verdictA) });
    gh.reviews.push(review(7, verdictA === 'changes' ? 'APPROVED' : 'CHANGES_REQUESTED'));
    runB(gh, verdictB);
    const before = JSON.stringify(gh.reviews);
    const a = mirror(gh, verdictA);
    expect(JSON.stringify(gh.reviews)).toBe(before);
    expect(gh.standing()).toBe(NATIVE_FOR_LABEL[verdictB]);
    expect(a.outcome).toBe('superseded');
    expect(a.line).toContain('agree=n/a');
    expect(a.reason).toContain(`verdict-superseded (live=${LABEL_FOR[verdictB]})`);
  });

  it.each([['accepted', 'changes'], ['changes', 'accepted'], ['accepted', 'rearm'], ['changes', 'rearm']])(
    'A=%s paused between reading the label and posting, B=%s mirrors meanwhile: A restores B on GitHub', (verdictA, verdictB) => {
      const gh = fakeGithub({ labels: liveLabelsFor(verdictA) });
      const a = mirror(pausedBefore(gh, 'POST', verdictB), verdictA);
      expect(gh.standing()).toBe(NATIVE_FOR_LABEL[verdictB]);
      expect(gh.labels).toEqual(liveLabelsFor(verdictB));
      expect(a.outcome).toBe('superseded');
      expect(a.reason).toContain(`verdict-superseded after write (live=${LABEL_FOR[verdictB]})`);
      expect(a.line).not.toContain('agree=yes');
    });

  it('A=rearm paused before dismissing, B=changes reuses the standing request meanwhile: A puts it back', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('rearm') });
    gh.reviews.push(review(7, 'CHANGES_REQUESTED'));
    const a = mirror(pausedBefore(gh, 'PUT', 'changes'), 'rearm');
    expect(gh.standing()).toBe('CHANGES_REQUESTED');
    expect(a.outcome).toBe('superseded');
    expect(a.reason).toContain('reconciled: posted REQUEST_CHANGES');
  });

  it('labels that keep moving after a write are reported as a failure, never as agreement', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('accepted') });
    const flip = ['changes', 'accepted', 'changes', 'accepted', 'changes'];
    let posts = 0;
    const churn = { ...gh, exec: (argv) => { const out = gh.exec(argv); if (argv.includes('POST')) gh.labels = liveLabelsFor(flip[posts++] ?? 'changes'); return out; } };
    const a = mirror(churn, 'accepted');
    expect(a.outcome).toBe('failed');
    expect(a.reason).toContain('labels kept moving');
    expect(a.line).toContain('agree=no');
  });

  // Self-review must-fix: a review:human re-arm leaves only review:human live, never review:pending.
  it.each([
    ['told by the caller', { swappedLabels: ['review:human'] }],
    ['derived from the pre-swap labels', {}],
  ])('a re-arm on a review:human PR is current (%s) and dismisses our change request', (_, extra) => {
    const f = fixture({ verdict: 'rearm', labels: ['review:changes', 'review:human'], ...extra }, { labels: ['review:human'], reviews: [review(7, 'CHANGES_REQUESTED')] });
    expect(f.result).toMatchObject({ outcome: 'dismissed', dismissed: 1 });
    expect(f.puts).toHaveLength(1);
  });

  it('the caller\'s swappedLabels win: a live label other than what this run\'s swap left is superseded', () => {
    const f = fixture({ verdict: 'accepted', swappedLabels: ['review:accepted'] }, { labels: ['review:accepted', 'review:human'] });
    expect(f.result.outcome).toBe('superseded');
    expect(f.posts).toHaveLength(0);
  });

  it('a POST that errors but landed is still re-checked, and a newer verdict is put back', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('accepted') });
    let fired = false;
    const landedThenFailed = (argv) => {
      if (!fired && argv.includes('POST')) {
        fired = true;
        runB(gh, 'changes');
        gh.exec(argv);
        throw Object.assign(new Error('timeout'), { stderr: 'gateway timeout' });
      }
      return gh.exec(argv);
    };
    const a = mirror({ ...gh, exec: landedThenFailed }, 'accepted');
    expect(gh.standing()).toBe('CHANGES_REQUESTED');
    expect(a.outcome).toBe('superseded');
    expect(a.reason).toContain('gateway timeout');
  });

  // Red team on 5257ced00 (#5223): a stale run's reconcile read clear-human's review:accepted as a reviewer acceptance.
  it('A=changes under review:human paused before posting, the operator clears the hold meanwhile: A never approves', () => {
    const gh = fakeGithub({ labels: ['review:changes', 'review:human'] });
    let fired = false;
    const paused = (argv) => {
      if (!fired && argv.includes('POST')) {
        fired = true;
        gh.labels = ['review:accepted'];
        const operator = (a) => (a.includes('graphql') ? 'User chalbert' : gh.exec(a));
        mirror({ ...gh, exec: operator }, 'clear-human', { labels: ['review:changes', 'review:human'], reviewerExec: () => ({ reason: 'none' }) });
      }
      return gh.exec(argv);
    };
    const a = mirror({ ...gh, exec: paused }, 'changes', { labels: ['review:pending', 'review:human'] });
    expect(gh.reviews.filter(r => r.state === 'APPROVED')).toHaveLength(0);
    expect(gh.standing()).toBe('none');
    expect(a.outcome).toBe('superseded');
    expect(a.reason).toContain('no APPROVE');
    expect(a.reason).toMatch(/dismissed \d+/);
  });

  it('a reconcile never originates an approval no reviewer run posted (an accept under the worker token)', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('changes') });
    let fired = false;
    const paused = (argv) => {
      if (!fired && argv.includes('POST')) {
        fired = true;
        gh.labels = liveLabelsFor('accepted');
        mirror({ ...gh, exec: a => (a.includes('graphql') ? 'Bot web-everything' : gh.exec(a)) }, 'accepted', { reviewerExec: () => ({ reason: 'none' }) });
      }
      return gh.exec(argv);
    };
    const a = mirror({ ...gh, exec: paused }, 'changes');
    expect(gh.reviews.filter(r => r.state === 'APPROVED')).toHaveLength(0);
    expect(gh.standing()).toBe('none');
    expect(a.reason).toContain('no APPROVE');
  });

  it('approvalRestorable: only the approval that stood before the write, or one posted since, never under the human hold', () => {
    const login = 'plateau-reviewer[bot]';
    const base = { head, reviewerLogin: login, sawHuman: false };
    expect(approvalRestorable({ ...base, seenReviews: [review(5, 'APPROVED')], reviews: [review(5, 'APPROVED'), review(6, 'CHANGES_REQUESTED')] })).toBe(true);
    expect(approvalRestorable({ ...base, seenReviews: [], reviews: [review(6, 'APPROVED'), review(7, 'CHANGES_REQUESTED')] })).toBe(true);
    expect(approvalRestorable({ ...base, sawHuman: true, seenReviews: [review(5, 'APPROVED')], reviews: [review(5, 'APPROVED')] })).toBe(false);
    expect(approvalRestorable({ ...base, seenReviews: [review(4, 'APPROVED'), review(5, 'DISMISSED')], reviews: [review(4, 'APPROVED'), review(5, 'DISMISSED')] })).toBe(false);
    expect(approvalRestorable({ ...base, seenReviews: [review(5, 'APPROVED', otherHead)], reviews: [review(5, 'APPROVED', otherHead)] })).toBe(false);
    expect(approvalRestorable({ ...base, seenReviews: [], reviews: [review(6, 'APPROVED', head, 'plateau-reviewer', 'User')] })).toBe(false);
  });

  it('reconcile never writes on a PR that closed meanwhile', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('accepted') });
    let reads = 0;
    const closing = (argv) => {
      const out = gh.exec(argv);
      if (argv.includes('POST')) gh.labels = liveLabelsFor('changes');
      if (argv[1] === 'repos/owner/repo/pulls/123' && reads++ > 0) return JSON.stringify({ ...JSON.parse(out), state: 'closed' });
      return out;
    };
    const a = mirror({ ...gh, exec: closing }, 'accepted');
    expect(gh.reviews).toHaveLength(1);
    expect(a.reason).toContain('nothing: pr-not-open');
  });

  it('fails closed when the live labels cannot be read', () => {
    const f = fixture({}, { prRaw: JSON.stringify({ head, author: 'web-everything[bot]', authorType: 'Bot', state: 'open' }) });
    expect(f.result).toMatchObject({ outcome: 'skipped', reason: 'pr-unreadable' });
    expect(f.posts).toHaveLength(0);
  });

  it('a superseded line is neither mirrored nor a mismatch in the readiness count', () => {
    const lines = [formatComparisonLine({ repo: 'o/r', pr: 1, head, labelVerdict: 'accepted', event: 'APPROVE', outcome: 'superseded', reason: 'verdict-superseded (live=review:changes)', mode: 'mirror', source: 'tool' })];
    expect(summarizeReadiness(lines, { minMirroredVerdicts: 1, maxMismatches: 0 })).toMatchObject({ mirrored: 0, mismatches: 0 });
  });
});

describe('clearing under a token that is not the reviewer App (operator send-back #3)', () => {
  const operator = 'User chalbert';
  it('clear-human run by the operator dismisses our change request with the minted reviewer token', () => {
    const gh = fakeGithub({ viewer: operator, labels: liveLabelsFor('clear-human') });
    gh.reviews.push(review(7, 'CHANGES_REQUESTED'));
    const reviewerGh = { ...gh, calls: [] };
    const asReviewer = (argv) => { reviewerGh.calls.push(argv); return argv.includes('graphql') ? 'Bot plateau-reviewer' : gh.exec(argv); };
    const minted = vi.fn(() => ({ exec: asReviewer }));
    const result = mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'clear-human', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, reviewerExec: minted });
    expect(minted).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', identity }));
    expect(reviewerGh.calls.filter(a => a.includes('PUT'))).toHaveLength(1);
    expect(gh.standing()).toBe('none');
    expect(result).toMatchObject({ outcome: 'dismissed', dismissed: 1 });
  });
  it('an accept under the worker token still posts nothing, but its stale change request is lifted as the reviewer', () => {
    const gh = fakeGithub({ viewer: 'Bot web-everything', labels: liveLabelsFor('accepted') });
    gh.reviews.push(review(7, 'CHANGES_REQUESTED'));
    const asReviewer = (argv) => (argv.includes('graphql') ? 'Bot plateau-reviewer' : gh.exec(argv));
    const result = mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'accepted', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, reviewerExec: () => ({ exec: asReviewer }) });
    expect(result).toMatchObject({ outcome: 'skipped', dismissed: 1 });
    expect(result.reason).toMatch(/^token-is-not-reviewer/);
    expect(gh.reviews.filter(r => r.state === 'APPROVED')).toHaveLength(0);
    expect(gh.standing()).toBe('none');
  });
  it('a minted token that is not the reviewer App is refused: nothing is written with it, the dismissal is queued', () => {
    const gh = fakeGithub({ viewer: operator, labels: liveLabelsFor('clear-human') });
    gh.reviews.push(review(7, 'CHANGES_REQUESTED'));
    const impostor = vi.fn(argv => (argv.includes('graphql') ? 'User plateau-reviewer' : gh.exec(argv)));
    const queue = { append: vi.fn(() => true), claim: vi.fn() };
    const result = mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'clear-human', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, reviewerExec: () => ({ exec: impostor }), queue });
    expect(impostor.mock.calls.filter(([a]) => a.includes('PUT'))).toHaveLength(0);
    expect(queue.append).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', pr: 123, head, verdict: 'clear-human', ids: [7] }));
    expect(result.outcome).toBe('queued');
    expect(result.line).toContain('agree=no dismissal=queued');
  });
  it('no reviewer token: the dismissal is queued, then the next reviewer-token run dismisses it first', () => {
    const gh = fakeGithub({ viewer: operator, labels: liveLabelsFor('clear-human') });
    gh.reviews.push(review(7, 'CHANGES_REQUESTED'));
    const entries = [];
    const queue = { append: (e) => { entries.push(e); return true; }, claim: () => ({ entries: entries.splice(0), done: () => {} }) };
    const lines = [];
    const base = { repo: 'owner/repo', pr: 123, headSha: head, env: { WE_UNDER_TEST: '1' }, identity, mode: { mode: 'mirror', source: 'tool' }, log: (l) => lines.push(l), appendLog: () => {}, queue };
    const queued = mirrorNativeReview({ ...base, verdict: 'clear-human', exec: gh.exec, reviewerExec: () => ({ reason: 'reviewer-token-unavailable: no key' }) });
    expect(queued).toMatchObject({ outcome: 'queued', queued: 1 });
    expect(queued.reason).toContain('reviewer-token-unavailable: no key');
    expect(gh.standing()).toBe('CHANGES_REQUESTED');
    // A later run as the reviewer App, on any PR, drains the queue before its own work.
    const asReviewer = (argv) => (argv.includes('graphql') ? 'Bot plateau-reviewer' : gh.exec(argv));
    mirrorNativeReview({ ...base, verdict: 'advisory', exec: asReviewer });
    expect(gh.reviews.find(r => r.id === 7).state).toBe('DISMISSED');
    expect(entries).toEqual([]);
    expect(lines.some(l => l.includes('label=clear-human native=none outcome=dismissed') && l.includes('dismissal=ok'))).toBe(true);
    // The latest line per (PR, head, label) is the drained one: the trial no longer counts it as a mismatch.
    expect(summarizeReadiness(lines, { minMirroredVerdicts: 1, maxMismatches: 0 }).mismatches).toBe(0);
  });
  it('a queued dismissal only touches the review ids recorded at queue time', () => {
    const gh = fakeGithub();
    gh.reviews.push(review(7, 'DISMISSED'), review(8, 'CHANGES_REQUESTED'));
    const queue = { append: vi.fn(() => true), claim: () => ({ entries: [{ v: 1, repo: 'owner/repo', pr: 123, head, verdict: 'clear-human', ids: [7] }, { v: 1, repo: 'bad repo', pr: 1, head, verdict: 'x', ids: [8] }], done: () => {} }) };
    mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'advisory', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {}, queue });
    expect(gh.reviews.find(r => r.id === 8).state).toBe('CHANGES_REQUESTED');
    expect(queue.append).not.toHaveBeenCalled();
  });
  const drainWith = (gh, entries, extra = {}) => {
    const appended = [];
    const lines = [];
    const queue = { append: (e) => { appended.push(e); return true; }, claim: () => ({ entries, done: () => {} }) };
    mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'advisory', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: (l) => lines.push(l), appendLog: () => {}, queue, ...extra });
    return { appended, lines };
  };
  it('a queued dismissal never removes a review the CURRENT label agrees with again', () => {
    const gh = fakeGithub({ labels: ['review:changes'] });
    gh.reviews.push(review(5, 'CHANGES_REQUESTED'), review(6, 'APPROVED', otherHead));
    drainWith(gh, [{ v: 1, repo: 'owner/repo', pr: 123, head, verdict: 'clear-human', ids: [5, 6] }]);
    expect(gh.reviews.find(r => r.id === 5).state).toBe('CHANGES_REQUESTED');
    expect(gh.reviews.find(r => r.id === 6).state).toBe('DISMISSED');
    expect(endorsedStates(['review:accepted', 'review:human'])).toEqual([]);
    expect(endorsedStates([{ name: 'review:accepted' }])).toEqual(['APPROVED']);
  });
  it('a changes verdict that reuses a queued review between the drain\'s label read and its dismissal is put back', () => {
    const gh = fakeGithub({ labels: liveLabelsFor('clear-human') });
    gh.reviews.push(review(5, 'CHANGES_REQUESTED'));
    let fired = false;
    const paused = (argv) => {
      if (!fired && argv.includes('PUT')) {
        fired = true;
        gh.labels = liveLabelsFor('changes');
        mirrorNativeReview({ repo: 'owner/repo', pr: 123, verdict: 'changes', headSha: head, env: { WE_UNDER_TEST: '1' }, exec: gh.exec, identity, mode: { mode: 'mirror', source: 'tool' }, log: () => {}, appendLog: () => {} });
      }
      return gh.exec(argv);
    };
    const { lines } = drainWith(gh, [{ v: 1, repo: 'owner/repo', pr: 123, head, verdict: 'clear-human', ids: [5] }], { exec: paused });
    expect(gh.standing()).toBe('CHANGES_REQUESTED');
    expect(lines.some(l => l.includes('label=clear-human') && l.includes('outcome=superseded') && l.includes('reconciled: posted REQUEST_CHANGES'))).toBe(true);
  });
  it('an entry for another owner waits for a run there, unchanged; a hopeless one is given up loudly', () => {
    const gh = fakeGithub();
    const other = { v: 1, repo: 'elsewhere/repo', pr: 4, head, verdict: 'rearm', ids: [9] };
    const tired = { v: 1, repo: 'owner/repo', pr: 123, head, verdict: 'clear-human', ids: [7], attempts: 19 };
    const failing = { ...gh, exec: (argv) => (argv.includes('--paginate') ? (() => { throw new Error('read failed'); })() : gh.exec(argv)) };
    const { appended, lines } = drainWith(failing, [other, tired]);
    expect(appended).toEqual([other]);
    expect(lines.some(l => l.includes('label=clear-human') && l.includes('agree=no') && l.includes('given up after 20 attempts'))).toBe(true);
  });
});

describe('reviewer token and dismissal queue IO', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const app = { appId: '42', installations: { owner: '7' }, key: { file: '/nonexistent/key.pem' }, botLogin: 'plateau-reviewer[bot]' };
  it('reads the reviewer App\'s fresh cached installation token, else mints, else says why', () => {
    dir = mkdtempSync(join(tmpdir(), 'nrv-'));
    const cachePath = join(dir, 'web-everything.json');
    const now = Date.parse('2026-10-13T20:00:00Z');
    const entry = (token, extra = {}) => JSON.stringify({ v: CACHE_VERSION, appId: '42', installationId: '7', token, expiresAt: '2026-10-13T21:00:00Z', ...extra });
    const mintSync = vi.fn(() => 'minted-token');
    const ids = { identity: { roles: { reviewer: app } }, repo: 'owner/repo', env: {}, now, cachePath, mintSync };
    writeFileSync(installationCachePath(roleCachePath(cachePath, '42'), '7'), entry('cached-token'));
    expect(readReviewerToken(ids)).toEqual({ token: 'cached-token' });
    writeFileSync(installationCachePath(roleCachePath(cachePath, '42'), '7'), entry('wrong-app', { appId: '1' }));
    expect(readReviewerToken(ids)).toEqual({ token: 'minted-token' });
    expect(mintSync).toHaveBeenCalledWith(expect.objectContaining({ appId: '42', installationId: '7', key: app.key }));
    expect(readReviewerToken({ ...ids, mintSync: throws })).toEqual({ reason: 'reviewer-token-unavailable: unreadable' });
    expect(readReviewerToken({ ...ids, repo: 'other/repo' })).toEqual({ reason: 'reviewer-app-not-installed (other)' });
    expect(readReviewerToken({ ...ids, identity: {} })).toEqual({ reason: 'reviewer-app-unconfigured' });
  });
  it('the file queue never takes a live drainer\'s claim, but takes a dead or stale one', () => {
    dir = mkdtempSync(join(tmpdir(), 'nrq-'));
    let alive = true;
    let clock = Date.now();
    const q = fileDismissalQueue(join(dir, 'q.jsonl'), { alive: () => alive, now: () => clock });
    expect(q.claim().entries).toEqual([]);
    q.append({ a: 1 });
    q.append({ a: 2 });
    const first = q.claim(); // still running: its claim is its own
    expect(first.entries).toEqual([{ a: 1 }, { a: 2 }]);
    q.append({ a: 3 });
    const second = q.claim();
    expect(second.entries).toEqual([{ a: 3 }]);
    second.done();
    clock += QUEUE_CLAIM_STALE_MS + 1000; // the first claim is stale now: taken over
    const stale = q.claim();
    expect(stale.entries).toEqual([{ a: 1 }, { a: 2 }]);
    clock = Date.now();
    alive = false; // its owner died without done(): re-claimed at once
    const dead = q.claim();
    expect(dead.entries).toEqual([{ a: 1 }, { a: 2 }]);
    dead.done();
    expect(readdirSync(dir)).toEqual([]);
  });
  // CI on 8638c5344: the mint child's `import(<env var>)` marked every daemon closure reaching this module incomplete.
  it('keeps every daemon import closure that reaches this module complete (no non-literal dynamic import)', () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    expect(collectImportClosure({ root, entries: ['scripts/lib/native-github-review.mjs'] })?.complete).toBe(true);
  });
  it('done() re-queues a line an append wrote into the claim after it was read', () => {
    dir = mkdtempSync(join(tmpdir(), 'nrq-'));
    const path = join(dir, 'q.jsonl');
    const q = fileDismissalQueue(path, { alive: () => true });
    q.append({ a: 1 });
    const claimed = q.claim();
    const [claimFile] = readdirSync(dir);
    appendFileSync(join(dir, claimFile), `${JSON.stringify({ a: 2 })}\n`); // an older producer's fd followed the rename
    claimed.done();
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^q\.jsonl\.entry-/)]);
    expect(q.claim().entries).toEqual([{ a: 2 }]);
  });
  // Red team on 5257ced00 (#5223): the append opened the queue, a drainer renamed, read and unlinked it, then the write
  // landed in the deleted file and append() still returned true.
  it('an append that opened its file before a drainer claimed and deleted the queue is never lost', () => {
    dir = mkdtempSync(join(tmpdir(), 'nrq-'));
    const q = fileDismissalQueue(join(dir, 'q.jsonl'), { alive: () => true });
    q.append({ pr: 1 });
    let drained;
    fsHook.beforeWrite = () => { const claimed = q.claim(); drained = claimed.entries; claimed.done(); };
    expect(q.append({ pr: 2 })).toBe(true);
    expect(drained).toEqual([{ pr: 1 }]);
    expect(q.claim().entries).toEqual([{ pr: 2 }]);
  });
  it('a dead producer\'s temp file and a legacy shared queue file are still drained, in queue order', () => {
    dir = mkdtempSync(join(tmpdir(), 'nrq-'));
    const path = join(dir, 'q.jsonl');
    writeFileSync(path, `${JSON.stringify({ a: 0 })}\n`);
    writeFileSync(`${path}.tmp-999999-x`, `${JSON.stringify({ a: 9 })}\n`);
    let alive = true;
    const q = fileDismissalQueue(path, { alive: () => alive });
    q.append({ a: 1 });
    q.append({ a: 2 });
    expect(q.claim().entries).toEqual([{ a: 0 }, { a: 1 }, { a: 2 }]);
    alive = false;
    const dead = q.claim();
    expect(dead.entries).toContainEqual({ a: 9 });
  });
});

describe('synchronous mirror shell (continued)', () => {
  it.each(['off', 'mirror', 'authoritative'])('honours mode %s', mode => {
    const f = fixture({ mode: { mode, source: 'tool' } });
    expect(f.result.outcome).toBe(mode === 'off' ? 'off' : 'posted');
    if (mode === 'off') {
      expect(f.calls).toHaveLength(0);
      expect(f.log).not.toHaveBeenCalled();
    }
  });
  it('skips non-verdicts with no IO', () => {
    const f = fixture({ verdict: 'bogus' });
    expect(f.result.outcome).toBe('not-applicable');
    expect(f.calls).toHaveLength(0);
    expect(f.log).not.toHaveBeenCalled();
  });
  it('guards default exec under test', () => expect(mirrorNativeReview({ env: { WE_UNDER_TEST: '1' } })).toEqual({ outcome: 'skipped', reason: 'under-test', event: null, line: '' }));
  it.each([{ reviewsError: new Error('read failed') }, { reviewsRaw: 'invalid json' }, { reviewsRaw: 'null' }])('fails closed on unreadable history: %j', responses => {
    const f = fixture({}, responses);
    expect(f.result).toMatchObject({ outcome: 'skipped', reason: 'reviews-unreadable' });
    expect(f.posts).toHaveLength(0);
  });
  it('does not throw on POST failure and uses the last stderr line', () => {
    const f = fixture({}, { postError: Object.assign(new Error('failed'), { stderr: 'first line\nlast error\n\n' }) });
    expect(f.result).toMatchObject({ outcome: 'failed', reason: 'last error' });
  });
  it('contains exceptions from logging', () => expect(() => fixture({ log: throws, appendLog: throws })).not.toThrow());
  it('never writes stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fixture();
    fixture({}, { postError: new Error('failed') });
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('promotion bar and readiness (count, not days; operator 2026-10-13)', () => {
  const line = (pr, outcome, { label = 'accepted', native = 'APPROVE', h = head, reason = '' } = {}) => formatComparisonLine({
    repo: 'o/r', pr, head: h, labelVerdict: label, event: native, outcome, reason, mode: 'mirror', source: 'tool' });
  it('the bar defaults to 50 mirrored / 0 mismatches and resolves per leaf with sources', () => {
    expect(STANDARD_PROMOTION).toEqual({ minMirroredVerdicts: 50, maxMismatches: 0 });
    const c = resolvePromotionCriteria({ platform: { nativeGithubReview: { promotion: { minMirroredVerdicts: 20 } } }, tool: { nativeGithubReview: { promotion: { maxMismatches: 1, minMirroredVerdicts: 0 } } } });
    expect(c).toMatchObject({ minMirroredVerdicts: 20, maxMismatches: 1, sources: { minMirroredVerdicts: 'platform', maxMismatches: 'tool' } });
    expect(c.invalid).toEqual(['tool.promotion.minMirroredVerdicts=0']);
  });
  it('the declared repo file sets the bar and the mode in one object block', () => {
    expect(loadPromotionCriteria({ env: {}, readPlatform: () => undefined })).toMatchObject({ minMirroredVerdicts: 50, maxMismatches: 0, sources: { minMirroredVerdicts: 'tool' } });
    expect(resolveNativeReviewMode({ tool: { nativeGithubReview: { mode: 'mirror' } } })).toMatchObject({ mode: 'mirror', source: 'tool' });
  });
  it('parses a comparison line, reason with spaces included', () => {
    expect(parseComparisonLine(line(7, 'skipped', { reason: 'token-is-not-reviewer (viewer=x)' }))).toMatchObject({ pr: '7', outcome: 'skipped', agree: 'no', reason: 'token-is-not-reviewer (viewer=x)' });
    expect(parseComparisonLine('unrelated')).toBeNull();
  });
  it('counts the latest line per (PR, head, verdict); neutral skips count as neither', () => {
    const lines = [
      line(1, 'failed', { reason: 'boom' }), line(1, 'posted'), // retry posted: mirrored, no mismatch
      line(2, 'posted'), line(2, 'already-posted'), // repeat: counted once
      line(3, 'posted', { label: 'changes', native: 'REQUEST_CHANGES' }),
      line(4, 'skipped', { reason: 'reviewer-role-unconfigured' }), line(5, 'skipped', { reason: 'head-moved (live=abc)' }),
      line(6, 'skipped', { reason: 'token-is-not-reviewer (viewer=web-everything[bot])' }), // fell back: mismatch
      line(8, 'not-applicable', { label: 'clear-human', native: null }), 'noise',
    ];
    expect(summarizeReadiness(lines)).toEqual({ mirrored: 3, mismatches: 1, ready: false, min: 50, maxMismatches: 0 });
  });
  it('ready only at the bar with no excess mismatches, and the line says so without switching anything', () => {
    const many = Array.from({ length: 50 }, (_, i) => line(100 + i, 'posted'));
    const s = summarizeReadiness(many);
    expect(s.ready).toBe(true);
    expect(formatReadinessLine(s)).toMatch(/^native-review readiness: 50 of 50 mirrored verdicts, 0 mismatches against our label verdict \(max 0\), ready yes/);
    expect(summarizeReadiness([...many, line(999, 'failed', { reason: 'x' })]).ready).toBe(false);
    expect(summarizeReadiness(many.slice(1)).ready).toBe(false);
  });
});
