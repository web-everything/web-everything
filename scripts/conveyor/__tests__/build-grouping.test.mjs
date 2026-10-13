import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuildGroupingSettings, readBuildGroupingSettings, formatBuildGroupingLine, groupEligible, planBuildGroups, retireMemberWhy } from '../build-grouping.mjs';
import { readDeclaredSettings } from '../../lib/settings-files.mjs';
import { declaredResolvedIdsFromPr } from '../../lib/open-pr-items.mjs';

const defaults = {
  groupSmallFindings: true, groupMin: 3, groupMax: 6, groupMaxSize: 2, groupMaxLoc: 150,
  groupKinds: ['task', 'story'], groupRelatedBy: ['pathPrefix', 'parent', 'disjointFiles'],
  groupPathPrefixDepth: 2, groupRequireSameLocus: true, groupAllowBlockedBy: false,
  groupPrepare: 'per-group', groupMemberFailure: 'requeue-alone',
};
const settings = overrides => ({ ...resolveBuildGroupingSettings(), ...overrides });
const card = (num, extra = {}) => ({ num, kind: 'task', size: 1, scope: [`we:scripts/conveyor/${num}.mjs`], locus: 'we', ...extra });
function plan(rows, { picks = [rows[0]], pool = rows.slice(1), ...options } = {}) {
  return planBuildGroups({ picks, pool, rowsByNum: new Map(rows.map(r => [String(r.num), r])), settings: settings(), ...options });
}

