import { it, expect } from 'vitest';
import { parseBlockedBy, parseUnblocks, buildBlockedMap, sortUnblockersFirst } from '../pr-blocked-by.mjs';
it('parses all four dependency phrases, case-insensitively and deduplicates', () => {
  expect(parseBlockedBy('Blocked by #6244; DEPENDS ON #2; waits on #3; waiting on #4; blocked by #2')).toEqual([6244, 2, 3, 4]);
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

it('parses line-based Unblocks lists, deduplicates and rejects unsafe PR numbers', () => {
  expect(parseUnblocks('Unblocks: #6193, #7 #8\nUNBLOCKS #7\nprose Unblocks #9\nUnblocks: #0 #9007199254740992')).toEqual([6193, 7, 8]);
});
it('excludes quoted, fenced, indented and inline Unblocks examples including lazy continuations', () => {
  expect(parseUnblocks('> example\nUnblocks #1\n\n```md\nUnblocks #2\n```\n\n    Unblocks #3\n\n`Unblocks #4`\nUnblocks `#5`\nUnblocks: #6')).toEqual([6]);
  expect(parseUnblocks('`example\nUnblocks #7')).toEqual([]);
});
it('builds body-only Unblocks edges for open targets, merges both directions and sorts the unblocker first', () => {
  const prs = [{ number: 6193, body: 'blocked by #6244' },
    { number: 6244, body: 'Unblocks: #6193, #7 #6244 #8 #9', comments: [{ body: 'Unblocks #10' }], refusalReason: 'Unblocks #10' },
    { number: 7 }, { number: 8, state: 'CLOSED' }, { number: 10 }];
  const map = buildBlockedMap(prs);
  expect(map.blockedBy.get(6193)).toEqual([6244]);
  expect(map.blockedBy.get(7)).toEqual([6244]);
  expect(map.blockedBy.get(6244)).toEqual([]);
  expect(map.blockedBy.get(10)).toEqual([]);
  expect(map.unblocks.get(6244)).toEqual([6193, 7]);
  expect(sortUnblockersFirst(prs.map(p => ({ ...p, unblocks: map.unblocks.get(p.number) } )))[0].number).toBe(6244);
});
