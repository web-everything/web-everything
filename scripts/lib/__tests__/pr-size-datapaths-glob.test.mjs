/** delivery.sizeDataPaths: fixtures/vectors/traceability are data; protocol schema.json still counts. */
import { describe, it, expect } from 'vitest';
import { planSizeGrowth } from '../pr-size-admission.mjs';
import { loadPrSizeSettingsFile } from '../pr-size-settings.mjs';

const settings = loadPrSizeSettingsFile(undefined, { platform: {}, env: {} });
const lines = (rows) => planSizeGrowth({
  numstatText: rows.map(([n, p]) => `${n}\t0\t${p}\0`).join(''), settings }).lines;

describe('sizeDataPaths globs', () => {
  it('2000 fixture lines plus 50 code lines count 50', () => {
    expect(lines([[2000, 'src/x/__fixtures__/a.json'], [50, 'src/x/a.mjs']])).toBe(50);
  });
  it('vectors, fixtures and traceability are data', () => {
    expect(lines([[500, 'protocols/p/v1/vectors/a.json'], [500, 'protocols/p/fixtures/b.json'],
      [500, 'protocols/p/v1/traceability.json'], [1, 'src/a.mjs']])).toBe(1);
  });
  it('protocol schema.json still counts', () => {
    expect(lines([[400, 'protocols/p/v1/schema.json']])).toBe(400);
  });
  it('does not over-match: nested non-fixture json and other traceability paths count', () => {
    expect(lines([[10, 'src/x/__fixtures__/sub/a.json'], [10, 'protocols/p/traceability.json'],
      [10, 'src/x/vectors/a.json']])).toBe(30);
  });
});
