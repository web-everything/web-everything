import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ACCEPTED_LABEL, OPEN_PR_CAP_SCOPE_DEFAULTS, resolveOpenPrCapScope, readOpenPrCapScope,
  countOpenPrsForCap, formatOpenPrCap,
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
    expect(countOpenPrsForCap(rows)).toEqual({ total: 5, counted: 2, cardOnly: 2, accepted: 1, countedPrs: ['we#4', 'we#5'], cardOnlyPrs: ['we#1', 'we#3'], acceptedPrs: ['we#2'] });
  });
  it('each switch restores its population, without double counting', () => {
    expect(countOpenPrsForCap(rows, { excludeCardOnly: false, excludeAccepted: true })).toMatchObject({ counted: 3, cardOnly: 0, accepted: 2, countedPrs: ['we#1', 'we#4', 'we#5'] });
    expect(countOpenPrsForCap(rows, { excludeCardOnly: true, excludeAccepted: false })).toMatchObject({ counted: 3, cardOnly: 2, accepted: 0, countedPrs: ['we#2', 'we#4', 'we#5'] });
    expect(countOpenPrsForCap(rows, { excludeCardOnly: false, excludeAccepted: false })).toMatchObject({ counted: 5, cardOnly: 0, accepted: 0 });
  });
  it('formats the count and exclusions', () => {
    expect(formatOpenPrCap(countOpenPrsForCap(rows))).toBe('2 open PRs counted (2 card-only, 1 accepted excluded)');
  });
});
