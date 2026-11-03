import { it, expect } from 'vitest';
import { parseBlockedBy, parseUnblocks, buildBlockedMap, sortUnblockersFirst } from '../pr-blocked-by.mjs';
it('PR #6301 prose and code examples never create dependency edges', () => {
  const body = 'For example, #6193 blocked by #6244 would be shown as ...\n\n```md\nFor example, #6193 blocked by #6244 would be shown as ...\nBlocked-by: #6244\nUnblocks: #6193\n```';
  const map = buildBlockedMap([{ number: 6301, body }, { number: 6244 }, { number: 6193 }]);
  expect([...map.blockedBy.values()]).toEqual([[], [], []]);
  expect([...map.unblocks]).toEqual([]);
  expect(buildBlockedMap([{ number: 6301, body: body + '\nUnblocks: #6244' }, { number: 6244 }]).blockedBy.get(6244)).toEqual([6301]);
});
it('only body trailers and current tooling refusals contribute links', () => {
  const map = buildBlockedMap([{ number: 1, body: 'Blocked-by: #2', headRefOid: 'head',
    comments: [{ body: 'blocked by #3', author: { login: 'chalbert' } }],
    daemons: [{ kind: 'refusal', name: 'fix-dispatch-daemon', at: 1000, head: 'head', reason: 'waiting on #4' }] },
    { number: 2 }, { number: 3 }, { number: 4 }], { now: 1000 });
  expect(map.blockedBy.get(1)).toEqual([2, 4]);
});
it('R437 retains blocking edges only for targets confirmed open in the current listing', () => {
  const dependent = { number: 6193, body: 'Blocked-by: #6244, #7, #8, #9' };
  const map = buildBlockedMap([dependent, { number: 6244, state: 'OPEN' }, { number: 7, state: 'CLOSED' }, { number: 8, state: 'MERGED' }]);
  expect(map.blockedBy.get(6193)).toEqual([6244]);
  expect([...map.unblocks]).toEqual([[6244, [6193]]]);
  const afterClosure = buildBlockedMap([dependent]);
  expect(afterClosure.blockedBy.get(6193)).toEqual([]);
  expect([...afterClosure.unblocks]).toEqual([]);
});

it.each(['    ', '     ', '\t', ' \t', '   \t'])('R437 ignores indented code with prefix %j', prefix => {
  expect(parseBlockedBy(`${prefix}Blocked-by: #6244\n\nBlocked-by: #7`)).toEqual([7]);
});
it('R437 ignores lazy blockquote continuation lines throughout the quoted paragraph', () => {
  expect(parseBlockedBy('> Pre-mortem example\nBlocked-by: #6244\nBlocked-by: #6193\n\nBlocked-by: #7')).toEqual([7]);
});
it('R437 resumes dependency parsing after a blockquote paragraph ends', () => {
  expect(parseBlockedBy('> example\n\nBlocked-by: #6244')).toEqual([6244]);
});

it('parses line-based Unblocks lists, deduplicates and rejects unsafe PR numbers', () => {
  expect(parseUnblocks('Unblocks: #6193, #7 #8\nUNBLOCKS: #7\nprose Unblocks #9\nUnblocks: #0 #9007199254740992')).toEqual([6193, 7, 8]);
});
it('excludes quoted, fenced, indented and inline Unblocks examples including lazy continuations', () => {
  expect(parseUnblocks('> example\nUnblocks: #1\n\n```md\nUnblocks: #2\n```\n\n    Unblocks: #3\n\n`Unblocks: #4`\nUnblocks: `#5`\nUnblocks: #6')).toEqual([6]);
  expect(parseUnblocks('`example\nUnblocks: #7')).toEqual([]);
});
it('builds body-only Unblocks edges for open targets, merges both directions and sorts the unblocker first', () => {
  const prs = [{ number: 6193, body: 'Blocked-by: #6244' },
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

it('parses CRLF body trailers with case-insensitive keys and optional leading spaces', () => {
  expect(parseBlockedBy('description\r\n  bLoCkEd-By: #2, #3\r\n')).toEqual([2, 3]);
  expect(parseUnblocks(' Unblocks: #2\r\n')).toEqual([2]);
});


it.each(['Blocked-by', 'Unblocks'])('%s trailers inside closed multiline inline-code spans never create edges', key => {
  const parse = key === 'Blocked-by' ? parseBlockedBy : parseUnblocks;
  for (const delimiter of ['`', '``']) {
    const body = `${delimiter}example\n${key}: #2\n${delimiter}\n${key}: #3`;
    expect(parse(body)).toEqual([3]);
    const map = buildBlockedMap([{ number: 1, body }, { number: 2 }, { number: 3 }]);
    expect(map.blockedBy.get(1)).toEqual(key === 'Blocked-by' ? [3] : []);
    expect(map.blockedBy.get(2)).toEqual([]);
    expect(map.blockedBy.get(3)).toEqual(key === 'Unblocks' ? [1] : []);
    expect(map.unblocks.get(2)).toBeUndefined();
  }
});
it.each(['Blocked-by', 'Unblocks'])('%s trailers inside unterminated multiline inline-code spans never create edges', key => {
  const parse = key === 'Blocked-by' ? parseBlockedBy : parseUnblocks;
  for (const delimiter of ['`', '``']) {
    const body = `${delimiter}example\n${key}: #2`;
    expect(parse(body)).toEqual([]);
    const map = buildBlockedMap([{ number: 1, body }, { number: 2 }]);
    expect([...map.blockedBy.values()]).toEqual([[], []]);
    expect([...map.unblocks]).toEqual([]);
  }
});

it.each(['Blocked-by', 'Unblocks'])('%s parsing preserves escaped backticks and does not close spans with shorter runs', key => {
  const parse = key === 'Blocked-by' ? parseBlockedBy : parseUnblocks;
  expect(parse('\\`literal\n' + key + ': #2')).toEqual([2]);
  expect(parse('``example ` nested\n' + key + ': #2\n``\n' + key + ': #3')).toEqual([3]);
  expect(parse('\\``example\n' + key + ': #2\n`\n' + key + ': #3')).toEqual([3]);
});
