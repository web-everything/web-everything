import { describe, it, expect } from 'vitest';
import { isFixEvidencePath, isDrainTransientPath, committedFixEvidenceFindings } from '../transient-paths.mjs';

const evidence = ['.fix-evidence.md', '.fix-evidence-4965.md', '.fix-4958-evidence.md'];
const ordinary = ['docs/.fix-evidence.md', 'fix-evidence.md', '.fix-gate.txt', '.lane-manifest.json'];

describe('isFixEvidencePath', () => {
  it.each(evidence)('recognizes root evidence %s', (p) => expect(isFixEvidencePath(p)).toBe(true));
  it.each(ordinary)('rejects %s', (p) => expect(isFixEvidencePath(p)).toBe(false));
});
describe('isDrainTransientPath', () => {
  it.each([...evidence, '.lane-manifest.json'])('recognizes transient %s', (p) => expect(isDrainTransientPath(p)).toBe(true));
  it('honours a custom manifest without losing evidence detection', () => {
    expect(isDrainTransientPath('custom.json', 'custom.json')).toBe(true);
    expect(isDrainTransientPath('.lane-manifest.json', 'custom.json')).toBe(false);
    expect(isDrainTransientPath('.fix-evidence.md', 'custom.json')).toBe(true);
    expect(isDrainTransientPath('src/a.js')).toBe(false);
  });
});
describe('committedFixEvidenceFindings', () => {
  it('defaults to no findings', () => expect(committedFixEvidenceFindings({})).toEqual([]));
  it('reports changed evidence only, excluding deletions', () => {
    expect(committedFixEvidenceFindings({ changedFiles: [...evidence, ...ordinary], deletedFiles: [evidence[1]] }))
      .toEqual([evidence[0], evidence[2]]);
  });
  it('deletions are the cure', () => {
    expect(committedFixEvidenceFindings({ changedFiles: evidence, deletedFiles: evidence })).toEqual([]);
    expect(committedFixEvidenceFindings({ deletedFiles: evidence })).toEqual([]);
  });
});
