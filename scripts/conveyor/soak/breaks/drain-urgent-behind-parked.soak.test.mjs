import b from './drain-urgent-behind-parked.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);


import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(enqueue, run) {
  const root = mkdtempSync(join(tmpdir(), 'urgent-soak-'));
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(root, 'scripts/lib/enqueue-on-event.mjs'), enqueue);
    writeFileSync(join(root, 'scripts/merge-ai-prs.mjs'), `export const buildOverlapRows = () => ({});
      export const planLabelDrain = () => ({ ready: [{ num: 2 }] });`);
    writeFileSync(join(root, 'scripts/conveyor/land-overlap-yield.mjs'), 'export const overlapYieldWaits = () => ({});');
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('fixPresent detects behaviour rather than a callable seam', () => {
  fixture('export const planCatchUp = () => ({ run: [{ num: 1 }] });', root => {
    expect(b.fixPresent(root)).toBe(false);
  });
  fixture('export const planCatchUp = () => ({ run: [{ num: 2 }] });', root => {
    expect(b.fixPresent(root)).toBe(true);
  });
});

it.each([
  ['import failure', 'throw new Error("broken import");'],
  ['probe failure', 'export const planCatchUp = () => { throw new Error("broken probe"); };'],
  ['malformed report', 'export const planCatchUp = () => { console.log = () => {}; return { run: [{ num: 2 }] }; };'],
])('%s throws before expected-failure registration can mask it', (_name, source) => {
  fixture(source, root => expect(() => b.fixPresent(root)).toThrow(/probe/i));
});
