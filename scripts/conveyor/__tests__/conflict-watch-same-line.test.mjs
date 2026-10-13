import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadSameLineConflictSetting, resolveSameLineConflictSetting } from '../conflict-watch-same-line.mjs';
import { watchParkedPrConflicts, buildConflictFindingBody, buildSupersedeStandDownComment, defaultPostConflictFinding, CONFLICT_LABEL } from '../parked-pr-conflict-watch.mjs';
import { buildStandDownComment, WATCHER_STAND_DOWN_ACTOR } from '../stand-down.mjs';

const setting = value => ({ conflictWatch: { sameLineConflict: value } });
const labels = (...names) => names.map(name => ({ name }));
const marker = actor => ({ body: buildStandDownComment({ actor, reason: 'conflict' }), author: { login: 'web-everything' } });
const watcher = () => marker(WATCHER_STAND_DOWN_ACTOR);
const supersede = () => ({ body: buildSupersedeStandDownComment({ number: 5017 }), author: { login: 'web-everything' } });

function harness({ thread = [], prLabels = labels('review:pending'), mode = 'fixer', ...overrides } = {}) {
  const order = [];
  const pr = { number: 5017, headRefName: 'lane/builder-priority', baseRefName: 'main', mergeable: 'CONFLICTING',
    labels: prLabels, files: [{ path: 'docs/agent/platform-decisions.md' }] };
  const postFinding = vi.fn(() => order.push('finding'));
  const postStandDown = vi.fn();
  const postSupersedeComment = vi.fn(() => { order.push('supersede'); thread.push(supersede()); });
  const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), postComment: vi.fn() };
  const options = { repo: 'o/n', sameLineConflict: mode, listPrs: () => [pr], provider, postFinding, postStandDown,
    postSupersedeComment, listPrComments: vi.fn(() => thread), listPrFiles: () => pr.files,
    listPrPatches: () => ({ [pr.files[0].path]: '@@ -1 +1 @@\n-old rule\n+new rule' }),
    listMainStatutePatches: () => ({ [pr.files[0].path]: '@@ -1 +1 @@\n-old rule\n+main rule' }),
    computeConflictingPaths: () => [pr.files[0].path], computeConflictDisposition: () => 'real',
    labelRemovedAtMs: () => null, labelAgeMs: () => Infinity, ...overrides };
  return { sweep: () => watchParkedPrConflicts(options), postFinding, postStandDown, postSupersedeComment, provider, order, options };
}

describe('same-line conflict setting', () => {
  it('cascades standard → platform → repo → env', () => {
    expect(resolveSameLineConflictSetting()).toMatchObject({ value: 'fixer', source: 'standard' });
    expect(resolveSameLineConflictSetting({ platform: setting('stand-down') })).toMatchObject({ value: 'stand-down', source: 'platform' });
    expect(resolveSameLineConflictSetting({ platform: setting('stand-down'), repo: setting('fixer') })).toMatchObject({ value: 'fixer', source: 'repo' });
    expect(resolveSameLineConflictSetting({ repo: setting('fixer'), env: { WE_CONFLICT_WATCH_SAME_LINE: 'stand-down' } })).toMatchObject({ value: 'stand-down', source: 'env' });
  });
  it.each(['platform', 'repo', 'env'])('ignores and reports invalid %s values', source => {
    const args = { platform: setting('stand-down'), [source]: source === 'env' ? { WE_CONFLICT_WATCH_SAME_LINE: 'invalid' } : setting('invalid') };
    const result = resolveSameLineConflictSetting(args);
    expect(result.value).toBe(source === 'platform' ? 'fixer' : 'stand-down');
    expect(result.ignored).toEqual([expect.objectContaining({ source })]);
  });
  it('uses injectable readers and logs the effective setting once', () => {
    const log = vi.fn();
    const options = { env: {}, readFile: () => JSON.stringify(setting('stand-down')), readDeclared: () => ({ settings: setting('fixer'), errors: [], duplicates: [] }), log };
    expect(loadSameLineConflictSetting(options)).toMatchObject({ value: 'fixer', source: 'repo' });
    loadSameLineConflictSetting(options);
    expect(log.mock.calls).toEqual([['parked-pr-conflict-watch · conflictWatch.sameLineConflict=fixer (source: repo)']]);
  });
  it('ignores malformed blocks and unreadable layers with diagnostics', () => {
    expect(resolveSameLineConflictSetting({ platform: { conflictWatch: null }, repo: setting('stand-down') })).toMatchObject({ value: 'stand-down', ignored: [expect.objectContaining({ source: 'platform' })] });
    const result = loadSameLineConflictSetting({ env: {}, readFile: () => { throw new Error('bad JSON'); }, readDeclared: () => { throw new Error('bad repo'); }, log: vi.fn() });
    expect(result).toMatchObject({ value: 'fixer', source: 'standard' });
    expect(result.ignored.map(x => x.source)).toEqual(['platform', 'repo']);
  });
});

