import { UNOWNED_REBASE_INFRA_MARKER, UNOWNED_REBASE_INFRA_RETRY_CAP_DEFAULT, formatUnownedRebaseInfraMarker, countUnownedRebaseInfraFailures, shouldCountRebaseInfra, loadUnownedRebaseSettings, countUnownedRebaseAggregateAttempts } from '../unowned-rebase-attempt-count.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { grantedRebaseCap } from '../unowned-rebase-attempt-count.mjs';
/**
 * @file scripts/conveyor/__tests__/unowned-rebase-attempt-count.test.mjs
 * @description Pins the PURE durable attempt count for the unowned population's mechanical rebase-drop
 *   (#xu38vlf, epic #4075/#3383). Mirrors `we:scripts/conveyor/__tests__/conflict-fix-round-count.test.mjs`'s
 *   own shape for its sibling counter.
 */
import { describe, it, expect } from 'vitest';
import { countUnownedRebaseAttempts, UNOWNED_REBASE_ATTEMPT_MARKER, UNOWNED_REBASE_ATTEMPT_CAP } from '../unowned-rebase-attempt-count.mjs';

const AUTOMATION = { login: 'web-everything' };

describe('countUnownedRebaseAttempts — the durable unowned-population rebase-drop attempt count (#xu38vlf)', () => {
  it('counts one per comment whose LEADING line is the marker', () => {
    expect(countUnownedRebaseAttempts([
      { body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\n\nattempted once`, author: AUTOMATION },
      { body: 'an unrelated human comment', author: AUTOMATION },
      { body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\n\nand again`, author: AUTOMATION },
    ])).toBe(2);
  });

  it('does NOT count a comment that merely QUOTES the marker mid-body', () => {
    expect(countUnownedRebaseAttempts([{ body: `> ${UNOWNED_REBASE_ATTEMPT_MARKER}\nquoting`, author: AUTOMATION }])).toBe(0);
  });

  it('returns 0 for a non-array / empty input', () => {
    expect(countUnownedRebaseAttempts(null)).toBe(0);
    expect(countUnownedRebaseAttempts(undefined)).toBe(0);
    expect(countUnownedRebaseAttempts([])).toBe(0);
  });

  it('tolerates a bare-string comment as a SHAPE — but it carries no author, so it never counts', () => {
    expect(countUnownedRebaseAttempts([`${UNOWNED_REBASE_ATTEMPT_MARKER}\nx`])).toBe(0);
  });

  it('a forged attempt marker from a random commenter ("mallory") does not count — never inflates the cap toward exhaustion', () => {
    expect(countUnownedRebaseAttempts([{ body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\nattempted`, author: { login: 'mallory' } }])).toBe(0);
  });

  it('an attempt marker posted by the repo operator (a trusted human login) still counts', () => {
    expect(countUnownedRebaseAttempts([{ body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\nattempted`, author: { login: 'chalbert' } }])).toBe(1);
  });

  it('UNOWNED_REBASE_ATTEMPT_CAP is a small, fixed floor (mirrors CONFLICT_FIX_ROUND_CAP\'s own value)', () => {
    expect(UNOWNED_REBASE_ATTEMPT_CAP).toBe(3);
  });
});

