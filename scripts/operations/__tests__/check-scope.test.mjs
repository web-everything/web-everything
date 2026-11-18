import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScope } from '../check-scope.mjs';
import { collectFreeScope, readRegistry, OPEN_PR_LIMIT } from '../free-scope-io.mjs';
import { PROSE_SCOPE_GLOBS, isProseScopeFile } from '../../lib/prose-scope-globs.mjs';

const now = Date.parse('2026-11-18T12:00:00Z');
const agent = { agent: 'lane-3', owner: 'holder', lane: 3, item: '1055', purpose: 'test',
  files: ['we:scripts/a.mjs'], startedAt: new Date(now).toISOString(), ttlHours: 4 };
const snapshot = overrides => ({ prs: [], agents: [], unreadable: [], ...overrides });
const run = (overrides, options = {}) => checkScope({ declaredFiles: ['scripts/a.mjs'], now,
  collect: () => snapshot(overrides), ...options });

describe('checkScope shared admission', () => {
  it('reports PR overlap with repo and number', () => {
    expect(run({ prs: [{ repo: 'web-everything/web-everything', number: 7, files: ['scripts/a.mjs'] }] }))
      .toMatchObject({ ok: false, overlaps: [{ file: 'we:scripts/a.mjs', pr: { number: 7, repo: 'web-everything/web-everything' } }] });
  });
  it('reports registry agent overlap, lane and item', () => {
    expect(run({ agents: [agent] })).toMatchObject({ ok: false,
      overlaps: [{ file: 'we:scripts/a.mjs', agent: 'lane-3', lane: 3, item: '1055' }] });
  });
  it('allows disjoint scope and ignores expired agents', () => {
    expect(run({ agents: [{ ...agent, files: ['we:scripts/b.mjs'] }] }).ok).toBe(true);
    expect(run({ agents: [{ ...agent, startedAt: '2000-01-01' }] }).ok).toBe(true);
  });
  it('qualifies scopes and preserves subtree matching from the shared assessor', () => {
    expect(run({ agents: [{ ...agent, files: ['we:scripts/'] }] }).ok).toBe(false);
  });
  it('normalizes dotted paths and refuses repo-escaping ones', () => {
    expect(run({ agents: [agent] }, { declaredFiles: ['we:scripts/../scripts/a.mjs'] }).ok).toBe(false);
    expect(run({}, { declaredFiles: ['we:../outside.mjs'] })).toMatchObject({ ok: false, reason: expect.stringContaining('escapes') });
  });
  it('excludes only the named owner when supplied', () => {
    expect(run({ agents: [agent] }, { excludeAgent: agent.agent, excludeOwner: 'holder' }).ok).toBe(true);
    expect(run({ agents: [agent] }, { excludeAgent: agent.agent, excludeOwner: 'other' }).ok).toBe(false);
  });
  it('allows prose-only scopes without collecting evidence', () => {
    const collect = vi.fn(() => { throw new Error('must not read'); });
    expect(checkScope({ declaredFiles: ['we:docs/a/b.md', 'backlog/card.md'], collect })).toEqual({ ok: true, overlaps: [] });
    expect(collect).not.toHaveBeenCalled();
    expect(Object.isFrozen(PROSE_SCOPE_GLOBS)).toBe(true);
    expect(isProseScopeFile('we:docs/a.ts')).toBe(false);
  });
  it('drops prose while checking the remaining files', () => {
    const collect = vi.fn(() => snapshot({ agents: [agent] }));
    expect(checkScope({ declaredFiles: ['docs/a.md', 'scripts/a.mjs'], collect, now }).ok).toBe(false);
    expect(collect.mock.calls[0][0].files).toBe('we:scripts/a.mjs');
  });
  it('fails closed on unreadable repositories even when an overlap is known', () => {
    for (const agents of [[], [agent]]) {
      expect(run({ agents, unreadable: [{ repo: 'we', error: 'unavailable' }] })).toMatchObject({ ok: false,
        unreadable: [{ repo: 'we' }], reason: expect.stringContaining('could not read') });
    }
    expect(run({ status: 'unknown' }).ok).toBe(false);
  });
  it('fails closed on thrown reads and incomplete snapshots without throwing', () => {
    expect(run({}, { collect: () => { throw new Error('permission denied'); } })).toMatchObject({ ok: false, reason: expect.stringContaining('permission denied') });
    expect(run({}, { collect: () => ({ prs: [] }) }).ok).toBe(false);
    expect(checkScope().ok).toBe(false);
  });
  it('fails closed when the shared reader hits its open-PR bound', () => {
    const rows = Array.from({ length: OPEN_PR_LIMIT }, (_, i) => ({ number: i + 1, files: [] }));
    const collect = options => collectFreeScope({ ...options, registryPath: join(tmpdir(), 'absent-scope-registry'),
      exec: () => JSON.stringify(rows), gitDirFor: () => null });
    expect(run({}, { collect })).toMatchObject({ ok: false, reason: expect.stringContaining('could not read') });
  });
  it('fails closed on corrupt registry JSON and invalid persisted entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-scope-'));
    const registryPath = join(dir, 'registry.json');
    try {
      writeFileSync(registryPath, '{broken');
      const collect = options => collectFreeScope({ ...options, registryPath, exec: () => '[]', gitDirFor: () => null });
      expect(run({}, { collect })).toMatchObject({ ok: false, reason: expect.stringContaining('cannot read registry') });
      for (const bad of [null, {}, { ...agent, startedAt: 'invalid' }, { ...agent, files: 'oops' }]) {
        writeFileSync(registryPath, JSON.stringify({ entries: [bad] }));
        expect(run({}, { collect: () => snapshot({ agents: readRegistry(registryPath) }) })).toMatchObject({ ok: false,
          reason: expect.stringContaining('corrupt scope registry') });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
