/**
 * @file scripts/__tests__/close-session-sweep.test.mjs
 * @description Unit proof of the /closing-session learnings SWEEP core (#2614): re-validate the drop-box
 *   against the SCHEMA (the content scrub moved to the publish seam in #3015), dedup the survivors, emit a
 *   ranked memory-candidate list. Proves an entry that
 *   fails re-validation never reaches the candidate list, near-dupes collapse, and an absent drop-box is a
 *   clean no-op (empty candidates, exit-0 shape) — the common, correct close-out case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweep, sweepFile } from '../conveyor/close-session-sweep.mjs';

const e = (kind, area, summary, suggestion = 'fix it') => ({ kind, area, summary, suggestion });

describe('sweep — schema re-validation + dedup', () => {
  it('drops entries that fail SCHEMA re-validation and collapses near-dupes among survivors', () => {
    const raw = [
      e('friction', 'lane gating', 'lane gate reruns full suite for docs only diff'),
      e('friction', 'lane gating', 'the lane gate reruns the full suite even for docs only diffs'),
      e('doc-gap', 'memory docs', 'the memory doc omits the sub-index budget rule'),
      // #3015 — this entry used to be REJECTED by the scrub `validateEntry` ran. That scrub moved to the
      // publish seam, so it now SURVIVES into the candidate list. Kept (not deleted) and inverted, so the
      // suite states the new behaviour rather than silently testing a claim that stopped being true.
      e('friction', 'leak', 'saw the key gh\x70_ABCDEFabcdef0123456789ABCDEF01234567 in a log'),
    ];
    const { candidates, stats } = sweep(raw);
    expect(stats.received).toBe(4);
    expect(stats.rejected).toBe(0);
    expect(stats.valid).toBe(4);
    // two friction near-dupes collapse; the doc-gap and the (now-surviving) leak entry stand alone → 3
    expect(candidates).toHaveLength(3);
    expect(candidates.some((c) => c.summary.includes('ghp_'))).toBe(true);
    const friction = candidates.find((c) => c.kind === 'friction');
    expect(friction.count).toBe(2);
    expect(candidates[0].count).toBeGreaterThanOrEqual(candidates[1].count); // ranked
  });

  it('carries count through as a priority signal and keeps only generalized-lesson fields', () => {
    const { candidates } = sweep([e('improvement', 'x', 'do the thing better')]);
    expect(Object.keys(candidates[0]).sort()).toEqual(['area', 'count', 'kind', 'suggestion', 'suggestions', 'summaries', 'summary']);
  });

  it("a distinct member's suggestion survives into a sweep candidate (review fix 8)", () => {
    // Complete-link keeps the A≁C pair apart, so C's distinct suggestion reaches the red-team as its own
    // candidate rather than being dropped behind a chained cluster representative.
    const raw = [
      e('friction', 'gate', 'alpha beta gamma delta', 'widen the scope'),
      e('friction', 'gate', 'alpha beta gamma epsilon', 'widen the scope'),
      e('friction', 'gate', 'beta gamma epsilon omega', 'rewrite the gate entirely'),
    ];
    const { candidates } = sweep(raw);
    const allSuggestions = candidates.flatMap((c) => c.suggestions);
    expect(allSuggestions).toContain('rewrite the gate entirely');
    expect(allSuggestions).toContain('widen the scope');
  });
});

describe('sweepFile — I/O boundary', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sweep-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('reads a JSONL drop-box and returns ranked candidates', () => {
    const file = join(root, 'box.jsonl');
    writeFileSync(file, [
      JSON.stringify(e('friction', 'lane gating', 'lane gate reruns full suite for docs only diff')),
      JSON.stringify(e('friction', 'lane gating', 'the lane gate reruns the full suite even for docs only diffs')),
    ].join('\n') + '\n');
    const r = sweepFile(file);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].count).toBe(2);
    expect(r.path).toBe(file);
  });

  it('an absent drop-box is a clean no-op (empty candidates)', () => {
    const r = sweepFile(join(root, 'nope.jsonl'));
    expect(r.candidates).toEqual([]);
    expect(r.stats.received).toBe(0);
  });
});
