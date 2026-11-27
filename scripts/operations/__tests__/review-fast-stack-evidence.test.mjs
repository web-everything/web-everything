import { it, expect, vi } from 'vitest';
import { dispatchReviewByMode, checkStackBeforeReview } from '../review-job.mjs';
import { readStackBase, readStackBases, fingerprintOf, renderStackMarker, stackHoldHeading } from '../../conveyor/review-stack-base.mjs';
import * as stackReaders from '../../conveyor/review-stack-base.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40);
const refs = () => new Map([[1, { headRefName: 'lane/one', headRefOid: head, baseRefName: 'main', isCrossRepository: false, author: 'same' }],
  [2, { headRefName: 'lane/two', headRefOid: other, baseRefName: 'lane/missing', isCrossRepository: false, author: 'same' }]]);
const readers = () => ({ strict: true, settingOn: true, readRefs: refs,
  readLanes: () => new Map([['lane/one', head], ['lane/two', other]]), run: args => args.includes(other) ? other : head });
it('strict target lookup ignores an unrelated broken declared stack', () => {
  expect(readStackBase({ ...readers(), pr: 1 })).toBeNull();
});
it('strict target lookup refuses its own broken declared stack', () => {
  expect(() => readStackBase({ ...readers(), pr: 2 })).toThrow('base-branch-missing');
});
it('strict target lookup refuses unreadable target heads', () => {
  expect(() => readStackBase({ ...readers(), pr: 1, run: () => { throw Error('unreadable'); } })).toThrow('heads unreadable');
});
it('strict target lookup refuses a moved target tip even when its declared base is main', () => {
  expect(() => readStackBase({ ...readers(), pr: 1,
    readLanes: () => new Map([['lane/one', other], ['lane/two', other]]) })).toThrow('target-head-untrusted');
});
it('strict target lookup ignores an unrelated moved tip', () => {
  expect(readStackBase({ ...readers(), pr: 1,
    readLanes: () => new Map([['lane/one', head], ['lane/two', head]]) })).toBeNull();
});
it('strict unstacked target ignores unreadable heads by another actor', () => {
  expect(readStackBase({ ...readers(), pr: 1, readRefs: () => {
    const rows = refs(); rows.get(2).author = 'unrelated'; return rows;
  }, run: args => {
    if (args.includes(other)) throw Error('unrelated head');
    return head;
  } })).toBeNull();
});
it('strict ancestry-only stack refuses an unreadable same-actor bottom', () => {
  expect(() => readStackBase({ ...readers(), pr: 2, readRefs: () => {
    const rows = refs(); rows.get(2).baseRefName = 'main'; return rows;
  }, run: args => {
    if (args[0] === 'rev-list' && args.includes(head)) throw Error('bottom unreadable');
    return args.includes(other) ? `${other}\n${head}` : head;
  } })).toThrow('heads unreadable');
});
it.each(['limit', 'failure'])('strict refs refuses %s even with a valid target', kind => {
  const rows = refs();
  if (kind === 'limit') {
    Array.from({ length: 198 }, (_, i) => rows.set(i + 3, { ...rows.get(1), headRefName: `lane/${i + 3}` }));
  } else rows.failure = 'refs-timeout';
  expect(() => readStackBase({ ...readers(), pr: 1, readRefs: () => rows })).toThrow('refs incomplete');
});
it('strict mode is forwarded from dispatch to the real stack reader', () => {
  const stackCheck = vi.fn(args => checkStackBeforeReview({ ...args, env: { WE_STACK_AWARE_REVIEW: '1' },
    readStack: () => null, readThread: () => null }));
  expect(() => dispatchReviewByMode({ mode: 'job', pr: 1, repo: 'web-everything/web-everything', strictStackEvidence: true, stackCheck }))
    .toThrow('stack thread unreadable');
  expect(stackCheck).toHaveBeenCalledWith(expect.objectContaining({ strict: true }));
});
it('checkStackBeforeReview forwards strict to its default readStackBase', () => {
  const read = vi.spyOn(stackReaders, 'readStackBase').mockImplementation(({ strict }) => {
    if (strict) throw Error('strict refs unreadable');
    return null;
  });
  try {
    expect(() => checkStackBeforeReview({ pr: 1, repo: 'web-everything/web-everything', strict: true,
      env: { WE_STACK_AWARE_REVIEW: '1' }, readThread: () => ({ comments: [] }) })).toThrow('strict refs unreadable');
  } finally { read.mockRestore(); }
});
it.each([null, {}])('strict dispatch rejects unknown stack result %s', stack => {
  expect(() => dispatchReviewByMode({ strictStackEvidence: true, stackCheck: () => stack })).toThrow('stack evidence unknown');
});
it.each(['stack fingerprint', 'main fingerprint', 'bottom evidence', 'accept carry'])('strict refusal: %s unreadable', failure => {
  const marker = { v: 1, verdict: 'accept', top: 1, bottom: 2, topHead: head, bottomHead: other,
    contained: other, bottomRef: 'lane/two', fingerprint: fingerprintOf('diff') };
  const base = failure === 'stack fingerprint' ? { pr: 2, ref: 'lane/two', contained: other } : null;
  const thread = { headRefName: 'lane/one', headRefOid: head, comments: [{ viewerDidAuthor: true,
    body: `${stackHoldHeading(2)} Reviewed.\n\n${renderStackMarker(marker)}` }] };
  expect(() => checkStackBeforeReview({ pr: 1, repo: 'web-everything/web-everything', strict: true,
    env: { WE_STACK_AWARE_REVIEW: '1' }, readStack: () => base, readThread: () => thread,
    stackText: () => { throw Error('missing diff'); }, mainText: () => failure === 'main fingerprint' ? null : { scored: true, text: 'diff' },
    readBottom: () => ({ ok: failure !== 'bottom evidence' }), carry: () => ({ ok: false }), log: () => {} }))
    .toThrow(failure.includes('fingerprint') ? 'stack fingerprint unreadable' : failure === 'bottom evidence' ? 'stack bottom evidence unreadable' : 'stack accept carry failed');
});

it.each(['job', 'session'])('fast %s dispatch refuses unreadable stack evidence before spawn', mode => {
  const spawnJob = vi.fn(), spawnAgent = vi.fn();
  expect(() => dispatchReviewByMode({ mode, pr: 1, repo: 'fixture/repo', strictStackEvidence: true,
    expectedHead: 'a'.repeat(40), io: { liveHead: () => 'a'.repeat(40) },
    stackCheck: () => { throw Error('stack unreadable'); }, spawnJob, spawnAgent })).toThrow('stack unreadable');
  expect(spawnJob).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});
it('strict stack reader refuses swallowed refs and tips failures', () => {
  expect(() => readStackBases({ strict: true, settingOn: true, readRefs: () => new Map() })).toThrow('stack refs incomplete');
  expect(() => readStackBases({ strict: true, settingOn: true, readRefs: () => new Map([[1, {}]]), readLanes: () => null })).toThrow('tips unreadable');
});
it('strict stack check refuses unreadable comment evidence', () => {
  expect(() => checkStackBeforeReview({ pr: 1, repo: 'web-everything/web-everything', strict: true,
    env: { WE_STACK_AWARE_REVIEW: '1' }, readStack: () => null, readThread: () => { throw Error('thread unreadable'); } })).toThrow('thread unreadable');
});
