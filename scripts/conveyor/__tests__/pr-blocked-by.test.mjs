import { it, expect } from 'vitest';
import { parseBlockedBy, buildBlockedMap, sortUnblockersFirst } from '../pr-blocked-by.mjs';
it('parses all four dependency phrases, case-insensitively and deduplicates', () => {
  expect(parseBlockedBy('Blocked by #6244; DEPENDS ON #2; waits on #3; waiting on #4; blocked by #2')).toEqual([6244, 2, 3, 4]);
});
it('parses colon-delimited dependency annotations without joining lines or quoted examples', () => {
  expect(parseBlockedBy('Blocked by: #6244; DEPENDS ON : #2; waits on:\t#3; waiting on: #4')).toEqual([6244, 2, 3, 4]);
  expect(parseBlockedBy('Blocked by:\n#6244\n\n> Blocked by: #2\n\n`Blocked by: #3`')).toEqual([]);
});
it('ignores quotes, fenced code, inline code and self references', () => {
  const body = '> blocked by #1\n```md\nblocked by #2\n```\n~~~\nwaits on #3\n~~~\n`blocked by #4` ``depends on #5``\nblocked by #6';
  expect(parseBlockedBy(body)).toEqual([6]);
  expect(buildBlockedMap([{ number: 6, body, comments: [] }]).blockedBy.get(6)).toEqual([]);
});
it('reads body, comments and refusal reason, builds reverse links and keeps stable priority', () => {
  const prs = [{ number: 6193, body: 'blocked by #6244', comments: [{ body: 'depends on #7' }], refusalReason: 'waiting on #8' }, { number: 6244 }];
  // All three referenced targets are confirmed open; preserve coverage of each text source.
  const map = buildBlockedMap([...prs, { number: 7 }, { number: 8 }]);
  expect(map.blockedBy.get(6193)).toEqual([6244, 7, 8]);
  expect(map.unblocks.get(6244)).toEqual([6193]);
  expect(sortUnblockersFirst(prs.map(p => ({ ...p, unblocks: map.unblocks.get(p.number) ?? [] }))).map(p => p.number)).toEqual([6244, 6193]);
});

it('does not manufacture dependency phrases across excluded Markdown or paragraphs', () => {
  expect(parseBlockedBy('blocked `example` by #1\nblocked\n> by #2\nby #3')).toEqual([]);
});

it('excludes unterminated and multiline inline spans conservatively', () => {
  expect(parseBlockedBy('`example\nblocked by #1')).toEqual([]);
  expect(parseBlockedBy('``example ` nested\nblocked by #1`` blocked by #2')).toEqual([2]);
});

it('R437 retains blocking edges only for targets confirmed open in the current listing', () => {
  const dependent = { number: 6193, body: 'blocked by #6244; depends on #7; waits on #8; waiting on #9' };
  const map = buildBlockedMap([dependent, { number: 6244, state: 'OPEN' }, { number: 7, state: 'CLOSED' }, { number: 8, state: 'MERGED' }]);
  expect(map.blockedBy.get(6193)).toEqual([6244]);
  expect([...map.unblocks]).toEqual([[6244, [6193]]]);
  const afterClosure = buildBlockedMap([dependent]);
  expect(afterClosure.blockedBy.get(6193)).toEqual([]);
  expect([...afterClosure.unblocks]).toEqual([]);
});

it.each(['    ', '     ', '\t', ' \t', '   \t'])('R437 ignores indented code with prefix %j', prefix => {
  expect(parseBlockedBy(`${prefix}blocked by #6244\n\nDepends on #7`)).toEqual([7]);
});
it('R437 ignores lazy blockquote continuation lines throughout the quoted paragraph', () => {
  expect(parseBlockedBy('> Pre-mortem example\nblocked by #6244\nwaiting on #6193\n\nDepends on #7')).toEqual([7]);
});
it('R437 resumes dependency parsing after a blockquote paragraph ends', () => {
  expect(parseBlockedBy('> example\n\nblocked by #6244')).toEqual([6244]);
});
