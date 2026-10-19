import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ACCEPTED_LABEL, OPEN_PR_CAP_SCOPE_DEFAULTS, resolveOpenPrCapScope, readOpenPrCapScope,
  countOpenPrsForCap, formatOpenPrCap, readBuilderPrCapSettings, isBuilderPr,
} from '../open-pr-cap-scope.mjs';
import { REVIEW_LABELS } from '../review-escalation.mjs';
import * as settings from '../settings-files.mjs';

const pr = (number, paths, labels = []) => ({ repo: 'we', number, files: paths.map((path) => ({ repo: 'we', path })), labels });

describe('open PR cap scope', () => {
  afterEach(() => vi.restoreAllMocks());
  it('defaults to the operator ruling', () => {
    expect(Object.isFrozen(OPEN_PR_CAP_SCOPE_DEFAULTS)).toBe(true);
    expect(resolveOpenPrCapScope()).toEqual({ excludeCardOnly: true, excludeAccepted: true, source: { excludeCardOnly: 'default', excludeAccepted: 'default' } });
  });
  it('cascades each key independently through platform, tool, then env', () => {
    const platform = { excludeCardOnly: false, excludeAccepted: false };
    expect(resolveOpenPrCapScope({ platform })).toEqual({ ...platform, source: { excludeCardOnly: 'platform', excludeAccepted: 'platform' } });
    const tool = { excludeCardOnly: true };
    expect(resolveOpenPrCapScope({ platform, tool })).toEqual({ excludeCardOnly: true, excludeAccepted: false, source: { excludeCardOnly: 'tool', excludeAccepted: 'platform' } });
    expect(resolveOpenPrCapScope({ platform, tool, env: { WE_OPEN_PR_CAP_EXCLUDE_CARD_ONLY: 'false', WE_OPEN_PR_CAP_EXCLUDE_ACCEPTED: 'true' } })).toEqual({ excludeCardOnly: false, excludeAccepted: true, source: { excludeCardOnly: 'env', excludeAccepted: 'env' } });
  });
  it.each(['false', null, 0, undefined])('malformed layer value %s falls through', (value) => {
    expect(resolveOpenPrCapScope({ platform: { excludeAccepted: false }, tool: { excludeAccepted: value } })).toMatchObject({ excludeAccepted: false, source: { excludeAccepted: 'platform' } });
  });
  it.each(['TRUE', ' false', '0', '', false, undefined])('malformed env value %s falls through', (value) => {
    expect(resolveOpenPrCapScope({ tool: { excludeCardOnly: false }, env: { WE_OPEN_PR_CAP_EXCLUDE_CARD_ONLY: value } })).toMatchObject({ excludeCardOnly: false, source: { excludeCardOnly: 'tool' } });
  });
  it('reads the feature settings and preserves env precedence', () => {
    expect(settings.readSettings().openPrCap).toEqual(OPEN_PR_CAP_SCOPE_DEFAULTS);
    expect(readOpenPrCapScope({ env: { WE_OPEN_PR_CAP_EXCLUDE_ACCEPTED: 'false' } })).toEqual({ excludeCardOnly: true, excludeAccepted: false, source: { excludeCardOnly: 'tool', excludeAccepted: 'env' } });
  });
  it('falls back without throwing if settings cannot be read', () => {
    vi.spyOn(settings, 'readSettings').mockImplementation(() => { throw new Error('unreadable'); });
    expect(readOpenPrCapScope({ env: {}, platform: { excludeAccepted: false } })).toMatchObject({ excludeAccepted: false, source: { excludeAccepted: 'platform' } });
  });
  it('pins the lightweight accepted label to the review contract', () => {
    expect(ACCEPTED_LABEL).toBe(REVIEW_LABELS.accepted);
  });

  const rows = [pr(1, ['backlog/a.md']), pr(2, ['src/a.js'], ['review:accepted']), pr(3, ['backlog/b.md'], ['review:accepted']), pr(4, ['backlog/c.md', 'src/b.js']), pr(5, [])];
  it('excludes card-only first, accepted second, and counts mixed and empty diffs', () => {
    expect(countOpenPrsForCap(rows)).toEqual({ total: 5, counted: 2, cardOnly: 2, accepted: 1, excludeCardOnly: true, excludeAccepted: true, countedPrs: ['we#4', 'we#5'], cardOnlyPrs: ['we#1', 'we#3'], acceptedPrs: ['we#2'] });
  });
  it('each switch restores its population, without double counting', () => {
    expect(countOpenPrsForCap(rows, { excludeCardOnly: false, excludeAccepted: true })).toMatchObject({ counted: 3, cardOnly: 0, accepted: 2, countedPrs: ['we#1', 'we#4', 'we#5'] });
    expect(countOpenPrsForCap(rows, { excludeCardOnly: true, excludeAccepted: false })).toMatchObject({ counted: 3, cardOnly: 2, accepted: 0, countedPrs: ['we#2', 'we#4', 'we#5'] });
    expect(countOpenPrsForCap(rows, { excludeCardOnly: false, excludeAccepted: false })).toMatchObject({ counted: 5, cardOnly: 0, accepted: 0 });
  });
  it('formats the count and exclusions', () => {
    expect(formatOpenPrCap(countOpenPrsForCap(rows))).toBe('2 of 5 open PRs counted (not counted: 2 card-only, 1 review:accepted) — counted: #4 #5');
  });
  it.each([
    [{ excludeCardOnly: false, excludeAccepted: true }, '3 of 5 open PRs counted (not counted: 2 review:accepted; card-only counted (openPrCap.excludeCardOnly=false)) — counted: #1 #4 #5'],
    [{ excludeCardOnly: true, excludeAccepted: false }, '3 of 5 open PRs counted (not counted: 2 card-only; review:accepted counted (openPrCap.excludeAccepted=false)) — counted: #2 #4 #5'],
    [{ excludeCardOnly: false, excludeAccepted: false }, '5 of 5 open PRs counted (card-only counted (openPrCap.excludeCardOnly=false), review:accepted counted (openPrCap.excludeAccepted=false)) — counted: #1 #2 #3 #4 #5'],
  ])('names disabled exclusions for scope %j', (scope, expected) => {
    const result = countOpenPrsForCap(rows, scope);
    expect(result).toMatchObject(scope);
    expect(formatOpenPrCap(result)).toBe(expected);
  });
  it('caps the counted list at 15, reporting only the remaining counted PRs', () => {
    const openPrs = Array.from({ length: 17 }, (_, i) => pr(i + 1, ['src/a.js']));
    openPrs.push(pr(18, ['backlog/a.md']));
    const listed = Array.from({ length: 15 }, (_, i) => `#${i + 1}`).join(' ');
    expect(formatOpenPrCap(countOpenPrsForCap(openPrs.slice(0, 15)))).toBe(`15 of 15 open PRs counted (not counted: 0 card-only, 0 review:accepted) — counted: ${listed}`);
    expect(formatOpenPrCap(countOpenPrsForCap(openPrs))).toBe(`17 of 18 open PRs counted (not counted: 1 card-only, 0 review:accepted) — counted: ${listed} … (+2 more)`);
  });
  it('keeps repo prefixes only when counted PRs span repos, including beyond the cap', () => {
    const openPrs = Array.from({ length: 15 }, (_, i) => ({ ...pr(i + 1, ['src/a.js']), repo: 'owner/one' }));
    const excluded = { ...pr(20, ['backlog/a.md']), repo: 'owner/two' };
    expect(formatOpenPrCap(countOpenPrsForCap([openPrs[0], excluded]))).toBe('1 of 2 open PRs counted (not counted: 1 card-only, 0 review:accepted) — counted: #1');
    const listed = openPrs.map((p) => `${p.repo}#${p.number}`).join(' ');
    expect(formatOpenPrCap(countOpenPrsForCap([...openPrs, { ...pr(1, ['src/a.js']), repo: 'owner/two' }]))).toBe(`16 of 16 open PRs counted (not counted: 0 card-only, 0 review:accepted) — counted: ${listed} … (+1 more)`);
  });
  it('omits the counted list when no PRs are counted', () => {
    expect(formatOpenPrCap(countOpenPrsForCap([]))).toBe('0 of 0 open PRs counted (not counted: 0 card-only, 0 review:accepted)');
  });
  it('names PRs the builder filter excluded from the total', () => {
    const c = { ...countOpenPrsForCap([pr(1, ['src/a.js'])]), total: 4, nonBuilder: 3 };
    expect(formatOpenPrCap(c)).toBe('1 of 4 open PRs counted (not counted: 3 non-builder, 0 card-only, 0 review:accepted) — counted: #1');
    expect(formatOpenPrCap({ ...c, total: 1, nonBuilder: 0 })).toBe('1 of 1 open PRs counted (not counted: 0 card-only, 0 review:accepted) — counted: #1');
  });
});