describe('grantedRebaseCap — operator round grants reach the rebase caps (#5716)', () => {
  const repo = 'web-everything/web-everything';
  const attempt = { body: `${UNOWNED_REBASE_ATTEMPT_MARKER} outcome=skip:conflict`, author: AUTOMATION };
  const grant = (login, by = 1) => ({ author: { login }, body: buildRoundExtensionComment({ repo, pr: 5716, by, actor: 'chalbert',
    channel: 'claude-code-chat', reason: 'one more attempt', at: '2026-10-20T20:58:54Z' }) });
  const count = (c) => countUnownedRebaseAttempts(c);
  it('no grant leaves the base cap', () => {
    expect(grantedRebaseCap(3, [attempt, attempt, attempt], count, { repo, pr: 5716 })).toEqual({ cap: 3, grants: 0 });
  });
  it('a grant is "N more from when it was posted", not "N more than the base"', () => {
    const thread = [...Array(5).fill(attempt), grant('chalbert')];
    expect(grantedRebaseCap(3, thread, count, { repo, pr: 5716 }).cap).toBe(6);
    expect(grantedRebaseCap(3, [...thread, attempt, grant('chalbert', 2)], count, { repo, pr: 5716 }).cap).toBe(8);
  });
  it('a grant from a non-operator, or for another PR, never counts', () => {
    expect(grantedRebaseCap(3, [attempt, attempt, attempt, grant('someone')], count, { repo, pr: 5716 }).cap).toBe(3);
    expect(grantedRebaseCap(3, [attempt, attempt, attempt, grant('chalbert')], count, { repo, pr: 9999 }).cap).toBe(3);
  });
  it('an automation-posted grant counts only under a verified standing-ruling scope', () => {
    const auto = { ...grant('web-everything'), author: AUTOMATION };
    expect(grantedRebaseCap(3, [attempt, attempt, attempt, auto], count, { repo, pr: 5716, standingRuling: null }).cap).toBe(3);
  });
});

