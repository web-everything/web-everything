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
    // Self-review of round 3: same defect class, one input shape away.
    ['an opener whose info string holds U+2028', `\`\`\`md${String.fromCharCode(0x2028)}x\nSupersedes #4522\n\`\`\``],
    ['an opener followed by a lone CR line break', '```md\rx\nSupersedes #4522\n```'],
    ['a closer followed by a no-break space (not a closer)', `\`\`\`md\nx\n\`\`\`${NBSP}\nSupersedes #4522\n\`\`\``],
    ['a closer followed by a BOM (not a closer)', `\`\`\`md\nx\n\`\`\`${String.fromCharCode(0xfeff)}\nSupersedes #4522\n\`\`\``],
    ['a list fence "closed" by a fence line left of the content column', '- ```\n  x\n```\nSupersedes #4522\n```'],
    ['a list fence "closed" by a one-space-indented fence line', '- ```\n  x\n ```\nSupersedes #4522\n```'],
    ['a multi-line HTML comment', '<!--\nSupersedes #4522\n-->'],
    ['a comment opened after other text', 'Note <!-- template\nSupersedes #4522\nend -->'],
    ['a tab-indented line (indented code)', '\tSupersedes #4522'],
    ['a no-break-space-led marker', `${NBSP}Supersedes #4522`],
    // Round 4 (ruling not addressed, rung 2): a non-blank line left of a list item's content column ENDS the item, and
    // with it the item's fence; a fence line there opens a NEW fence. A tracker that only knows the old fence closes it
    // on a line that is really content of the new one.
    ['a new fence opened left of a list fence, holding a line like the list closer',
      '- ```\n  code\n~~~\nSupersedes #4521\n  ```\nSupersedes #4522\n~~~'],
    ['a list item fence on its own line, then a top-level fence', '- item\n\n  ```\n  code\n```\nSupersedes #4522\n```'],
    ['a numbered item fence on its own line, then a top-level fence', '1. item\n\n   ```\n   code\n```\nSupersedes #4522\n```'],
    ['a list item fence on its own line, then a tilde fence', '- item\n\n  ```\n  code\n~~~\nSupersedes #4521\n  ```\nSupersedes #4522\n~~~'],
    // Code that is not a fence: an inline code span across lines, and a raw <pre> block.
    ['an inline code span that spans lines', 'Write `x\nSupersedes #4522` in the body.'],
    ['a double-backtick code span that spans lines', 'Write ``x`\nSupersedes #4522`` in the body.'],
    ['a raw <pre> block', '<pre>\nSupersedes #4522\n</pre>'],
    // Round 4 self-review: inline constructs that run across lines, with CommonMark's own precedence.
    ['an inline <code> element across lines', 'Use <code>x\nSupersedes #4522</code> as an example.'],
    ['an inline <kbd> element across lines', 'Press <kbd>x\nSupersedes #4522</kbd>'],
    ['a tag attribute across lines', 'See <a title="\nSupersedes #4522\n">link</a>'],
    ['a processing instruction across lines', 'Note <?\nSupersedes #4522\n?>'],
    ['a CDATA section across lines', 'Note <![CDATA[\nSupersedes #4522\n]]>'],
    ['a code span after a backtick inside a link destination', 'See [doc](https://x/`a) `b\nSupersedes #4522` end'],
    ['a code span after a backtick inside an autolink', 'See <http://a`b> `x\nSupersedes #4522` end'],
    ['a code span after a backtick inside a tag attribute', '<span title="`">ok</span> `x\nSupersedes #4522` end'],
    ['a link title across lines', 'See [doc](/u "\nSupersedes #4522\n")'],
    ['an image alt text across lines', 'See ![x\nSupersedes #4522](/i.png)'],
    ['a list-item comment never closed in raw HTML', '- <!-- describe the change\n-->\nSupersedes #4522'],
    ['a blockquote comment never closed in raw HTML', '> <!-- note\n-->\nSupersedes #4522'],
    ['a comment reopened on its closing line', '<!--\na --> b <!--\nSupersedes #4522\n-->'],
    ['a comment after a code span of another length', 'x `a <!-- ``\nSupersedes #4522\n-->'],
    ['a link reference definition title across lines', '[a]: /u "\nSupersedes #4522\n"'],
    // Round 4, second self-review.
    ['a code span after a paragraph whose first line is a no-break space', `${NBSP}\na \`x\nSupersedes: #4522 \`\nplain`],
    ['a code span after a paragraph whose first line is U+2028', `${String.fromCharCode(0x2028)}\na \`x\nSupersedes: #4522 \`\nplain`],
    ['a setext heading after a vertical-tab line', '\u000b\na `x\nSupersedes: #4522 `\nplain\n==='],
    ['a link definition whose label escapes a bracket', "[a\\]b]: /url '\nSupersedes: #4522\n'"],
    ['a struck-through marker', '~~Supersedes: #4521\nSupersedes: #4522~~'],
    ['a <del> marker', '<del>Supersedes: #4521\nSupersedes: #4522</del>'],
    ['an <s> marker', '<s>Supersedes: #4521\nSupersedes: #4522</s>'],
    ['an inline <code> left open into the next paragraph', 'Intro <code>\n\nSupersedes: #4522'],
    ['an inline <pre> left open into the next paragraph', 'see <pre>\n\nSupersedes: #4522'],
    ['a <pre> inside an HTML block, open across paragraphs', '<div><pre>\n\nSupersedes: #4522\n\n</pre></div>'],
    ['a <code> HTML block open across paragraphs', '<code>\n\nSupersedes: #4522\n\n</code>'],
    ['a body that holds the first private-use sentinel', `${String.fromCharCode(0xe000)}0${String.fromCharCode(0xe000)} \`x\nSupersedes #4522\``],
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
    ['a marker after a lone CR line break', 'intro\rSupersedes #5', [5]],
    ['a marker after a backticked comment opener', 'Use `<!--` here\nSupersedes #5', [5]],
    ['a marker after a double-backtick comment opener', 'Use ``<!--`` here\nSupersedes #5', [5]],
    ['a marker after an indented-code line with a fence after the first gap', '-      - ```\nSupersedes #1\n  ```', [1]],
    ['a marker after a closed HTML comment', '<!--\nx\n-->\nSupersedes #2', [2]],
    ['a one-line HTML comment before a marker', '<!-- hint -->\nSupersedes #2', [2]],
    ['a marker followed by an opening comment', 'Supersedes #2 <!--\nSupersedes #3\n-->', [2]],
    ['a no-break-space-led backtick line (not a fence)', `${NBSP}\`\`\`\nSupersedes #2`, [2]],
    // Round 4: a marker CommonMark renders as text still counts.
    ['a marker after a closed code span on the line before', 'Write `x` here\nSupersedes #2', [2]],
    ['a marker after an escaped backtick', 'Write \\`x\nSupersedes #2', [2]],
    ['a marker after an unmatched backtick run', 'Write ``x`\nSupersedes #2', [2]],
    ['a marker after a link whose destination holds a backtick', 'See [doc](https://x/`a) and\nSupersedes: #2 `b`', [2]],
    ['a marker after a closed inline <code> element', 'Use <code>x</code> here\nSupersedes #2', [2]],
    ['a marker after a closed inline comment', 'Note <!-- x -->\nSupersedes #2', [2]],
    ['a bold marker in a paragraph', 'Some text\n**Supersedes:** #2', [2]],
    ['a marker in a setext heading', 'Supersedes #2\n===', [2]],
    ['a marker after a closed <code> HTML block', '<code>\nx\n</code>\n\nSupersedes #2', [2]],
    ['a marker after a closed strike-through', '~~old~~\nSupersedes #2', [2]],
    ['a marker after a <span> (not a hiding tag)', '<span>x\n\nSupersedes #2', [2]],
    ['a marker after a code tag named in a comment', '<!-- <code> -->\n\nSupersedes #2', [2]],
  ])('still reads %s', (_name, body, expected) => expect(parseSupersedes(body)).toEqual(expected));
  // Round 4 self-review: the markdown parse must stay linear on a 64 KB body (markdown-it's `reference` rule is not).
  it.each([['link reference definitions', '[a]: /u\n'], ['code spans', '`a`\n'], ['lone backticks', '`\n'], ['marker lines', 'Supersedes #1\n'],
    ['a sentinel-like run', `qqsupersedesmark${'q'.repeat(40000)} `], ['comment openers', '<!--'], ['a backtick line', '`'.repeat(64) + '<!--']])(
    'reads a 64 KB body of %s quickly', (_name, unit) => {
      const body = `${unit.repeat(Math.ceil(65536 / unit.length))}\nSupersedes #2`;
      const started = performance.now();
      parseSupersedes(body);
      expect(performance.now() - started).toBeLessThan(1500);
    });
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
