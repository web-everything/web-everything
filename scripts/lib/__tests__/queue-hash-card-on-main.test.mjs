// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { strandedHashesOnMain, handNumberedNewItems, STRANDED_HASH_GRACE_SECONDS } from '../../check-standards-rules.mjs';
import { mergeGroupHashRefusals } from '../queue-branch-numbering.mjs';

describe('landed hash cards: observed check-standards behavior without PR context', () => {
  const files = ['backlog/xabc123-landed.md'];
  it('currently makes a primary checkout red after the grace window, despite accepting hash births', () => {
    // This is the production check-standards rule, with primary/main context, not a lane or PR exemption.
    const result = strandedHashesOnMain(files, {
      inLane: false, now: () => 10_000, commitTimeFor: () => 10_000 - STRANDED_HASH_GRACE_SECONDS - 1,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('NON-NUMERIC');
    expect(handNumberedNewItems([{ id: 'xabc123-landed', num: 'xabc123' }], files)).toEqual([]);
  });

  it('currently grants a freshly landed main hash card only a temporary grace window', () => {
    expect(strandedHashesOnMain(files, { inLane: false, now: () => 10_000, commitTimeFor: () => 9_999 }).errors).toEqual([]);
  });

  it('allows hash cards through merge-group standards checks when post-merge numbering is enabled', () => {
    expect(mergeGroupHashRefusals({ files, env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group',
      WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: 'false' } })).toEqual([]);
  });
});