describe('separate infrastructure retry budget', () => {
  const marker = (headSha, createdAt) => ({
    body: formatUnownedRebaseInfraMarker({ action: 'error', reason: 'index.lock' }, headSha),
    author: AUTOMATION, createdAt,
  });

  it('uses distinct prefixes and never cross counts content and infrastructure', () => {
    expect(UNOWNED_REBASE_INFRA_MARKER.startsWith(UNOWNED_REBASE_ATTEMPT_MARKER)).toBe(false);
    expect(UNOWNED_REBASE_ATTEMPT_MARKER.startsWith(UNOWNED_REBASE_INFRA_MARKER)).toBe(false);
    const content = { body: UNOWNED_REBASE_ATTEMPT_MARKER, author: AUTOMATION };
    expect(countUnownedRebaseAttempts([marker('abc')])).toBe(0);
    expect(countUnownedRebaseInfraFailures([content])).toBe(0);
    expect(countUnownedRebaseAttempts([content, marker('abc')])).toBe(1);
    expect(countUnownedRebaseInfraFailures([content, marker('abc')])).toBe(1);
  });

  it('formats a bounded single-line reason and includes the head', () => {
    const body = formatUnownedRebaseInfraMarker(new Error(` lock\r\n${'x'.repeat(150)}`), 'abc');
    expect(body).toBe(`${UNOWNED_REBASE_INFRA_MARKER} head=abc outcome=infra:${`lock ${'x'.repeat(150)}`.slice(0, 120)}`);
    expect(formatUnownedRebaseInfraMarker({ action: 'error', reason: 'offline' }))
      .toBe(`${UNOWNED_REBASE_INFRA_MARKER} outcome=infra:offline`);
  });

  it.each([
    [new Error('lock'), true], [{ thrown: true, reason: 'lock' }, true],
    [{ action: 'error' }, true], [undefined, false],
    [{ action: 'skip', precondition: true }, false], [{ action: 'skip', deferred: true }, false],
    [{ action: 'skip', reason: 'content conflict' }, false],
    [{ action: 'rebased' }, false], [{ action: 'current' }, false],
  ])('counts only errors or throws: %j', (result, expected) => {
    expect(shouldCountRebaseInfra(result)).toBe(expected);
  });

  it('counts matching heads and legacy headless markers, or all heads when none is available', () => {
    const comments = [marker('abc'), marker('def'), marker()];
    expect(countUnownedRebaseInfraFailures(comments, { headSha: 'abc' })).toBe(2);
    expect(countUnownedRebaseInfraFailures(comments, { headSha: 'new' })).toBe(1);
    expect(countUnownedRebaseInfraFailures(comments)).toBe(3);
    const fakeHeadInReason = { body: `${UNOWNED_REBASE_INFRA_MARKER} outcome=infra:failed head=def`, author: AUTOMATION };
    expect(countUnownedRebaseInfraFailures([fakeHeadInReason], { headSha: 'abc' })).toBe(1);
  });

  it('uses the content cutoff semantics including missing and invalid dates', () => {
    const comments = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', undefined, 'bad-date']
      .map(date => marker('abc', date));
    expect(countUnownedRebaseInfraFailures(comments)).toBe(5);
    expect(countUnownedRebaseInfraFailures(comments, { countSince: '2026-10-02T00:00:00Z', headSha: 'abc' })).toBe(4);
  });

  it('ignores untrusted, bare-string, quoted and non-leading markers', () => {
    const { body } = marker('abc');
    expect(countUnownedRebaseInfraFailures([
      { body, author: { login: 'mallory' } }, body,
      { body: `> ${body}`, author: AUTOMATION }, { body: `hello\n${body}`, author: AUTOMATION },
    ])).toBe(0);
    expect(countUnownedRebaseInfraFailures([{ body: `  ${body}`, author: { login: 'chalbert' } }])).toBe(1);
    for (const input of [null, undefined, []]) expect(countUnownedRebaseInfraFailures(input)).toBe(0);
  });

  it('defaults to ten and resolves platform, repo and environment with provenance', () => {
    expect(UNOWNED_REBASE_INFRA_RETRY_CAP_DEFAULT).toBe(10);
    const resolve = (platform = {}, repo = {}, env = {}) => loadUnownedRebaseSettings({ platform, repo, env });
    expect(resolve().value.infraRetryCap).toBe(10);
    expect(resolve().sources.infraRetryCap).toBe('standard');
    expect(resolve({ infraRetryCap: 7 }).sources.infraRetryCap).toBe('platform');
    expect(resolve({ infraRetryCap: 7 }, { infraRetryCap: 5 }).value.infraRetryCap).toBe(5);
    expect(resolve({}, { infraRetryCap: 5 }).sources.infraRetryCap).toBe('tool');
    const settings = resolve({ infraRetryCap: 7 }, { infraRetryCap: 5 }, { WE_UNOWNED_REBASE_INFRA_RETRY_CAP: '3' });
    expect(settings.value.infraRetryCap).toBe(3);
    expect(settings.sources.infraRetryCap).toBe('env');
  });

  it.each([0, -1, 1.5, 'bad', null, true, Infinity])('rejects invalid positive integer cap %j at every layer', infraRetryCap => {
    const settings = loadUnownedRebaseSettings({ platform: { infraRetryCap }, repo: { infraRetryCap },
      env: { WE_UNOWNED_REBASE_INFRA_RETRY_CAP: String(infraRetryCap) } });
    expect(settings.value.infraRetryCap).toBe(10);
    expect(settings.sources.infraRetryCap).toBe('standard');
  });

  it('invalid overrides preserve the valid lower layer', () => {
    const settings = loadUnownedRebaseSettings({ platform: { infraRetryCap: 4 }, repo: { infraRetryCap: 0 },
      env: { WE_UNOWNED_REBASE_INFRA_RETRY_CAP: '1.5' } });
    expect(settings.value.infraRetryCap).toBe(4);
    expect(settings.sources.infraRetryCap).toBe('platform');
  });
});


describe('aggregate attempt cap', () => {
  it('counts content, legacy markers and infra across all heads and all dates', () => {
    const comments = [
      { body: UNOWNED_REBASE_ATTEMPT_MARKER, author: AUTOMATION },
      ...['aaa', 'bbb'].map(head => ({ body: formatUnownedRebaseInfraMarker(new Error('lock'), head),
        author: AUTOMATION, createdAt: '2020-01-01T00:00:00Z' })),
    ];
    expect(countUnownedRebaseAggregateAttempts(comments)).toBe(3);
  });
});
