import { describe, expect, it } from 'vitest';
import { pinnedLeafGitFixture } from './fixtures/pinned-leaf-git-fixture.mjs';
import { resolvePinnedDiffBasis, requireScoredNetDiff } from '../lib/pinned-diff-basis.mjs';
import { computeNetDiffSignals } from '../merge-ai-prs.mjs';

function signals(files) {
  const headSha = 'a'.repeat(40);
  // Exercise the serialized form used by real CLI shims as well as the production reader.
  const fixture = Function(`return (${pinnedLeafGitFixture})`)();
  const exec = (_cmd, args) => fixture(args, [{ headRefOid: headSha, files }]);
  const basis = resolvePinnedDiffBasis({ exec, headSha });
  return requireScoredNetDiff(computeNetDiffSignals({ exec, basis }), headSha);
}

describe('pinned CLI fixture evidence', () => {
  it('keeps every file and its full change count in paired stats and patch evidence', () => {
    const sig = signals([
      { path: 'backlog/leaf.md', additions: 1, deletions: 0 },
      { path: 'scripts/lib/gate-config.mjs', additions: 3, deletions: 2 },
    ]);
    expect(sig.changedFiles).toEqual(['backlog/leaf.md', 'scripts/lib/gate-config.mjs']);
    expect(sig.diffLines).toBe(6);
    expect(sig.netDiffText.text.match(/^\+leaf$/gm)).toHaveLength(4);
    expect(sig.netDiffText.text.match(/^-base$/gm)).toHaveLength(2);
    expect(sig.netDiffText.text).toContain('diff --git a/scripts/lib/gate-config.mjs b/scripts/lib/gate-config.mjs');
  });

  it('preserves default one-line leaf evidence and explicit empty diffs', () => {
    expect(signals([{ path: 'leaf.txt' }]).diffLines).toBe(1);
    const empty = signals([]);
    expect(empty.changedFiles).toEqual([]);
    expect(empty.diffLines).toBe(0);
    expect(empty.netDiffText.text).toBe('');
  });

  it('refuses unknown commits and diff bases instead of inventing empty evidence', () => {
    const prefix = ['-c', 'core.attributesFile=/dev/null'];
    const prs = [{ headRefOid: 'a'.repeat(40), files: [{ path: 'leaf.txt' }] }];
    expect(() => pinnedLeafGitFixture([...prefix, 'rev-parse', 'unknown^{commit}'], prs)).toThrow('unknown fixture commit');
    expect(() => pinnedLeafGitFixture([...prefix, 'diff', 'bad-base', prs[0].headRefOid], prs)).toThrow('unknown fixture diff basis');
  });
});
