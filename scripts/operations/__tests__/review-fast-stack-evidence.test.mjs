import { it, expect, vi } from 'vitest';
import { dispatchReviewByMode, checkStackBeforeReview } from '../review-job.mjs';
import { readStackBases } from '../../conveyor/review-stack-base.mjs';

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