describe('builder cap policy', () => {
  it('defaults to builder and logs its source', () => {
    const log = vi.fn();
    expect(readBuilderPrCapSettings({ env: { WE_POLICY_CASCADE_LOG: '1' }, platform: {}, read: () => ({}), log }))
      .toEqual({ maxOpenPrsCounts: 'builder', maxOpenPrsCountsSource: 'standard' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maxOpenPrsCounts="builder" (standard)'));
  });
  it.each([
    [{ platform: { maxOpenPrsCounts: 'all' } }, 'all', 'platform'],
    [{ platform: { maxOpenPrsCounts: 'all' }, read: () => ({ build: { maxOpenPrsCounts: 'builder' } }) }, 'builder', 'tool'],
    [{ read: () => ({ build: { maxOpenPrsCounts: 'all' } }), env: { WE_BUILD_MAX_OPEN_PRS_COUNTS: 'builder' } }, 'builder', 'env'],
    [{ read: () => ({ build: { maxOpenPrsCounts: 'invalid' } }) }, 'builder', 'standard'],
  ])('resolves population and source', (options, value, source) => {
    expect(readBuilderPrCapSettings({ env: {}, platform: {}, read: () => ({}), log: () => {}, ...options }))
      .toEqual({ maxOpenPrsCounts: value, maxOpenPrsCountsSource: source });
  });
  it.each(['lane/42-fix-bug', 'lane/operator-work', 'codex/42-build-work', 'lane/42-building-work'])('does not infer builder ownership from %s', headRefName => {
    expect(isBuilderPr({ headRefName })).toBe(false);
  });
});

it('recognizes assembled prepare PRs without treating per-card retention refs as PR provenance', () => {
  expect(isBuilderPr({ headRefName: 'lane/prepare-batch-7101-3' })).toBe(true);
  expect(isBuilderPr({ headRefName: 'lane/prepare-batch-x123abc-2' })).toBe(true);
  expect(isBuilderPr({ headRefName: 'lane/prep-7101' })).toBe(false);
});

it('cap scope accepts already-resolved real files, including an explicitly unknown list', () => {
  expect(countOpenPrsForCap([{ ...pr(1, ['code.js']), realFiles: ['backlog/123-card.md'] }]).cardOnly).toBe(1);
  expect(countOpenPrsForCap([{ ...pr(1, ['backlog/123-card.md']), realFiles: ['code.js'] }]).counted).toBe(1);
  expect(countOpenPrsForCap([{ ...pr(1, ['backlog/123-card.md']), realFiles: null }]).counted).toBe(1);
});
