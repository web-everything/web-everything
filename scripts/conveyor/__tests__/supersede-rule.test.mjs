import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSupersedes, planSupersedeHolds, supersedeCandidates, resolveSupersedeSettings } from '../supersede-rule.mjs';
import { STAND_DOWN_MARKER, STAND_DOWN_REASONS, SUPERSEDED_LABEL, buildSupersededStandDownComment, supersedeHoldsOn } from '../stand-down.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
import { latestUnresolvedStandDown, buildOperatorAnswer } from '../stand-down-answer-core.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
const hold = { pr: 4522, by: 4532, mergedAt: '2026-10-09T01:52:13Z' };
const plan = (overrides = {}) => planSupersedeHolds({ mergedPrs: [fixture.merged], openPrs: [fixture.open], settings: { hold: true }, ...overrides });

describe('parseSupersedes', () => {
  it('reads the real #4532 marker without counting its prose', () => {
    expect(parseSupersedes(fixture.merged.body)).toEqual([4522]);
    const prose = fixture.merged.body.split('\n').find((line) => line.includes('is superseded by this PR'));
    expect(prose).toBeTruthy();
    expect(parseSupersedes(prose)).toEqual([]);
  });
  it.each([
    ['Supersedes: #4522', [4522]], ['### Supersedes #4522', [4522]],
    ['**Supersedes:** #12, #13 and #14', [12, 13, 14]], ['Supersedes #1 #2', [1, 2]],
    ['Supersedes #7 (lane/x)', [7]], ['Supersedes #1 #1\nSupersedes: #2, #1', [1, 2]],
  ])('accepts %s', (body, expected) => expect(parseSupersedes(body)).toEqual(expected));
  it.each(['This supersedes #4522.', 'supersedes #4522', 'Supersedes PR #4522', 'Supersedes #12a',
    '```md\nSupersedes #4522\n```', '', null, undefined, 42, {}])('rejects %j', (body) => expect(parseSupersedes(body)).toEqual([]));
});

describe('planSupersedeHolds', () => {
  it('holds the real superseded PR', () => expect(plan()).toEqual([hold]));
  it('does nothing when off', () => expect(plan({ settings: { hold: false } })).toEqual([]));
  it('skips self references', () => expect(plan({ mergedPrs: [{ ...fixture.merged, number: 4522, body: 'Supersedes #4522' }] })).toEqual([]));
  it('ignores an open superseder', () => expect(plan({ mergedPrs: [{ ...fixture.merged, state: 'OPEN', mergedAt: null }] })).toEqual([]));
  it('ignores a superseder also listed open', () => expect(plan({ openPrs: [fixture.open, { number: 4532 }] })).toEqual([]));
  it('ignores targets not open', () => expect(plan({ openPrs: [] })).toEqual([]));
  it.each([['web-everything', []], ['rando', [hold]]])('trusts only authorized hold authors: %s', (login, expected) => {
    const comment = { body: buildSupersededStandDownComment(hold), author: { login } };
    expect(plan({ openPrs: [{ ...fixture.open, comments: [...fixture.open.comments, comment] }] })).toEqual(expected);
  });
  it('chooses the earliest merged superseder once, regardless of input order', () => {
    const later = { ...fixture.merged, number: 4533, mergedAt: '2026-10-09T03:00:00Z' };
    expect(plan({ mergedPrs: [later, fixture.merged] })).toEqual([hold]);
  });
  it('reads only open candidate targets and deduplicates them', () => {
    expect(supersedeCandidates({ mergedPrs: [fixture.merged, fixture.merged], openNumbers: [4522, 1] })).toEqual([4522]);
    expect(supersedeCandidates({ mergedPrs: [{ number: 1, state: 'MERGED', body: 'Supersedes #1 #2 #3' }], openNumbers: [1, 2] })).toEqual([2]);
  });
});

describe('resolveSupersedeSettings', () => {
  it.each([['on', true], ['off', false]])('reads file %s', (value, expected) => {
    expect(resolveSupersedeSettings({}, { read: () => JSON.stringify({ supersede: { hold: value, lookbackDays: 7 } }) })).toEqual({ hold: expected, lookbackDays: 7 });
  });
  it('env off beats file on', () => expect(resolveSupersedeSettings({ WE_SUPERSEDE_HOLD: 'off' }, { read: () => '{"supersede":{"hold":"on"}}' })).toEqual({ hold: false, lookbackDays: 14 }));
  it('fails closed on malformed JSON', () => expect(resolveSupersedeSettings({}, { read: () => '{' })).toEqual({ hold: false, lookbackDays: 14 }));
  it.each([0, -1, 91, 1.5, 'bad', null])('defaults invalid lookback %j', (lookbackDays) => {
    expect(resolveSupersedeSettings({}, { read: () => JSON.stringify({ supersede: { hold: 'on', lookbackDays } }) })).toEqual({ hold: true, lookbackDays: 14 });
  });
  it('pins the checked-in settings', () => expect(resolveSupersedeSettings({})).toEqual({ hold: true, lookbackDays: 14 }));
});

describe('superseded stand-down contract', () => {
  const body = buildSupersededStandDownComment({ ...hold, repo: 'web-everything/web-everything' });
  it('explains the terminal hold and operator decision', () => {
    expect(body.startsWith(STAND_DOWN_MARKER)).toBe(true);
    expect(body).toContain(STAND_DOWN_REASONS.superseded);
    expect(body).toContain('#4532');
    expect(body).toMatch(/Closing this PR needs an operator decision/);
    expect(body).toContain('stand-down-answer.mjs');
    expect(body.endsWith('<!-- stand-down reason=superseded -->')).toBe(true);
    expect(SUPERSEDED_LABEL).toBe('superseded');
  });
  it.each([['web-everything', 1, [4532]], ['rando', 0, []]])('enforces trust for %s', (login, count, by) => {
    const c = { id: 'IC_superseded', body, author: { login } };
    expect(countUnresolvedStandDowns([c])).toBe(count);
    expect(supersedeHoldsOn([c])).toEqual(by);
    if (count) expect(latestUnresolvedStandDown([c])).toBe(c);
  });
  it('allows an operator answer to resolve the hold by comment id', () => {
    const c = { id: 'IC_superseded', body, author: { login: 'web-everything' } };
    const answer = { author: { login: 'web-everything' }, body: buildOperatorAnswer({ standDownId: c.id, reason: 'Unique work remains', actor: 'chalbert', channel: 'chat' }) };
    expect(countUnresolvedStandDowns([c, answer])).toBe(0);
    expect(latestUnresolvedStandDown([c, answer])).toBeNull();
  });
  it('requires the superseder number', () => expect(() => buildSupersededStandDownComment({ pr: 4522 })).toThrow());
});
