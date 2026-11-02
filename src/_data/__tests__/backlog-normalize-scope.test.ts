// R372 — the loader flattens a multi-path `scope:` entry so routing, locus and lease arbitration all see one path per entry.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFrozenBacklogDir } from './frozen-backlog';
import { normalizeBriefScope } from '../../../scripts/operations/dispatch-lane.mjs';
import { dispatchPlan } from '../../../scripts/readiness/dispatch-plan.mjs';

const require = createRequire(import.meta.url);
const { normalizeScope } = require('../backlog.js');

describe('backlog loader normalizeScope — multi-path entries (R372)', () => {
  it('retains authored scope only as display data while loading canonical scheduling scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-prefix-'));
    const modulePath = require.resolve('../backlog.js');
    const cached = require.cache[modulePath];
    try {
      writeFileSync(join(dir, '99999-scope.md'), '---\ntitle: Scope\nstatus: open\nscope:\n  - WE:src/A.mjs b.mjs\n  - src/c.mjs\n---\nScope fixture.\n');
      delete require.cache[modulePath];
      const load = withFrozenBacklogDir(dir, () => require('../backlog.js'));
      const item = load().find((card: { num: string }) => card.num === '99999');
      expect(item.scope).toEqual(['we:src/A.mjs', 'we:b.mjs', 'we:src/c.mjs']);
      expect(item.scopeDisplay).toEqual(['WE:src/A.mjs b.mjs', 'src/c.mjs']);
    } finally {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes before planner lease and rival exclusion (send-back item 2)', () => {
    for (const [input, canonical] of [
      ['WE:src/a.mjs', 'we:src/a.mjs'], ['webeverything:src/a.mjs', 'we:src/a.mjs'],
      ['FrontierUI:src/a.mjs', 'fui:src/a.mjs'], ['PLATEAU-APP:src/a.mjs', 'plateau:src/a.mjs'],
      ['src/a.mjs', 'we:src/a.mjs'],
    ]) {
      const scope = normalizeScope([input]);
      const leased = dispatchPlan({ queue: [{ num: 1, scope }], leases: [{ lane: 2, scope: [canonical] }], freeLanes: [3] });
      expect(leased.launch, input).toEqual([]);
      expect(leased.held[0].reason).toBe('overlaps lane-2');
      const rivals = dispatchPlan({ queue: [{ num: 1, scope: [canonical] }, { num: 2, scope }], leases: [], freeLanes: [3, 4] });
      expect(rivals.launch, input).toEqual([{ num: 1, lane: 3 }]);
      expect(rivals.held[0].reason).toBe('overlaps lane-3');
    }
  });
  it('unprefixed pieces inherit the nearest earlier prefix when an entry changes repos', () => {
    expect(normalizeScope(['we:a.mjs b.mjs,fui:c.mjs d.mjs,we:e.mjs f.mjs', 'g.mjs h.mjs']))
      .toEqual(['we:a.mjs', 'we:b.mjs', 'fui:c.mjs', 'fui:d.mjs', 'we:e.mjs', 'we:f.mjs', 'we:g.mjs', 'we:h.mjs']);
  });
  it('splits on whitespace and commas; unprefixed pieces inherit the entry repo prefix', () => {
    expect(normalizeScope(['we:a.mjs b.mjs', 'fui:c.mjs,d.mjs'])).toEqual(['we:a.mjs', 'we:b.mjs', 'fui:c.mjs', 'fui:d.mjs']);
  });
  it('a bare multi-path entry defaults to the dispatching WE repo per piece', () => {
    expect(normalizeScope(['heavy-admission.mjs remote-exec.mjs'])).toEqual(['we:heavy-admission.mjs', 'we:remote-exec.mjs']);
  });
  it('does not inherit a repository prefix across scope entries', () => {
    expect(normalizeScope(['fui:a.mjs b.mjs', 'c.mjs'])).toEqual(['fui:a.mjs', 'fui:b.mjs', 'we:c.mjs']);
  });
  it.each(['we', 'fui', 'plateau', 'plateau-app', 'frontierui', 'webeverything', 'WE', 'FUI', 'custom-repo', 'custom_repo', 'repo2'])(
    'loader and dispatcher canonicalize %s identically for leases, including underscores', (prefix) => {
      const scope = [`${prefix}:a.mjs b.mjs`, 'c.mjs'];
      const canonical = ({ 'plateau-app': 'plateau', frontierui: 'fui', webeverything: 'we' } as Record<string, string>)[prefix.toLowerCase()] ?? prefix.toLowerCase();
      const leaseScope = [`${canonical}:a.mjs`, `${canonical}:b.mjs`, 'we:c.mjs'];
      expect(normalizeScope(scope)).toEqual(leaseScope);
      expect(normalizeBriefScope(scope)).toEqual(leaseScope);
      expect(normalizeBriefScope(normalizeScope(scope))).toEqual(leaseScope);
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
