import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { findUnmarkedLocusRefs as gate } from '../../check-standards-rules.mjs';

// The ruling module carries a local copy of the detector (it sits on the review-authorization floor and must not
// import check-standards-rules.mjs). Evaluate that copy and prove it matches the gate on the same inputs.
const src = readFileSync('scripts/operations/record-referral-ruling.mjs', 'utf8');
const start = src.indexOf('const PATHLIKE_RE');
const end = src.indexOf('function findUnmarkedLocusRefs');
const tail = src.slice(end, src.indexOf('\n}\n', end) + 3);
const local = new Function(`${src.slice(start, end)}\n${tail}\nreturn findUnmarkedLocusRefs;`)();

const SAMPLES = [
  'see scripts/a.mjs and we:scripts/b.mjs',
  'link [we:x](scripts/c.mjs) and @scope/pkg.js and https://e.com/f.md',
  'Node.js, *.test.ts, .d.ts, dup scripts/a.mjs scripts/a.mjs',
  'relatedReport: scripts/z.md\n```\nscripts/fenced.mjs\n```\nreal fui:src/q.ts and src/r.ts:12-14',
];
describe('record-referral-ruling local locus detector', () => {
  it.each(SAMPLES)('matches the gate on %#', (s) => { expect(local(s)).toEqual(gate(s)); });
});
