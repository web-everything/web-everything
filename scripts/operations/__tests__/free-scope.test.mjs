/**
 * @file scripts/operations/__tests__/free-scope.test.mjs
 * @description Pure conflict and expiry contract tests, including the declared reader/assessor boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { qualifyFile, repoKeyFor, partitionRegistry, registerScope, releaseScope, assessFreeScope, formatFreeScope, freeScopeOperation, parseExcludePr,
  choosePrFileSet, prHoldsFile, GH_LIST_FILE_CAP, GH_API_FILE_CAP } from '../free-scope.mjs';
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
  it('refuses to overwrite a live same-named entry owned by another worker, and releases only its own', () => {
    const first = registerScope([], { agent: 'fix-widget', purpose: 'a', files: ['x.mjs'], owner: 'T1' }, startedAt);
    expect(first[0].owner).toBe('T1');
    const soon = new Date(nowMs + 60e3).toISOString();
    // A second worker with the same slug but its own owner token is refused, not silently replacing the first.
    expect(() => registerScope(first, { agent: 'fix-widget', purpose: 'b', files: ['y.mjs'], owner: 'T2' }, soon)).toThrow(/fix-widget.*owner/);
    expect(() => registerScope(first, { agent: 'fix-widget', purpose: 'b', files: ['y.mjs'] }, soon)).toThrow(/owner/);
    expect(registerScope(first, { agent: 'fix-widget', purpose: 'a2', files: ['z.mjs'], owner: 'T1' }, soon)[0]).toMatchObject({ owner: 'T1', files: ['we:z.mjs'] });
    // an empty owner (`--owner=$UNSET`) is the tokenless flow, consistently on register and release
    const bare = registerScope([], { agent: 'w', purpose: 'a', files: ['x.mjs'], owner: '' }, startedAt);
    expect(bare[0]).not.toHaveProperty('owner');
    expect(registerScope(bare, { agent: 'w', purpose: 'a', files: ['x.mjs'], owner: '' }, soon)).toHaveLength(1);
    expect(releaseScope(bare, 'w', '').released).toBe(1);
    // An expired entry is no longer anyone's: a new owner may take the name.
    const later = new Date(nowMs + 5 * 3600e3).toISOString();
    expect(registerScope(first, { agent: 'fix-widget', purpose: 'b', files: ['y.mjs'], owner: 'T2' }, later)).toHaveLength(1);
    // release by a different owner leaves the first worker's entry in place
    expect(releaseScope(first, 'fix-widget', 'T2')).toEqual({ entries: first, released: 0 });
    expect(releaseScope(first, 'fix-widget', 'T1')).toEqual({ entries: [], released: 1 });
    // the pre-push recheck excludes only the caller's own entry when it names its owner
    const other = registerScope([], { agent: 'fix-widget', purpose: 'a', files: ['x.mjs'], owner: 'T1' }, startedAt);
    const seen = (excludeOwner) => assess({ files: ['we:x.mjs'], agents: other, excludeAgent: 'fix-widget', excludeOwner, nowMs: nowMs + 1 });
    expect(seen('T2').status).toBe('occupied');
    expect(seen('T1').status).toBe('free');
    expect(seen(undefined).status).toBe('free');
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
  it('reads every unproven file as unknown, in rows, lists and text, when the snapshot is incomplete', () => {
    const unreadable = [{ repo: 'bad/repo', error: 'unavailable' }];
    const files = ['we:scripts/lib/x.mjs', 'we:scripts/other.mjs'];
    const partial = assess({ files, unreadable });
    expect(partial.status).toBe('unknown');
    expect(partial.files.map((row) => [row.file, row.state, row.free])).toEqual([
      ['we:scripts/lib/x.mjs', 'unknown', false], ['we:scripts/other.mjs', 'unknown', false]]);
    expect(partial.freeFiles).toEqual([]);
    expect(partial.unknownFiles).toEqual(files);
    const text = formatFreeScope(partial);
    expect(text).not.toMatch(/\bFREE\b/);
    expect(text).toContain('UNKNOWN   we:scripts/other.mjs');
    // A file with a named holder is still OCCUPIED; only the unobserved one turns unknown.
    const mixed = assess({ files, unreadable, prs: [pr] });
    expect(mixed.files.map((row) => row.state)).toEqual(['occupied', 'unknown']);
    expect(mixed.freeFiles).toEqual([]);
    expect(mixed.headline).toContain('0 of 2 files free');
    expect(formatFreeScope(mixed)).not.toMatch(/\bFREE\b/);
    // A complete snapshot still proves a file free.
    expect(assess({ files }).files.map((row) => [row.state, row.free])).toEqual([['free', true], ['free', true]]);
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

describe('new backlog cards never collide (live 2026-10-08)', () => {
  // The live case: a worker's scope listed `we:backlog/` to file its one card, and 20 open PRs that each only
  // ADDED their own new card made the whole folder read OCCUPIED. A brand-new card file cannot collide.
  const cardPr = (n, extra = {}) => ({ repo: 'web-everything/web-everything', number: 4400 + n, title: `PR ${n}`, url: 'u',
    files: [`backlog/x${n}-card.md`], added: [`backlog/x${n}-card.md`], ...extra });
  const twenty = Array.from({ length: 20 }, (_, i) => cardPr(i));
  it('a backlog/ folder scope is FREE when open PRs only add their own new cards', () => {
    const verdict = assess({ files: ['we:backlog/', 'we:scripts/lib/x.mjs'], prs: twenty });
    expect(verdict.status).toBe('free');
  });
  it('a PR editing an EXISTING card still holds that card and the folder', () => {
    const edit = { ...cardPr(99), files: ['backlog/x100-existing.md'], added: [] };
    expect(assess({ files: ['we:backlog/x100-existing.md'], prs: [...twenty, edit] }).status).toBe('occupied');
    expect(assess({ files: ['we:backlog/'], prs: [...twenty, edit] }).status).toBe('occupied');
  });
  it('a new card still collides with a scope naming that exact file', () => {
    expect(assess({ files: ['we:backlog/x3-card.md'], prs: twenty }).status).toBe('occupied');
  });
  it('only cards are exempt: a newly added code file still holds its folder; a PR without change types is unchanged', () => {
    const code = { ...pr, files: ['scripts/lib/new.mjs'], added: ['scripts/lib/new.mjs'] };
    expect(assess({ files: ['we:scripts/lib/'], prs: [code] }).status).toBe('occupied');
    const legacy = { ...cardPr(1), added: undefined };
    expect(assess({ files: ['we:backlog/'], prs: [legacy] }).status).toBe('occupied');
  });
  it('two card-filing folder claims (registered backlog/) do not block each other; an existing card still does', () => {
    const filer = { agent: 'filer', purpose: 'card', files: ['we:backlog/'], startedAt };
    expect(assess({ files: ['we:backlog/'], agents: [filer] }).status).toBe('free');
    expect(assess({ files: ['we:backlog/x100-existing.md'], agents: [filer] }).status).toBe('occupied');
  });
});

describe('a PR holds only the files git says it changes against current main (xl5oele, live 2026-10-08)', () => {
  const WE = 'web-everything/web-everything';
  const ok = (files, added = []) => ({ ok: true, files, added });
  const many = (n) => Array.from({ length: n }, (_, i) => `scripts/f${i}.mjs`);
  it('prefers git, then the paginated API, then an uncapped gh list', () => {
    const net = ok(['a.mjs'], ['a.mjs']), paged = ok(['a.mjs', 'main-only.mjs']), listed = ok(['a.mjs', 'main-only.mjs']);
    expect(choosePrFileSet({ net, paged, listed })).toEqual({ source: 'git', files: ['a.mjs'], added: ['a.mjs'] });
    expect(choosePrFileSet({ net: { ok: false, reason: 'no head' }, paged, listed }).source).toBe('github-api');
    expect(choosePrFileSet({ net: { ok: false, reason: 'no head' }, listed })).toMatchObject({ source: 'github-list', added: [] });
  });
  it('a gh list at its 100-file cap is unresolved only when neither git nor the API is readable', () => {
    const capped = ok(many(GH_LIST_FILE_CAP));
    expect(choosePrFileSet({ net: ok(many(150)), listed: capped })).toMatchObject({ source: 'git' });
    expect(choosePrFileSet({ net: { ok: false, reason: 'x' }, paged: ok(many(150)), listed: capped }).files).toHaveLength(150);
    const none = choosePrFileSet({ net: { ok: false, reason: 'no local checkout' }, paged: { ok: false, reason: 'HTTP 502' }, listed: capped });
    expect(none.source).toBeNull();
    expect(none.reason).toMatch(/git: no local checkout; github api: HTTP 502; lists 100 files \(the gh cap\)/);
    expect(choosePrFileSet({ paged: ok(many(GH_API_FILE_CAP)) }).source).toBeNull();
    expect(choosePrFileSet({}).reason).toBe('no file list was read');
  });
  it('answers "does PR P hold file F?" with the same rules as the assessor', () => {
    const pr = { repo: WE, number: 1, files: ['scripts/lib/x.mjs', 'backlog/x1-new.md'], added: ['backlog/x1-new.md'] };
    expect(prHoldsFile(pr, 'we:scripts/lib/x.mjs')).toBe(true);
    expect(prHoldsFile(pr, 'we:scripts/lib/')).toBe(true);
    expect(prHoldsFile(pr, 'scripts/lib/y.mjs')).toBe(false);
    expect(prHoldsFile(pr, 'we:backlog/')).toBe(false);
    expect(prHoldsFile(pr, 'we:backlog/x1-new.md')).toBe(true);
    expect(prHoldsFile({ ...pr, repo: 'plateauapp/plateau-app' }, 'we:scripts/lib/x.mjs')).toBe(false);
  });
  // Replay of the live facts: gh's list for #4502/#4508/#4512 included main's own jury-core/review-pr/verdict-ledger
  // changes, and #4461 listed 100 files. git's net sets (merge-base with current main) held none of the three.
  it('replays the live case: git net sets clear the false holders and #4461 no longer forces UNKNOWN', () => {
    const scope = ['we:scripts/lib/jury-core.mjs', 'we:scripts/operations/review-pr.mjs', 'we:scripts/lib/verdict-ledger.mjs'];
    const stale = ['scripts/lib/jury-core.mjs', 'scripts/operations/review-pr.mjs', 'scripts/lib/verdict-ledger.mjs'];
    const facts = [
      { number: 4502, listed: ok([...stale, 'scripts/lib/ledger-git.mjs']), net: ok(['scripts/lib/ledger-git.mjs']) },
      { number: 4508, listed: ok([...stale.slice(0, 2), 'scripts/lane-pool.mjs']), net: ok(['scripts/lane-pool.mjs']) },
      { number: 4512, listed: ok([...stale.slice(0, 2), 'scripts/conveyor/admission.mjs']), net: ok(['scripts/conveyor/admission.mjs']) },
      { number: 4461, listed: ok(many(GH_LIST_FILE_CAP)), net: ok(['scripts/conveyor/quiet-hours.mjs']) },
      { number: 4524, listed: ok(stale), net: ok(stale) },
    ];
    const prs = facts.map(({ number, listed, net }) => ({ repo: WE, number, title: `PR ${number}`, url: 'u', ...choosePrFileSet({ net, listed }) }));
    const after = assessFreeScope({ files: scope, prs, nowMs, unreadable: [] });
    expect(after.status).toBe('occupied');
    expect(after.files.map((r) => r.holders.map((h) => h.number))).toEqual([[4524], [4524], [4524]]);
    expect(assessFreeScope({ files: scope, prs, nowMs, excludePr: 4524 }).status).toBe('free');
    // Before (gh lists only): every PR that merged main "held" the files, and the capped #4461 made it UNKNOWN.
    const before = facts.map(({ number, listed }) => ({ repo: WE, number, title: `PR ${number}`, url: 'u', files: listed.files }));
    const old = assessFreeScope({ files: scope, prs: before, nowMs, excludePr: 4524, unreadable: [{ repo: WE, error: 'PR #4461 lists 100 files' }] });
    expect(old.files[0].holders.map((h) => h.number)).toEqual([4502, 4508, 4512]);
  });
});
