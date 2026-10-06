/**
 * @file scripts/operations/__tests__/free-scope.test.mjs
 * @description Pure conflict and expiry contract tests, including the declared reader/assessor boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { qualifyFile, repoKeyFor, partitionRegistry, registerScope, releaseScope, assessFreeScope, formatFreeScope, freeScopeOperation, parseExcludePr } from '../free-scope.mjs';
const startedAt = '2026-10-05T10:00:00.000Z';
const nowMs = Date.parse(startedAt);
const agent = { agent: 'build-x', purpose: 'build', files: ['we:scripts/lib/'], startedAt };
const pr = { repo: 'web-everything/web-everything', number: 12, title: 'Change lib', url: 'https://example.test/12', files: ['scripts/lib/x.mjs'] };
const assess = (overrides = {}) => assessFreeScope({ files: ['we:scripts/lib/x.mjs'], prs: [], agents: [], nowMs, ...overrides });
describe('free-scope core', () => {
  it('qualifies aliases and repo keys', () => {
    expect([' ./a.mjs ', 'webeverything:a.mjs', 'web-everything:./a.mjs', 'plateau:a.mjs', 'other:a.mjs', ' '].map((f) => qualifyFile(f)))
      .toEqual(['we:a.mjs', 'we:a.mjs', 'we:a.mjs', 'plateau-app:a.mjs', 'other:a.mjs', '']);
    expect(qualifyFile('x.mjs', 'plateau-app')).toBe('plateau-app:x.mjs');
    expect(['web-everything/web-everything', 'plateauapp/plateau-app', 'org/project'].map(repoKeyFor)).toEqual(['we', 'plateau-app', 'project']);
  });
  it('expires at the exact TTL edge and rejects invalid dates', () => {
    expect(partitionRegistry([agent], nowMs + 4 * 3600e3 - 1).live).toEqual([agent]);
    expect(partitionRegistry([agent], nowMs + 4 * 3600e3).stale).toEqual([agent]);
    expect(partitionRegistry([{ ...agent, startedAt: 'bad' }, { ...agent, ttlHours: 1 }], nowMs + 3600e3).stale).toHaveLength(2);
  });
  it('replaces, qualifies, deduplicates and releases without mutating', () => {
    const original = [agent, { ...agent, agent: 'other' }];
    const entries = registerScope(original, { agent: 'build-x', purpose: 'new', files: ['./x.mjs', 'we:x.mjs', ''] }, startedAt);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ agent: 'build-x', purpose: 'new', files: ['we:x.mjs'], startedAt, ttlHours: 4 });
    expect(original[0]).toBe(agent);
    expect(releaseScope([agent, agent], 'build-x')).toEqual({ entries: [], released: 2 });
    expect(releaseScope(original, 'missing').released).toBe(0);
    expect(() => registerScope([], { agent: '', files: ['x'] }, startedAt)).toThrow(TypeError);
    expect(() => registerScope([], { agent: 'x', files: [' '] }, startedAt)).toThrow(TypeError);
  });
  it('names every PR and agent holding a file, including subtrees', () => {
    const verdict = assess({ prs: [pr], agents: [agent, { ...agent, agent: 'exact', files: ['scripts/lib/x.mjs'] }] });
    expect(verdict.status).toBe('occupied');
    expect(verdict.files[0].holders).toHaveLength(3);
    expect(verdict.files[0].holders[0]).toMatchObject({ type: 'pr', number: 12, file: 'we:scripts/lib/x.mjs' });
    expect(verdict.files[0].holders[1]).toMatchObject({ type: 'agent', expiresAt: '2026-10-05T14:00:00.000Z' });
    expect(verdict.occupiedFiles).toEqual(['we:scripts/lib/x.mjs']);
    expect(formatFreeScope(verdict)).toContain('PR #12 "Change lib"');
    expect(formatFreeScope(verdict)).toContain('← agent build-x');
    expect(assess({ prs: [{ ...pr, repo: 'plateauapp/plateau-app' }] }).status).toBe('free');
  });
  it('excludes named holders and ignores but reports stale entries', () => {
    expect(assess({ prs: [pr], agents: [agent], excludeAgent: 'build-x', excludePr: 12 }).status).toBe('free');
    const verdict = assess({ agents: [agent], nowMs: nowMs + 4 * 3600e3 });
    expect(verdict.status).toBe('free');
    expect(verdict.staleAgents[0]).toMatchObject({ agent: 'build-x', ttlHours: 4 });
    expect(verdict.headline).toContain('1 stale registry entry ignored');
    expect(formatFreeScope(verdict)).toContain('stale (ignored):');
    expect(formatFreeScope(verdict)).toContain('FREE      we:scripts/lib/x.mjs');
  });
  it('excludes only the named repo and PR pair, never an equal number in another repo', () => {
    const other = { ...pr, repo: 'plateauapp/plateau-app', title: 'Other repo same number' };
    // The scope spans both repos, and PR #12 in each touches the same relative path.
    const both = { files: ['we:scripts/lib/x.mjs', 'plateau-app:scripts/lib/x.mjs'], prs: [pr, other], excludePr: 12 };
    const heldBy = (verdict) => verdict.files.map((row) => row.holders.map((h) => h.repo));
    const defaulted = assess(both);
    expect(defaulted.status).toBe('occupied');
    expect(heldBy(defaulted)).toEqual([[], ['plateauapp/plateau-app']]);
    const plateau = assess({ ...both, excludeRepo: 'plateauapp/plateau-app' });
    expect(heldBy(plateau)).toEqual([['web-everything/web-everything'], []]);
    expect(heldBy(assess({ ...both, excludeRepo: 'nobody/else' }))).toEqual([['web-everything/web-everything'], ['plateauapp/plateau-app']]);
  });
  it('resolves an exclude-pr spec to a repo slug and number', () => {
    expect(parseExcludePr('12')).toEqual({ repo: 'web-everything/web-everything', number: 12 });
    expect(parseExcludePr('plateau-app#7')).toEqual({ repo: 'plateauapp/plateau-app', number: 7 });
    expect(parseExcludePr('plateauapp/plateau-app#7')).toEqual({ repo: 'plateauapp/plateau-app', number: 7 });
    expect(parseExcludePr(undefined)).toEqual({ repo: 'web-everything/web-everything', number: 0 });
    for (const bad of ['bad', '-1', '1.5', 'nope#3', '#3', 'we#x']) expect(() => parseExcludePr(bad)).toThrow(TypeError);
  });
  it('never declares a partial snapshot free and rejects empty scope', () => {
    const unreadable = [{ repo: 'bad/repo', error: 'unavailable' }];
    expect(assess({ unreadable })).toMatchObject({ status: 'unknown', headline: 'UNKNOWN — could not read open PRs for bad/repo' });
    expect(assess({ unreadable, prs: [pr] }).status).toBe('occupied');
    expect(() => assess({ files: [] })).toThrow('free-scope: give --files=a,b or --card=<id>');
  });
  it('declares only read and assess compute steps and forwards inputs', () => {
    expect(() => freeScopeOperation({})).toThrow(TypeError);
    const collect = vi.fn(() => ({ files: ['x.mjs'], nowMs, prs: [], agents: [] }));
    const declaration = freeScopeOperation({ collect });
    expect(declaration.name).toBe('free-scope');
    expect(declaration.verdictFrom).toBe('assess');
    expect(collect).not.toHaveBeenCalled();
    expect(declaration.steps.map((s) => [s.name, s.step.kind])).toEqual([['read', 'compute'], ['assess', 'compute']]);
    const read = declaration.steps[0].step.fn({ input: { files: 'x.mjs', card: '' } });
    expect(collect).toHaveBeenCalledWith({ files: 'x.mjs', card: '' });
    expect(declaration.steps[1].step.fn({ findings: { read }, input: { excludeAgent: '', excludePr: 0 } }).status).toBe('free');
  });
});
