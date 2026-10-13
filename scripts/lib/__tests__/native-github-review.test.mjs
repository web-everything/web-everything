import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_REVIEW_MODES, NATIVE_REVIEW_ENV, STANDARD_NATIVE_REVIEW_MODE, EVENT_STATE,
  parseNativeReviewMode, resolveNativeReviewMode, loadNativeReviewMode, planNativeReview,
  normaliseLogin, checkReviewerIdentity, findExistingNativeReview, ownStandingChangeRequests,
  nativeReviewBody, formatComparisonLine, mirrorNativeReview,
  STANDARD_PROMOTION, resolvePromotionCriteria, loadPromotionCriteria, parseComparisonLine, summarizeReadiness, formatReadinessLine,
} from '../native-github-review.mjs';

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const identity = { roles: { reviewer: { botLogin: 'plateau-reviewer[bot]', appId: 2 }, worker: { botLogin: 'web-everything[bot]', appId: 1 } } };
const review = (id, state, commit_id = head, login = 'plateau-reviewer[bot]') => ({ id, state, commit_id, user: { login } });
const throws = () => { throw new Error('unreadable'); };
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
    if (argv.includes('graphql')) return responses.viewer ?? 'plateau-reviewer[bot]\n';
    if (argv.includes('--paginate')) {
      if (responses.reviewsError) throw responses.reviewsError;
      return responses.reviewsRaw ?? (responses.reviews ?? []).map(JSON.stringify).join('\n');
    }
    if (responses.prError) throw responses.prError;
    return responses.prRaw ?? JSON.stringify({ head: responses.head ?? head, author: responses.author ?? 'app/web-everything', state: responses.state ?? 'open' });
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
  it.each([['accepted', 'APPROVE', true], ['changes', 'REQUEST_CHANGES', false], ['advisory', 'COMMENT', false], ['clear-human', null, true]])('maps %s', (verdict, event, dismissOwnChanges) => {
    expect(planNativeReview({ verdict, headSha: head })).toMatchObject({ event, dismissOwnChanges });
  });
  it.each([['review:human'], [{ name: 'review:human' }]])('keeps human approvals with the operator: %j', label => {
    expect(planNativeReview({ verdict: 'accepted', headSha: head, labels: [label] })).toEqual({ event: 'COMMENT', dismissOwnChanges: true, reason: 'human-review: the approval must come from the operator' });
  });
  it.each(['rearm', 'restamp'])('ignores %s', verdict => expect(planNativeReview({ verdict, headSha: head })).toEqual({ event: null, dismissOwnChanges: false, reason: 'not-a-review-verdict' }));
  it.each([undefined, 'bad', 'A'.repeat(40), 'a'.repeat(39)])('requires a reviewed head: %s', headSha => expect(planNativeReview({ verdict: 'accepted', headSha })).toEqual({ event: null, dismissOwnChanges: false, reason: 'no-reviewed-head' }));
});

