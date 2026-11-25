import { describe, it, expect, vi } from 'vitest';
import { runApproveHead } from '../approve-head.mjs';

const A = 'c'.repeat(40);
const mk = (over = {}) => {
  const gh = vi.fn((args) => args.includes('--jq') && args[1].includes('pulls') ? A : args[1] === 'user' ? 'op' : '1');
  return { gh, env: {}, readRulings: () => 'R474 guard config\nR475 other\n', ...over };
};
const posted = gh => gh.mock.calls.some(c => c[0].includes('POST'));

describe('approve-head', () => {
  it('unknown ruling id writes nothing', () => {
    const deps = mk();
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R999'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a ruling id that only prefixes a known one is unknown', () => {
    const deps = mk();
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R47'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('an unreadable rulings file writes nothing', () => {
    const deps = mk({ readRulings: () => { throw new Error('nope'); } });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a missing App token writes nothing', () => {
    const gh = vi.fn((args) => { if (args[1]?.includes('installation')) throw new Error('403'); return args[1] === 'user' ? 'op' : A; });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ gh })).ok).toBe(false);
    expect(posted(gh)).toBe(false);
  });
  it('a known ruling writes a record bound to the PR head', () => {
    const deps = mk();
    const r = runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps);
    expect(r).toMatchObject({ ok: true, headSha: A });
    expect(posted(deps.gh)).toBe(true);
  });
});