describe('build grouping settings', () => {
  it('uses named standard defaults and sources', () => {
    expect(resolveBuildGroupingSettings()).toEqual({ ...defaults, sources: Object.fromEntries(Object.keys(defaults).map(k => [k, 'standard'])), invalid: [] });
  });
  it('cascades every key independently with sources', () => {
    const platform = { groupMin: 4, groupMax: 8, groupPrepare: 'per-card' };
    const tool = { groupMax: 7, groupMaxSize: 1 };
    const env = { WE_BUILD_GROUP_MAX: '9', WE_BUILD_GROUP_SMALL_FINDINGS: 'false', WE_BUILD_GROUP_KINDS: 'task, story', WE_BUILD_GROUP_RELATED_BY: 'parent,tag' };
    expect(resolveBuildGroupingSettings({ platform, tool, env })).toMatchObject({ groupMin: 4, groupMax: 9, groupPrepare: 'per-card', groupMaxSize: 1, groupSmallFindings: false, groupKinds: ['task', 'story'], groupRelatedBy: ['parent', 'tag'], sources: { groupMin: 'platform', groupMax: 'env', groupMaxSize: 'tool', groupPrepare: 'platform' } });
  });
  it.each([
    ['groupSmallFindings', 'yes'], ['groupMin', 1], ['groupMax', 1], ['groupMaxSize', 0],
    ['groupMaxLoc', 1.5], ['groupKinds', [3]], ['groupRelatedBy', ['unknown']],
    ['groupPathPrefixDepth', 0], ['groupRequireSameLocus', 'false'], ['groupAllowBlockedBy', 1],
    ['groupPrepare', 'other'], ['groupMemberFailure', 'other'],
  ])('ignores and reports invalid %s in each layer', (key, value) => {
    const result = resolveBuildGroupingSettings({ platform: { [key]: value }, tool: { [key]: value } });
    expect(result[key]).toEqual(defaults[key]);
    expect(result.sources[key]).toBe('standard');
    expect(result.invalid).toHaveLength(2);
  });
  it('ignores malformed objects and env values without leaking unknown build keys', () => {
    const result = resolveBuildGroupingSettings({ tool: { groupMin: { bad: 4 }, priority: ['42'] }, env: { WE_BUILD_GROUP_MIN: '', WE_BUILD_GROUP_MAX_LOC: 'Infinity', WE_BUILD_GROUP_SMALL_FINDINGS: 'maybe' } });
    expect(result.groupMin).toBe(3);
    expect(result.groupMaxLoc).toBe(150);
    expect(result.invalid).toHaveLength(4);
    expect(result).not.toHaveProperty('priority');
  });
  it('validates groupMax against the effective groupMin and falls back by layer', () => {
    expect(resolveBuildGroupingSettings({ platform: { groupMax: 10 }, tool: { groupMin: 8, groupMax: 7 } })).toMatchObject({ groupMin: 8, groupMax: 10, sources: { groupMax: 'platform' } });
    const result = resolveBuildGroupingSettings({ env: { WE_BUILD_GROUP_MIN: '9' } });
    expect(result.groupMax).toBeGreaterThanOrEqual(result.groupMin);
  });
  it('parses all remaining environment settings', () => {
    expect(resolveBuildGroupingSettings({ env: { WE_BUILD_GROUP_MAX_SIZE: '1.5', WE_BUILD_GROUP_MAX_LOC: '90', WE_BUILD_GROUP_PATH_PREFIX_DEPTH: '3', WE_BUILD_GROUP_REQUIRE_SAME_LOCUS: '0', WE_BUILD_GROUP_ALLOW_BLOCKED_BY: '1', WE_BUILD_GROUP_PREPARE: 'per-card', WE_BUILD_GROUP_MEMBER_FAILURE: 'fail-group' } })).toMatchObject({ groupMaxSize: 1.5, groupMaxLoc: 90, groupPathPrefixDepth: 3, groupRequireSameLocus: false, groupAllowBlockedBy: true, groupPrepare: 'per-card', groupMemberFailure: 'fail-group' });
  });
  it('loads committed defaults from tool without duplicate leaves', () => {
    const declared = readDeclaredSettings();
    expect(declared.duplicates).toEqual([]);
    expect(declared.settings.build).toMatchObject(defaults);
    const result = readBuildGroupingSettings({ env: {} });
    for (const key of Object.keys(defaults)) expect(result.sources[key]).toBe('tool');
    expect(formatBuildGroupingLine(result)).toContain('build-grouping: groupSmallFindings=true (tool), groupMin=3 (tool)');
    expect(formatBuildGroupingLine(result)).toContain('relatedBy=pathPrefix,parent,disjointFiles (tool)');
    for (const key of Object.keys(defaults)) expect(formatBuildGroupingLine(result)).toContain(` (${result.sources[key]})`);
  });
  it.each(Object.keys(defaults))('reports platform/tool/env precedence for %s', key => {
    const alternatives = { groupSmallFindings: false, groupMin: 2, groupMax: 8, groupMaxSize: 1.5, groupMaxLoc: 90, groupKinds: ['story'], groupRelatedBy: ['parent'], groupPathPrefixDepth: 1, groupRequireSameLocus: false, groupAllowBlockedBy: true, groupPrepare: 'per-card', groupMemberFailure: 'fail-group' };
    const value = alternatives[key];
    const name = `WE_BUILD_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    for (const layer of ['platform', 'tool', 'env']) {
      const options = layer === 'env' ? { env: { [name]: Array.isArray(value) ? value.join(',') : String(value) } } : { [layer]: { [key]: value } };
      expect(resolveBuildGroupingSettings(options)).toMatchObject({ [key]: value, sources: { [key]: layer } });
    }
  });
  it('keeps mutable array results isolated from standard defaults and input layers', () => {
    const first = resolveBuildGroupingSettings();
    first.groupKinds.push('epic');
    expect(resolveBuildGroupingSettings().groupKinds).toEqual(['task', 'story']);
    const tool = { groupKinds: ['story'] };
    resolveBuildGroupingSettings({ tool }).groupKinds.push('epic');
    expect(tool.groupKinds).toEqual(['story']);
  });
  it('reads the actual platform build block underneath the injected tool and env', () => {
    const root = mkdtempSync(join(tmpdir(), 'build-grouping-platform-'));
    try {
      const path = join(root, 'platform.json');
      writeFileSync(path, JSON.stringify({ build: { groupMin: 4, groupPrepare: 'per-card' } }));
      expect(readBuildGroupingSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: path, WE_BUILD_GROUP_MAX_LOC: '80' }, read: () => ({ build: { groupMax: 8 } }) })).toMatchObject({ groupMin: 4, groupMax: 8, groupMaxLoc: 80, groupPrepare: 'per-card', sources: { groupMin: 'platform', groupMax: 'tool', groupMaxLoc: 'env' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('never throws on a failing settings reader', () => {
    expect(() => readBuildGroupingSettings({ env: {}, read: () => { throw new Error('unreadable'); } })).not.toThrow();
    expect(readBuildGroupingSettings({ env: {}, read: () => null }).groupMin).toBe(3);
  });
});

describe('group eligibility', () => {
  it.each([
    [{ size: 2 }, true], [{ size: 3 }, false], [{ size: null, estimatedLoc: 150 }, true],
    [{ size: undefined, estimatedLoc: 151 }, false], [{ size: undefined }, false],
    [{ size: '1' }, false], [{ size: 0 }, false], [{ kind: 'epic' }, false], [{ scope: [] }, false],
  ])('checks sizing, kind and scope: %j', (extra, ok) => {
    expect(groupEligible(card('1', extra), settings()).ok).toBe(ok);
  });
  it('excludes dropped cards by identity', () => {
    expect(groupEligible(card('1'), { ...settings(), groupDropped: new Set([1]) })).toMatchObject({ ok: false, why: 'group-dropped' });
  });
});

describe('pure build group planning', () => {
  it('leaves all picks alone when grouping is off, ineligible, or below minimum', () => {
    const rows = [card('1'), card('2')];
    expect(plan(rows, { picks: rows, pool: [] })).toEqual({ groups: [], absorbed: new Set(), singles: rows });
    expect(plan([...rows, card('3')], { settings: settings({ groupSmallFindings: false }) }).singles).toEqual([rows[0]]);
    expect(plan([card('1', { size: 3 }), ...rows.slice(1), card('3')]).groups).toEqual([]);
  });
  it('caps total size, absorbs picks, deduplicates pool and preserves priority order', () => {
    const rows = Array.from({ length: 8 }, (_, i) => card(String(i + 1)));
    const result = plan(rows, { picks: rows.slice(0, 3), pool: rows.slice(1) });
    expect(result.groups).toEqual([{ lead: '1', members: ['2', '3', '4', '5', '6'], related: { 2: 'pathPrefix', 3: 'pathPrefix', 4: 'pathPrefix', 5: 'pathPrefix', 6: 'pathPrefix' } }]);
    expect(result.absorbed).toEqual(new Set(['2', '3', '4', '5', '6']));
    expect(result.singles).toEqual([]);
  });
  it.each([
    ['pathPrefix', {}, {}], ['parent', { parent: '100' }, { parent: '100' }],
    ['tag', { tags: ['shared'] }, { tags: ['shared', 'other'] }],
    ['disjointFiles', {}, {}], ['locus', {}, {}],
  ])('supports %s only when enabled', (signal, lead, member) => {
    const rows = [card('1', lead), card('2', member)];
    expect(plan(rows, { settings: settings({ groupMin: 2, groupRelatedBy: [signal] }) }).groups[0].related).toEqual({ 2: signal });
    expect(plan(rows, { settings: settings({ groupMin: 2, groupRelatedBy: [] }) }).groups).toEqual([]);
  });
  it('compares directory prefixes at configured depth, stripping repo qualifiers', () => {
    const rows = [card('1'), card('2', { scope: ['scripts/operations/2.mjs'] })];
    expect(plan(rows, { settings: settings({ groupMin: 2, groupRelatedBy: ['pathPrefix'] }) }).groups).toEqual([]);
    expect(plan(rows, { settings: settings({ groupMin: 2, groupRelatedBy: ['pathPrefix'], groupPathPrefixDepth: 1 }) }).groups).toHaveLength(1);
    expect(plan([card('1', { scope: ['we:a.mjs'] }), card('2', { scope: ['we:a.mjs'] })], { settings: settings({ groupMin: 2, groupRelatedBy: ['pathPrefix'], groupPathPrefixDepth: 1 }) }).groups).toEqual([]);
  });
  it('relates to the lead, rather than transitively to members', () => {
    const rows = [card('1', { tags: ['a'] }), card('2', { tags: ['a', 'b'] }), card('3', { tags: ['b'] })];
    expect(plan(rows, { settings: settings({ groupRelatedBy: ['tag'] }) }).groups).toEqual([]);
  });
  it('requires nonempty parents/tags/locus for those signals', () => {
    const rows = [card('1', { locus: undefined }), card('2', { locus: undefined })];
    for (const signal of ['parent', 'tag', 'locus']) expect(plan(rows, { settings: settings({ groupMin: 2, groupRelatedBy: [signal] }) }).groups).toEqual([]);
  });
  it('enforces same locus/repo even for disjoint files, unless disabled', () => {
    for (const extra of [{ locus: 'fui' }, { scope: ['fui:scripts/conveyor/2.mjs'] }]) {
      const rows = [card('1'), card('2', extra)];
      expect(plan(rows, { settings: settings({ groupMin: 2 }) }).groups).toEqual([]);
      expect(plan(rows, { settings: settings({ groupMin: 2, groupRequireSameLocus: false }) }).groups).toHaveLength(1);
    }
  });
  it('uses scope repositories when locus is absent', () => {
    expect(plan([card('1', { locus: undefined }), card('2', { locus: undefined })], { settings: settings({ groupMin: 2 }) }).groups).toHaveLength(1);
  });
  it('checks disjointFiles against all current members and directory overlaps', () => {
    const rows = [card('1'), card('2', { scope: ['we:other/'] }), card('3', { scope: ['we:other/a.mjs'] }), card('4')];
    expect(plan(rows, { settings: settings({ groupRelatedBy: ['disjointFiles'] }) }).groups[0].members).toEqual(['2', '4']);
    expect(plan(rows.slice(0, 3), { settings: settings({ groupRelatedBy: ['locus'] }) }).groups[0].members).toEqual(['2', '3']);
  });
  it.each([['lead', ['2'], []], ['candidate', [], ['1']], ['current member', [], ['3']]])('refuses blockedBy from %s unless allowed', (_name, leadBlockers, secondBlockers) => {
    const rows = [card('1', { blockedBy: leadBlockers }), card('2', { blockedBy: secondBlockers }), card('3')];
    expect(plan(rows).groups).toEqual([]);
    expect(plan(rows, { settings: settings({ groupAllowBlockedBy: true }) }).groups).toHaveLength(1);
  });
  it('excludes dropped leads and members and skips candidates without scope', () => {
    const rows = [card('1'), card('2'), card('3', { scope: [] }), card('4')];
    expect(plan(rows, { exclude: [2] }).groups).toEqual([]);
    expect(plan(rows, { exclude: ['1'] }).singles).toEqual([rows[0]]);
  });
  it('enriches minimal picks and pool IDs from rowsByNum without mutating inputs', () => {
    const rows = [card(1), card(2), card(3)];
    const picks = [{ num: 1, scope: rows[0].scope }];
    const snapshot = JSON.stringify({ rows, picks });
    const result = planBuildGroups({ picks, pool: [2, 3], rowsByNum: Object.fromEntries(rows.map(r => [r.num, r])), settings: settings() });
    expect(result.groups[0]).toMatchObject({ lead: 1, members: [2, 3] });
    expect(result.absorbed).toEqual(new Set([2, 3]));
    expect(JSON.stringify({ rows, picks })).toBe(snapshot);
  });
  it('does not consume tentative members when the minimum is not reached', () => {
    const rows = [card('1', { tags: ['a'] }), card('2', { tags: ['a', 'b'] }), card('3', { tags: ['b'] }), card('4', { tags: ['b'] })];
    const result = plan(rows, { picks: rows.slice(0, 2), pool: rows.slice(2), settings: settings({ groupRelatedBy: ['tag'] }) });
    expect(result.singles).toEqual([rows[0]]);
    expect(result.groups[0]).toMatchObject({ lead: '2', members: ['3', '4'] });
  });
});

describe('member retirement', () => {
  it('keeps claims while the lead is alive or delivered and releases orphaned claims', () => {
    for (const groupMemberFailure of ['requeue-alone', 'fail-group']) {
      expect(retireMemberWhy({ member: '2', leadAlive: true, memberStillQueued: true, groupMemberFailure })).toBeNull();
      expect(retireMemberWhy({ member: '2', leadDelivered: true, memberStillQueued: true, groupMemberFailure })).toBeNull();
      expect(retireMemberWhy({ member: '2', memberStillQueued: true, groupMemberFailure })).toBe('group-lead-gone');
      expect(retireMemberWhy({ member: '2', memberStillQueued: false, groupMemberFailure })).toBe('not-queued');
    }
  });
});

it('resolves each delivered group member via the real PR resolver', () => {
  const paths = ['backlog/4121-member.md', 'backlog/4134-member.md'];
  const diff = paths.map(path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,4 @@\n ---\n kind: story\n-status: open\n+status: active\n ---`).join('\n');
  expect(declaredResolvedIdsFromPr('lane/4200-build', 'Grouped build', { body: 'Resolves #4121, #4134', changedFiles: ['scripts/implementation.mjs', ...paths], diff })).toEqual(['4121', '4134']);
});
