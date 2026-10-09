import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SUPERSEDE_TARGETS, parseSupersedes, planSupersedeHolds, supersedeCandidates, resolveSupersedeSettings } from '../supersede-rule.mjs';
import { STAND_DOWN_MARKER, STAND_DOWN_REASONS, SUPERSEDED_LABEL, buildSupersededStandDownComment, supersedeHoldsOn } from '../stand-down.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
import { latestUnresolvedStandDown, buildOperatorAnswer } from '../stand-down-answer-core.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
const hold = { pr: 4522, by: 4532, mergedAt: '2026-10-09T01:52:13Z' };
const plan = (overrides = {}) => planSupersedeHolds({ mergedPrs: [fixture.merged], openPrs: [fixture.open], settings: { hold: true }, ...overrides });
// Built from its code point: a literal U+00A0 in source is forbidden by check:standards (#2866).
const NBSP = String.fromCharCode(0xa0);

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

  // Finding on PR #4560: a fence closes only on the same character at least as long as its opener (CommonMark).
  const fenceCases = [
    ['a four-backtick fence wrapping a three-backtick example', '````md\n```\nSupersedes #4522\n```\nSupersedes #4523\n````'],
    ['a tilde fence wrapping a backtick line', '~~~\n```\nSupersedes #4522\n~~~'],
    ['a backtick fence wrapping a tilde line', '```\n~~~\nSupersedes #4522\n```'],
    ['a longer tilde fence wrapping a shorter one', '~~~~\n~~~\nSupersedes #4522\n~~~~'],
    ['a closer carrying trailing text (not a closer)', '```\n``` md\nSupersedes #4522\n```'],
    ['a fence that is never closed', '```\nSupersedes #4522'],
    ['an opener with an info string', '```md title="x"\nSupersedes #4522\n```'],
    ['a closer indented 3 spaces', '```\nSupersedes #4522\n   ```'],
    ['a fence opened inside a list item', '- ```md\n  Supersedes #4522\n  ```'],
    ['a fence opened inside a numbered list item', '1. ```\n  Supersedes #4522\n    ```'],
    // Finding on PR #4560 (round 3): a list-item fence's closer may sit at most 3 columns past the item's content column.
    ['a list fence whose over-indented line is code, not a closer', '- ```md\n          ```\n  Supersedes #4522\n  ```'],
    ['a numbered list fence with a 4-extra-column fence line inside', '1. ```md\n   Supersedes #4521\n       ```\n   Supersedes #4522\n   ```'],
    ['a tab-indented line inside a list fence', '- ```md\n  x\n\t\t```\n  Supersedes #4522\n  ```'],
    ['a fence opened after two list markers on one line', '- - ```md\n  Supersedes #4522\n  ```'],
    ['a list fence opened with a tilde, over-indented tilde line inside', '- ~~~\n       ~~~\n  Supersedes #4522\n  ~~~'],
    ['a multi-line HTML comment', '<!--\nSupersedes #4522\n-->'],
    ['a comment opened after other text', 'Note <!-- template\nSupersedes #4522\nend -->'],
    ['a tab-indented line (indented code)', '\tSupersedes #4522'],
    ['a no-break-space-led marker', `${NBSP}Supersedes #4522`],
  ];
  it.each(fenceCases)('ignores a marker inside %s', (_name, body) => expect(parseSupersedes(body)).toEqual([]));
  it.each([
    ['a marker after a closed four-backtick fence', '````\n```\nSupersedes #1\n````\nSupersedes #2', [2]],
    ['a marker after a closed tilde fence', '~~~\nSupersedes #1\n~~~\nSupersedes #2', [2]],
    ['a closer longer than its opener', '```\nSupersedes #1\n`````\nSupersedes #2', [2]],
    ['inline triple backticks are not a fence', '```not a fence```\nSupersedes #2', [2]],
    ['a marker between two fences', '```\nx\n```\nSupersedes #3\n~~~\nSupersedes #4\n~~~', [3]],
    ['a marker after a closed list-item fence', '- ```\n  x\n  ```\nSupersedes #2', [2]],
    ['a marker after a list fence closed 3 columns past the content column', '- ```\n  x\n     ```\nSupersedes #2', [2]],
    ['a marker after a numbered list fence closed 3 columns past its content column', '1. ```\n   x\n      ```\nSupersedes #2', [2]],
    ['a marker after a nested-marker list fence', '- - ```\n    x\n    ```\nSupersedes #2', [2]],
    ['a marker after a list fence closed by a tab (4 columns, still under content + 3)', '- ```\n  x\n\t```\nSupersedes #2', [2]],
    ['a marker after a closed HTML comment', '<!--\nx\n-->\nSupersedes #2', [2]],
    ['a one-line HTML comment before a marker', '<!-- hint -->\nSupersedes #2', [2]],
    ['a marker followed by an opening comment', 'Supersedes #2 <!--\nSupersedes #3\n-->', [2]],
    ['a no-break-space-led backtick line (not a fence)', `${NBSP}\`\`\`\nSupersedes #2`, [2]],
  ])('still reads %s', (_name, body, expected) => expect(parseSupersedes(body)).toEqual(expected));
  it('caps the targets one body may declare', () => {
    const body = `Supersedes ${Array.from({ length: 3000 }, (_, i) => `#${i + 1}`).join(', ')}`;
    expect(parseSupersedes(body)).toHaveLength(MAX_SUPERSEDE_TARGETS);
  });
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