describe('same-line routing — live #5017 (2026-10-13)', () => {
  it('fresh statute conflict goes to a fixer with accurate alert wording', () => {
    const h = harness();
    expect(h.sweep()[0].routedTo).toBe('reconcile-finding (same-line conflict → fixer)');
    expect(h.postFinding).toHaveBeenCalledWith(expect.objectContaining({ sameLineConflict: true }));
    expect(h.postStandDown).not.toHaveBeenCalled();
    expect(h.provider.postComment.mock.calls[0][2]).toContain('fix agent');
    expect(h.provider.postComment.mock.calls[0][2]).not.toContain('judgment call for a human');
  });
  it('explicit stand-down retains the prior route', () => {
    const h = harness({ mode: 'stand-down' });
    expect(h.sweep()[0].routedTo).toBe('stand-down');
    expect(h.postStandDown).toHaveBeenCalledOnce();
    expect(h.postFinding).not.toHaveBeenCalled();
  });
  it('posts finding before supersede for the live shape and skips the second sweep', () => {
    const h = harness({ thread: [watcher()], prLabels: labels('review:changes', 'review-round:2', CONFLICT_LABEL) });
    expect(h.sweep()[0].routedTo).toBe('reconcile-finding (same-line conflict → fixer, marker superseded)');
    expect(h.order).toEqual(['finding', 'supersede']);
    expect(h.postFinding).toHaveBeenCalledWith(expect.objectContaining({ sameLineConflict: true }));
    h.sweep();
    expect(h.order).toEqual(['finding', 'supersede']);
  });
  it('stand-down mode leaves the live watcher marker alone', () => {
    const h = harness({ mode: 'stand-down', thread: [watcher()], prLabels: labels('review:changes', CONFLICT_LABEL) });
    h.sweep();
    expect(h.order).toEqual([]);
    expect(h.options.listPrComments).not.toHaveBeenCalled();
  });
  it('the common unchanged tick reads no comments', () => {
    const h = harness({ listPrs: () => [{ number: 5017, mergeable: 'MERGEABLE', labels: labels('review:pending') }] });
    h.sweep();
    expect(h.options.listPrComments).not.toHaveBeenCalled();
  });
  it('a failed supersede leaves a retry on the next sweep', () => {
    const h = harness({ thread: [watcher()], prLabels: labels('review:changes', CONFLICT_LABEL) });
    h.postSupersedeComment.mockImplementationOnce(() => { throw new Error('supersede failed'); });
    expect(h.sweep()[0].error).toBe('supersede failed');
    expect(h.sweep()[0].supersededStandDown).toBe(true);
    expect(h.order).toEqual(['finding', 'finding', 'supersede']);
  });
  it('supersede wording explains the new routing rule without claiming disjoint hunks', () => {
    const body = buildSupersedeStandDownComment({ number: 5017 }, { sameLineConflict: true });
    expect(body).toContain('fixer first');
    expect(body).not.toContain('does NOT overlap');
  });
  it('never supersedes a fix agent stand-down', () => {
    const h = harness({ thread: [marker('conveyor fix agent')], prLabels: labels('review:changes', CONFLICT_LABEL) });
    h.sweep();
    expect(h.order).toEqual([]);
  });
  it('a failed finding posts no supersede', () => {
    const h = harness({ thread: [watcher()], prLabels: labels('review:changes', CONFLICT_LABEL), postFinding: () => { throw new Error('write failed'); } });
    expect(h.sweep()[0].error).toBe('write failed');
    expect(h.postSupersedeComment).not.toHaveBeenCalled();
  });
  it('rechecks review:human genuine conflicts through the fixer', () => {
    const h = harness({ thread: [watcher()], prLabels: labels('review:human', CONFLICT_LABEL) });
    expect(h.sweep()[0].routedTo).toBe('reconcile-finding (same-line conflict → fixer, marker superseded)');
    expect(h.order).toEqual(['finding', 'supersede']);
  });
  it('grace-due statute conflict goes to the fixer', () => {
    const h = harness({ prLabels: labels('review:accepted', 'ready-to-merge', CONFLICT_LABEL) });
    expect(h.sweep()[0].routedTo).toBe('reconcile-finding (same-line conflict → fixer)');
    expect(h.postFinding).toHaveBeenCalledWith(expect.objectContaining({ sameLineConflict: true }));
    expect(h.postStandDown).not.toHaveBeenCalled();
  });
  it.each(['existing finding', 'empty thread', 'failed read'])('grace-due fixer with unknown episode boundary: %s', scenario => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const thread = scenario === 'existing finding' ? [{
      body: buildConflictFindingBody({ num: 5017 }, { sameLineConflict: true }),
      author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(),
    }] : [];
    const h = harness({
      thread, now, prLabels: labels('review:accepted', 'ready-to-merge', CONFLICT_LABEL),
      labelRemovedAtMs: () => null,
      ...(scenario === 'failed read' ? {
        listPrComments: vi.fn(() => { throw new Error('comment read failed'); })
          .mockReturnValueOnce(thread).mockReturnValueOnce(thread),
      } : {}),
    });
    expect(h.sweep()[0].routedTo).toBe('reconcile-finding (same-line conflict → fixer)');
    expect(h.postFinding).toHaveBeenCalledTimes(scenario === 'empty thread' ? 1 : 0);
    expect(h.options.listPrComments).toHaveBeenCalledTimes(3);
    expect(h.postStandDown).not.toHaveBeenCalled();
  });
  it.each([{ prLabels: labels('review:pending') }, { prLabels: labels('review:accepted', CONFLICT_LABEL) }])('dedups same-line findings for an active episode (%j)', ({ prLabels }) => {
    const thread = [{ body: buildConflictFindingBody({ num: 5017 }, { sameLineConflict: true }),
      author: { login: 'web-everything' }, createdAt: new Date().toISOString() }];
    const h = harness({ thread, prLabels, labelRemovedAtMs: () => 0 });
    h.sweep();
    expect(h.postFinding).not.toHaveBeenCalled();
  });
  it('the production finding adapter forwards the same-line instructions', () => {
    let body;
    defaultPostConflictFinding({ pr: { number: 5017 }, repo: 'o/n', sameLineConflict: true,
      exec: (_command, argv) => { body = readFileSync(argv.find(arg => arg.startsWith('--body-file=')).slice('--body-file='.length), 'utf8'); } });
    expect(body).toContain('no rebase, no force-push');
    expect(body).toContain('Genuine same-line conflict');
  });
  it('the finding mandates merge, both intents, narrow scope, evidence and safe stand-down', () => {
    const body = buildConflictFindingBody({ num: 5017 }, { sameLineConflict: true });
    for (const text of ['same-line', 'no rebase, no force-push', 'BOTH', 'no unrelated edits', 'either/or', 'node scripts/conveyor/stand-down.mjs 5017 --reason=conflict', 'before/after']) expect(body).toContain(text);
    expect(body).not.toContain('Rebase or merge');
  });
});
