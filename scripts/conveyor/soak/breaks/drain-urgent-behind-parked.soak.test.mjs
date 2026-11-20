import b from './drain-urgent-behind-parked.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);


import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const sources = [
  'scripts/lib/enqueue-on-event.mjs',
  'scripts/conveyor/overlap-yield-enqueueable.mjs',
  'scripts/lib/merge-queue-adaptive-batching.mjs',
];

function fixture(run) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'urgent-soak-'));
  try {
    for (const path of sources) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8'));
    }
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('requires the static fix in the current tree independently of expected-failure registration', () => {
  expect(b.fixPresent(new URL('../../../../', import.meta.url).pathname)).toBe(true);
});

it('fixPresent reads source without importing or running behavior', () => {
  fixture(root => {
    for (const path of sources) appendFileSync(join(root, path), '\nthrow new Error("must never execute");\n');
    expect(b.fixPresent(root)).toBe(true);
  });
});

it.each([
  [sources[0], "label.name === 'priority:urgent'"],
  [sources[1], "!labels.has('ready-to-merge')"],
  [sources[1], "'BEHIND', 'BLOCKED', 'DIRTY'"],
  [sources[1], "'parked', 'hold'"],
  [sources[2], 'const enqueueEligibility = new Map();'],
])('fixPresent detects missing static code in %s: %s', (path, marker) => {
  fixture(root => {
    const target = join(root, path);
    const source = readFileSync(target, 'utf8');
    expect(source).toContain(marker);
    writeFileSync(target, source.replaceAll(marker, 'REMOVED'));
    expect(b.fixPresent(root)).toBe(false);
  });
});

it.each(sources)('unreadable source %s throws before registration', path => {
  fixture(root => {
    rmSync(join(root, path));
    expect(() => b.fixPresent(root)).toThrow();
  });
});
