import { describe, it, expect, vi } from 'vitest';
import { runApproveHead } from '../approve-head.mjs';

const A = 'c'.repeat(40);
const mk = (over = {}) => {
  const gh = vi.fn((args) => args.includes('--jq') && args[1].includes('pulls') ? A : args[1] === 'user' ? 'chalbert' : '1');
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
  it('a ruling id followed by letters or digits does not match (exact, anchored)', () => {
    for (const text of ['R474X guard config\n', 'x mentions R474 in passing\n', 'R4745 other\n']) {
      const deps = mk({ readRulings: () => text });
      expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
      expect(posted(deps.gh)).toBe(false);
    }
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ readRulings: () => '- **R474** (operator): x\n' })).ok).toBe(true);
  });
  it('a non-operator login writes nothing', () => {
    const gh = vi.fn((args) => args.includes('--jq') && args[1].includes('pulls') ? A : args[1] === 'user' ? 'mallory' : '1');
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ gh })).ok).toBe(false);
    expect(posted(gh)).toBe(false);
  });
  it('a missing or failed operator identity refuses and writes nothing', () => {
    const gh = vi.fn((args) => { if (args[1] === 'user') throw new Error('401'); return args[1]?.includes('pulls') ? A : '1'; });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ gh })).ok).toBe(false);
    expect(posted(gh)).toBe(false);
    const empty = vi.fn((args) => args[1] === 'user' ? '' : args[1]?.includes('pulls') ? A : '1');
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ gh: empty })).ok).toBe(false);
    expect(posted(empty)).toBe(false);
  });
  it('WE_RULINGS_FILE in the environment is not an approval authority', () => {
    const deps = { gh: mk().gh, env: { WE_RULINGS_FILE: '/nonexistent/forged.md' } };
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R987654321'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('an unreadable rulings file writes nothing', () => {
    const deps = mk({ readRulings: () => { throw new Error('nope'); } });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a missing App token writes nothing', () => {
    const gh = vi.fn((args) => { if (args[1]?.includes('installation')) throw new Error('403'); return args[1] === 'user' ? 'chalbert' : A; });
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
