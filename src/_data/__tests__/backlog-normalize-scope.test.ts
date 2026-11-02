// R372 — the loader flattens a multi-path `scope:` entry so routing, locus and lease arbitration all see one path per entry.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { normalizeBriefScope } from '../../../scripts/operations/dispatch-lane.mjs';

const require = createRequire(import.meta.url);
const { normalizeScope } = require('../backlog.js');

describe('backlog loader normalizeScope — multi-path entries (R372)', () => {
  it('unprefixed pieces inherit the nearest earlier prefix when an entry changes repos', () => {
    expect(normalizeScope(['we:a.mjs b.mjs,fui:c.mjs d.mjs,we:e.mjs f.mjs', 'g.mjs h.mjs']))
      .toEqual(['we:a.mjs', 'we:b.mjs', 'fui:c.mjs', 'fui:d.mjs', 'we:e.mjs', 'we:f.mjs', 'g.mjs', 'h.mjs']);
  });
  it('splits on whitespace and commas; unprefixed pieces inherit the entry repo prefix', () => {
    expect(normalizeScope(['we:a.mjs b.mjs', 'fui:c.mjs,d.mjs'])).toEqual(['we:a.mjs', 'we:b.mjs', 'fui:c.mjs', 'fui:d.mjs']);
  });
  it('a bare multi-path entry stays bare per piece', () => {
    expect(normalizeScope(['heavy-admission.mjs remote-exec.mjs'])).toEqual(['heavy-admission.mjs', 'remote-exec.mjs']);
  });
  it('does not inherit a repository prefix across scope entries', () => {
    expect(normalizeScope(['we:a.mjs b.mjs', 'c.mjs'])).toEqual(['we:a.mjs', 'we:b.mjs', 'c.mjs']);
  });
  it.each(['we', 'fui', 'plateau', 'plateau-app', 'frontierui', 'webeverything', 'WE', 'FUI', 'custom-repo', 'custom_repo', 'repo2'])(
    'loader and dispatcher agree on repo prefix %s, including underscores', (prefix) => {
      const scope = [`${prefix}:a.mjs b.mjs`, 'c.mjs'];
      const expected = [`${prefix}:a.mjs`, `${prefix}:b.mjs`, 'c.mjs'];
      expect(normalizeScope(scope)).toEqual(expected);
      expect(normalizeBriefScope(scope)).toEqual(expected);
      expect(normalizeBriefScope(normalizeScope(scope))).toEqual(expected);
    },
  );
  it('keeps a multi-path entry holding a glob UNSPLIT, so dispatch refuses it (fail closed)', () => {
    expect(normalizeScope(['we:scripts/a*b.mjs we:docs/x.md'])).toEqual(['we:scripts/a*b.mjs we:docs/x.md']);
    expect(normalizeScope(['we:scripts/a*b.mjs'])).toEqual(['we:scripts/a*b.mjs']);
  });
  it('keeps the single-entry shape and the absent/empty/blank collapse', () => {
    expect(normalizeScope(['we:scripts/lib/'])).toEqual(['we:scripts/lib/']);
    expect(normalizeScope([' , ', ''])).toBeUndefined();
    expect(normalizeScope('we:a')).toBeUndefined();
  });
});