describe('identity and review history', () => {
  it('normalises app logins', () => expect(normaliseLogin(' APP/Plateau-Reviewer[bot] ')).toBe('plateau-reviewer'));
  const failures = [
    [{}, 'plateau-reviewer[bot]', 'reviewer-role-unconfigured'],
    [{ roles: { reviewer: {} } }, 'plateau-reviewer[bot]', 'reviewer-bot-login-unknown'],
    [{ roles: { reviewer: { botLogin: 'web-everything[bot]' } } }, 'web-everything[bot]', 'reviewer-is-shared-app'],
    [{ roles: { reviewer: { botLogin: 'plateau-reviewer', appId: 1 }, worker: { appId: 1 } } }, 'plateau-reviewer', 'reviewer-is-shared-app'],
    [{ roles: { reviewer: { botLogin: 'plateau-reviewer' }, worker: { botLogin: 'app/plateau-reviewer[bot]' } } }, 'plateau-reviewer', 'reviewer-is-shared-app'],
    [identity, '', 'viewer-unreadable'],
    [identity, 'web-everything[bot]', 'token-is-not-reviewer (viewer=web-everything[bot])'],
  ];
  it.each(failures)('fails closed for %j / %s', (configured, viewerLogin, reason) => {
    expect(checkReviewerIdentity({ identity: configured, viewerLogin, prAuthorLogin: 'operator' })).toEqual({ ok: false, reason });
    const f = fixture({ identity: configured }, { viewer: viewerLogin });
    expect(f.result).toMatchObject({ outcome: 'skipped', reason });
    expect(f.posts).toHaveLength(0);
    expect(f.puts).toHaveLength(0);
  });
  it('refuses the PR author', () => {
    const f = fixture({}, { author: 'app/plateau-reviewer' });
    expect(f.result.reason).toBe('reviewer-is-pr-author');
    expect(f.posts).toHaveLength(0);
  });
  it('accepts the separate reviewer identity', () => expect(checkReviewerIdentity({ identity, viewerLogin: 'app/plateau-reviewer', prAuthorLogin: 'web-everything' })).toEqual({ ok: true, reviewerLogin: 'plateau-reviewer' }));
  it('matches history by author, head and state, returning the first match', () => {
    const reviews = [review(1, 'APPROVED', otherHead), review(2, 'APPROVED', head, 'other'), review(3, 'COMMENTED'), review(4, 'APPROVED'), review(5, 'APPROVED')];
    expect(findExistingNativeReview({ reviews, head, event: 'APPROVE', reviewerLogin: 'plateau-reviewer' })).toBe(reviews[3]);
    expect(findExistingNativeReview({ reviews, head, event: 'REQUEST_CHANGES', reviewerLogin: 'plateau-reviewer' })).toBeNull();
  });
  it('lists only own standing numeric change request ids across heads', () => {
    const reviews = [review(1, 'CHANGES_REQUESTED'), review(2, 'CHANGES_REQUESTED', otherHead), review(3, 'DISMISSED'), review(4, 'CHANGES_REQUESTED', head, 'other')];
    expect(ownStandingChangeRequests({ reviews, reviewerLogin: 'plateau-reviewer' })).toEqual([1, 2]);
    expect(ownStandingChangeRequests({ reviews, reviewerLogin: '' })).toEqual([]);
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
    expect(f.calls[0]).toEqual(['api', 'repos/owner/repo/pulls/123', '--jq', '{head: .head.sha, author: .user.login, state: .state}']);
    expect(f.calls[1]).toEqual(['api', 'graphql', '-f', 'query=query{viewer{login}}', '--jq', '.data.viewer.login']);
    expect(f.calls[2]).toEqual(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/owner/repo/pulls/123/reviews', '--jq', '.[] | {id, state, commit_id, user: {login: .user.login}}']);
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
  it('head movement prevents dismissal too', () => expect(fixture({ verdict: 'clear-human' }, { head: otherHead, reviews: [review(7, 'CHANGES_REQUESTED')] }).puts).toHaveLength(0));
  it('human accepted posts a comment and dismisses a prior own hold', () => {
    const f = fixture({ labels: ['review:human'] }, { reviews: [review(7, 'CHANGES_REQUESTED')] });
    expect(f.posts[0]).toContain('event=COMMENT');
    expect(f.puts).toHaveLength(1);
  });
  it('records dismissal failures and continues other dismissals', () => {
    const f = fixture({ verdict: 'clear-human' }, { reviews: [review(7, 'CHANGES_REQUESTED'), review(8, 'CHANGES_REQUESTED')], dismissError: new Error('denied') });
    expect(f.puts).toHaveLength(2);
    expect(f.result.reason).toContain('denied');
    expect(f.result.dismissed).toBe(0);
  });
  it.each(['off', 'mirror', 'authoritative'])('honours mode %s', mode => {
    const f = fixture({ mode: { mode, source: 'tool' } });
    expect(f.result.outcome).toBe(mode === 'off' ? 'off' : 'posted');
    if (mode === 'off') {
      expect(f.calls).toHaveLength(0);
      expect(f.log).not.toHaveBeenCalled();
    }
  });
  it('skips non-verdicts with no IO', () => {
    const f = fixture({ verdict: 'rearm' });
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
