import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as policyApi from '../fix-scope-policy.mjs';
import { filterFixesByInFlightScope, planFixesFromReconcile } from '../reconcile-fix-dispatch.mjs';
const F = 'we:scripts/merge-ai-prs.mjs';
const NOW = Date.parse('2026-10-12T12:00:00Z');
const policy = (overrides = {}) => policyApi.resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: overrides }) });
const entry = (pr, extra = {}) => ({ pr, scope: [F], ...extra });
const claim = (pr, extra = {}) => ({ heartbeatAt: new Date(NOW).toISOString(), meta: { pr, scope: [F], ...extra } });
const gate = (planned, claims = [], overrides = {}, options = {}) => filterFixesByInFlightScope(planned, [], claims, { now: NOW, maxWaitMinutes: null, rebaseExempt: null, policy: policy({ overlapGranularity: 'file', ...overrides }), ...options });

describe('live region head freshness', () => {
  // The production callback with injected IO: unit dispatch deliberately disables region IO.
  const run = ({ holderHead, candidateHead = 'C', observedHead = null }) => {
    const heads = [], reads = [], merges = [];
    const holderEntries = new Map([[1, { headRefOid: holderHead }]]);
    const regionReader = {
      hunksFor: sha => {
        heads.push(sha);
        const line = sha === 'A' ? 10 : 100;
        return sha ? new Map([['scripts/merge-ai-prs.mjs', [[line, line]]]]) : null;
      },
      mergeConflicts: (a, b) => { merges.push([a, b]); return a && b ? b !== 'A' : null; },
    };
    const regionOverlap = policyApi.createLiveRegionOverlap({ holderEntries, readPrHeads: (_root, prs) => {
      reads.push(...prs); return new Map(prs.map(pr => [pr, observedHead]));
    }, regionReader, policy: policy(), root: '/unused' });
    const out = gate([entry(2, { headRefOid: candidateHead, claim: claim(2, { headSha: 'A' }) })],
      [claim(1, { headSha: 'A' })], { overlapGranularity: 'region', priorityBypass: false }, { holderEntries, regionOverlap });
    return { out, heads, reads, merges };
  };
  it('uses the current holder and candidate heads instead of their acquisition heads', () => {
    const { out, heads, merges } = run({ holderHead: 'B' });
    expect(out.planned).toEqual([]);
    expect(heads).toEqual(['C', 'B']);
    expect(merges).toEqual([['C', 'B']]);
  });
  it('reads the current holder head when only a claim head is available', () => {
    const { out, heads, reads } = run({ observedHead: 'B' });
    expect(out.planned).toEqual([]);
    expect(heads).toEqual(['C', 'B']);
    expect(reads).toEqual([1]);
  });
  it('retains the file hold when current head observation fails', () => {
    const { out, heads, reads } = run({});
    expect(out.planned).toEqual([]);
    expect(out.scopeDecisions[0]).toMatchObject({ failedClosed: true });
    expect(heads).toEqual(['C', null]);
    expect(reads).toEqual([1]);
  });
});

describe('defaults and cascade', () => {
  it('exports and resolves standard defaults', () => {
    expect(policy().value).toEqual({ holdMode: 'active-session', overlapGranularity: 'region', regionMarginLines: 20, priorityBypass: true, stalledAfterMinutes: 30, fastTrackLabels: ['fast-track', 'priority:urgent'], waitForLandingHolder: { enabled: true, holderStates: ['review:accepted', 'in-merge-queue'] } });
    expect(policy().value).toEqual(policyApi.FIX_SCOPE_DEFAULTS);
  });
  it('resolves each env override', () => {
    expect(policyApi.resolveFixScopePolicy({ env: { WE_FIX_SCOPE_HOLD_MODE: 'pr-lifetime', WE_FIX_SCOPE_OVERLAP_GRANULARITY: 'file', WE_FIX_SCOPE_REGION_MARGIN_LINES: '40', WE_FIX_SCOPE_PRIORITY_BYPASS: 'off', WE_FIX_SCOPE_STALLED_AFTER_MINUTES: '15' }, platform: {}, readTool: () => ({}) }).value).toMatchObject({ holdMode: 'pr-lifetime', overlapGranularity: 'file', regionMarginLines: 40, priorityBypass: false, stalledAfterMinutes: 15 });
    for (const v of ['on', 'true', '1', 'off', 'false', '0']) expect(policyApi.resolveFixScopePolicy({ env: { WE_FIX_SCOPE_PRIORITY_BYPASS: v }, platform: {}, readTool: () => ({}) }).value.priorityBypass).toBe(['on', 'true', '1'].includes(v));
  });
  it('layers tool over platform and ignores invalid values', () => {
    expect(policy({ holdMode: 'pr-lifetime' }).sources.holdMode).toBe('tool');
    const p = policyApi.resolveFixScopePolicy({ env: {}, platform: { regionMarginLines: 50 }, readTool: () => ({ fixScope: { holdMode: 'banana' } }) });
    expect(p.value.holdMode).toBe('active-session'); expect(p.invalid).toContain('tool.holdMode="banana"'); expect(p.value.regionMarginLines).toBe(50);
  });
  it('reads build priority through all layers', () => {
    const readTool = () => ({ build: { priority: [12, '#13', '14'] } });
    expect(policyApi.resolveOperatorPriorityPrs({ env: {}, platform: {}, readTool })).toEqual({ prs: new Set([12, 13, 14]), source: 'tool' });
    expect(policyApi.resolveOperatorPriorityPrs({ env: { WE_BUILD_PRIORITY: '#20, 21 22' }, platform: {}, readTool })).toEqual({ prs: new Set([20, 21, 22]), source: 'env' });
    expect(policyApi.resolveOperatorPriorityPrs({ env: {}, platform: { priority: [9] }, readTool: () => ({}) }).source).toBe('platform');
  });
});
describe('holdMode', () => {
  const planned = [entry(5009, { scope: [F, 'we:other.mjs'] }), entry(5057)];
  const claims = [claim(99, { scope: ['we:other.mjs'] })];
  it('releases refused waiters in active-session', () => {
    const out = gate(planned, claims); expect(out.planned.map(e => e.pr)).toEqual([5057]);
    expect(out.scopeDecisions).toContainEqual(expect.objectContaining({ pr: 5057, holder: 5009, rule: 'holdMode', decision: 'admitted' }));
  });
  it('retains refused waiters in pr-lifetime', () => { expect(gate(planned, claims, { holdMode: 'pr-lifetime' }).refusals[1].why).toContain('waiting 2nd behind #5009'); });
  it('retains live claims and accepted fixes', () => { expect(gate([entry(2)], [claim(1)]).planned).toEqual([]); expect(gate([entry(1), entry(2)]).planned.map(e => e.pr)).toEqual([1]); });
  it('releases expired claims', () => { expect(gate([entry(2)], [{ ...claim(1), heartbeatAt: new Date(NOW - 11 * 60000).toISOString() }]).planned).toHaveLength(1); });
});
describe('region', () => {
  const diff = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -10,2 +10 @@\n-old\n-old\n+new\n@@ -80,0 +80,1 @@\n+insert\n@@ -100 +101 @@\n-old\n+new\n';
  it('parses old-side zero-context hunks including insertions', () => { expect(policyApi.parseUnifiedZeroHunks(diff).get('x.js')).toEqual([[10, 11], [80, 80], [100, 100]]); });
  it('widens both ranges', () => { expect(policyApi.rangesIntersect([[10, 10]], [[50, 50]], 20)).toBe(true); expect(policyApi.rangesIntersect([[10, 10]], [[51, 51]], 20)).toBe(false); });
  it.each([[100, false, false], [40, false, true], [100, true, true], [100, null, true]])('decides regions %s conflict %s', (line, conflict, overlap) => {
    const regionOverlap = () => policyApi.regionOverlapDecision({ file: 'x.js', hunksA: new Map([['x.js', [[1, 1]]]]), hunksB: new Map([['x.js', [[line, line]]]]), margin: 20, mergeConflict: conflict });
    const out = gate([entry(2)], [claim(1)], { overlapGranularity: 'region' }, { regionOverlap });
    expect(out.planned.length).toBe(overlap ? 0 : 1); expect(out.scopeDecisions[0].rule).toBe(conflict === true ? 'waitForLandingHolder' : 'overlapGranularity');
  });
  it('fails closed on unreadable or absent hunks', () => { expect(policyApi.regionOverlapDecision({ file: 'x', hunksA: null, hunksB: new Map(), mergeConflict: false })).toMatchObject({ overlap: true, failedClosed: true }); });
  it('fails closed without a reader and for build claims', () => {
    expect(gate([entry(2)], [claim(1)], { overlapGranularity: 'region' }).scopeDecisions[0]).toMatchObject({ decision: 'blocked', failedClosed: true });
    const out = filterFixesByInFlightScope([entry(2)], [{ meta: { num: 9, scope: [F] } }], [], { policy: policy(), regionOverlap: () => ({ overlap: false }), rebaseExempt: null });
    expect(out.scopeDecisions[0]).toMatchObject({ decision: 'blocked', failedClosed: true });
  });
  it('file mode ignores disjoint regions', () => { expect(gate([entry(2)], [claim(1)], {}, { regionOverlap: () => ({ overlap: false }) }).planned).toEqual([]); });
  it('reads real git hunks and trial merges, without network', () => {
    const root = mkdtempSync(join(tmpdir(), 'fix-scope-'));
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git(['init']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
      const commit = (line, text) => { const next = [...lines]; next[line] = text; writeFileSync(join(root, 'x.js'), next.join('\n') + '\n'); git(['add', '.']); git(['commit', '-m', text]); return git(['rev-parse', 'HEAD']).trim(); };
      const base = commit(0, 'base'); lines[0] = 'base'; git(['update-ref', 'refs/remotes/origin/main', base]);
      const a = commit(10, 'A'); git(['checkout', '--detach', base]); const b = commit(150, 'B'); git(['checkout', '--detach', base]); const c = commit(10, 'C');
      const reader = policyApi.createRegionReader({ root, git });
      expect(reader.mergeConflicts(a, b)).toBe(false); expect(reader.mergeConflicts(a, c)).toBe(true);
      expect(policyApi.regionOverlapDecision({ file: 'x.js', hunksA: reader.hunksFor(a), hunksB: reader.hunksFor(b), margin: 20, mergeConflict: reader.mergeConflicts(a, b) }).overlap).toBe(false);
      expect(reader.hunksFor('missing')).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
describe('priorityBypass', () => {
  it.each([{ labels: ['fast-track'] }, { mainFix: true }, {}])('admits priority past ordinary holder %j', extra => {
    const out = gate([entry(2, extra)], [claim(1)], {}, { priorityPrs: new Set([2]) }); expect(out.planned).toHaveLength(1); expect(out.scopeDecisions[0].rule).toBe('priorityBypass');
  });
  it('recognizes labels and mainFix without operator list', () => { for (const extra of [{ labels: ['fast-track'] }, { mainFix: true }]) expect(gate([entry(2, extra)], [claim(1)]).planned).toHaveLength(1); });
  it('bypasses stalled priority but retains live priority', () => {
    const options = { priorityPrs: new Set([1, 2]) };
    expect(gate([entry(2)], [claim(1)], {}, options).planned).toEqual([]);
    const stale = { ...claim(1), ttlMinutes: 60, heartbeatAt: new Date(NOW - 31 * 60000).toISOString() };
    expect(gate([entry(2)], [stale], {}, options).scopeDecisions[0].rule).toBe('priorityBypass');
  });
  it('off retains holders', () => { expect(gate([entry(2, { mainFix: true })], [claim(1)], { priorityBypass: false }).planned).toEqual([]); });
  it('sorts priority ahead but never past an accepted overlapping fix', () => {
    expect(gate([entry(1), entry(2, { mainFix: true })]).planned.map(e => e.pr)).toEqual([2]);
    expect(gate([entry(1), entry(2, { mainFix: true })], [], {}, { urgentPrs: new Set([1]) }).planned.map(e => e.pr)).toEqual([1]);
  });
});
describe('no-policy compatibility', () => {
  it('preserves exact refusal bytes', () => { expect(filterFixesByInFlightScope([entry(2)], [], [claim(1)], { maxWaitMinutes: null, rebaseExempt: null }).refusals[0].why).toBe(`${F} overlaps in-flight fix PR #1 — waiting 2nd behind #1 on ${F} — serializing, retrying next pass`); });
});

describe('conservative region IO and policy edges', () => {
  it('fetches a missing object once and caches failures', () => {
    const calls = [];
    const reader = policyApi.createRegionReader({ root: '/unused', git: args => {
      calls.push(args); if (args.at(-1) === 'origin/main^{commit}') return 'base'; throw new Error('unavailable');
    } });
    expect(reader.hunksFor('abc', 12)).toBeNull(); expect(reader.hunksFor('abc', 12)).toBeNull();
    expect(reader.hunksFor('def', 12)).toBeNull();
    expect(calls.filter(a => a[0] === 'fetch')).toEqual([['fetch', 'origin', 'refs/pull/12/head']]);
    expect(reader.mergeConflicts('abc', 'def')).toBeNull();
  });
  it('invalidates hunk cache when origin/main moves', () => {
    let tip = 'base1', diffs = 0;
    const reader = policyApi.createRegionReader({ git: args => {
      if (args[0] === 'rev-parse') return args.at(-1) === 'origin/main^{commit}' ? tip : 'head';
      if (args[0] === 'merge-base') return tip;
      if (args[0] === 'diff') { diffs++; return 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'; }
      return '';
    } });
    reader.hunksFor('head', 1); reader.hunksFor('head', 1); expect(diffs).toBe(1);
    tip = 'base2'; reader.hunksFor('head', 1); expect(diffs).toBe(2);
  });
  it.each([
    'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x',
    'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x',
    'diff --git a/x b/x\nBinary files a/x and b/x differ',
  ])('fails closed for added, deleted and binary files', diff => {
    const hunks = policyApi.parseUnifiedZeroHunks(diff);
    expect(policyApi.regionOverlapDecision({ file: 'x', hunksA: hunks, hunksB: hunks, mergeConflict: false })).toMatchObject({ overlap: true, failedClosed: true });
  });
  it('does not mistake hunk content for file headers', () => {
    const hunks = policyApi.parseUnifiedZeroHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10 +10 @@\n--- a/fake\n+++ b/fake');
    expect([...hunks]).toEqual([['x', [[10, 10]]]]);
  });
  it('retains directory scopes and checks every shared file', () => {
    const directory = gate([entry(2, { scope: ['we:scripts/'] })], [claim(1)], { overlapGranularity: 'region' }, { regionOverlap: () => ({ overlap: false }) });
    expect(directory.scopeDecisions[0]).toMatchObject({ failedClosed: true, decision: 'blocked' });
    const out = gate([entry(2, { scope: [F, 'we:other'] })], [claim(1, { scope: [F, 'we:other'] })], { overlapGranularity: 'region' }, { regionOverlap: (_a, _b, f) => ({ overlap: f === 'we:other', why: f }) });
    expect(out.planned).toEqual([]);
  });
  it('uses claimedAt when no heartbeat is available', () => {
    const old = { meta: { pr: 1, scope: [F], claimedAt: new Date(NOW - 11 * 60000).toISOString() } };
    expect(gate([entry(2)], [old]).scopeDecisions[0].rule).toBe('holdMode');
  });
  it('allows priority past a stalled priority waiter in pr-lifetime', () => {
    const out = gate([entry(1, { scope: [F, 'we:other'], waitingSince: new Date(NOW - 31 * 60000).toISOString() }), entry(2)], [claim(99, { scope: ['we:other'] })], { holdMode: 'pr-lifetime' }, { priorityPrs: new Set([1, 2, 99]) });
    expect(out.planned.map(e => e.pr)).toEqual([2]);
    expect(out.scopeDecisions).toContainEqual(expect.objectContaining({ pr: 2, holder: 1, rule: 'priorityBypass', decision: 'admitted' }));
  });
  it('logs the effective source and keeps aging admissions accurate', () => {
    const out = gate([entry(2, { waitingSince: new Date(NOW - 61 * 60000).toISOString() })], [claim(1)], {}, { maxWaitMinutes: 60 });
    expect(out.planned).toHaveLength(1);
    expect(out.scopeDecisions[0]).toMatchObject({ decision: 'admitted', setting: 'fixScope.overlapGranularity=file (tool)' });
  });
});

// Legacy callers pin exact planner objects; the live call explicitly carries label metadata.
describe('planner label forwarding', () => {
  it('preserves labels when the live gate opts in', () => {
    const out = planFixesFromReconcile([{ kind: 'fix', prNumber: 2, headRefName: 'feature', files: ['x.js'], labels: ['fast-track'] }], () => null, () => [], () => [], 'we', () => ['x.js'], () => [], { includeLabels: true });
    expect(out.planned[0].labels).toEqual(['fast-track']);
    expect(gate(out.planned.map(e => ({ ...e, scope: [F], overlapScope: [F] })), [claim(1)]).planned).toHaveLength(1);
  });
});

describe('landing holder policy', () => {
  it('cascades nested leaves and validates their shapes', () => {
    const p = policy({ waitForLandingHolder: { holderStates: ['review:accepted'] } });
    expect(p.value.waitForLandingHolder).toEqual({ enabled: true, holderStates: ['review:accepted'] });
    expect(p.sources).toMatchObject({ 'waitForLandingHolder.enabled': 'standard', 'waitForLandingHolder.holderStates': 'tool' });
    for (const bad of [{ enabled: 'yes', holderStates: [] }, { enabled: ['x'] }, { holderStates: true }]) {
      const resolved = policy({ waitForLandingHolder: bad });
      expect(resolved.value.waitForLandingHolder).toEqual(policyApi.FIX_SCOPE_DEFAULTS.waitForLandingHolder);
      expect(resolved.invalid.length).toBeGreaterThan(0);
      for (const leaf of Object.keys(bad)) expect(resolved.sources['waitForLandingHolder.' + leaf]).toBe('standard');
    }
  });
  it('decides legacy, unreadable, landing and ordinary holders', () => {
    const decide = state => policyApi.landingHolderDecision({ state, setting: policy().value.waitForLandingHolder });
    expect(policyApi.landingHolderDecision({ state: null, setting: { enabled: false } })).toEqual({ hold: true, why: 'trial merge conflicts' });
    expect(decide(null)).toMatchObject({ hold: true, failedClosed: true });
    for (const labels of [['review:accepted'], [{ name: 'review:accepted' }]]) {
      expect(decide({ labels })).toMatchObject({ hold: true, landing: true });
      expect(decide({ labels }).why).toContain('holder is landing (review:accepted)');
    }
    expect(decide({ labels: [], inMergeQueue: true })).toMatchObject({ hold: true, landing: true, why: expect.stringContaining('in-merge-queue') });
    expect(decide({ labels: ['review:pending'] })).toMatchObject({ hold: false });
  });
  it.each([
    ['draft', { labels: ['review:accepted'], isDraft: true }, 'holder cannot land: draft'],
    ['red-team:blocked', { labels: ['review:accepted', 'red-team:blocked'] }, 'holder cannot land: red-team:blocked'],
    ['queued draft blocked by red team', { labels: [{ name: 'red-team:blocked' }], inMergeQueue: true, isDraft: true }, 'holder cannot land: draft, red-team:blocked'],
  ])('releases a matched holder that cannot land (%s)', (_name, state, reason) => {
    const d = policyApi.landingHolderDecision({ state, setting: policy().value.waitForLandingHolder });
    expect(d).toMatchObject({ hold: false });
    expect(d).not.toHaveProperty('landing');
    expect(d.why).toContain(reason);
  });
  it('keeps the landing hold for a ready, unblocked holder', () => {
    const d = policyApi.landingHolderDecision({ state: { labels: ['review:accepted'], isDraft: false }, setting: policy().value.waitForLandingHolder });
    expect(d).toMatchObject({ hold: true, landing: true });
  });
  it('marks trial merge conflicts explicitly', () => {
    expect(policyApi.regionOverlapDecision({ file: 'x', hunksA: new Map([['x', [[1, 1]]]]), hunksB: new Map([['x', [[1, 1]]]]), mergeConflict: true }))
      .toEqual({ overlap: true, conflict: true, why: 'trial merge conflicts' });
  });
});
describe('holder state reader', () => {
  const page = (nodes, hasNextPage = false, endCursor = null) => JSON.stringify({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
  const node = (number, labels = [], isInMergeQueue = false) => ({ number, headRefOid: 'head' + number, baseRefName: 'main', isInMergeQueue, labels: { nodes: labels.map(name => ({ name })) } });
  it('parses and lazily caches paginated states for the selected repository', () => {
    const first = page([node(1, ['review:accepted'])], true, 'next');
    expect(policyApi.parseHolderStates(first).get(1)).toEqual({ labels: ['review:accepted'], inMergeQueue: false, headRefOid: 'head1', baseRefName: 'main' });
    const calls = [];
    const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec: (cmd, args) => {
      calls.push([cmd, args]); return calls.length === 1 ? first : page([node(2, [], true), node(3, ['review:pending'])]);
    } });
    expect(calls).toEqual([]);
    expect(reader.stateFor(2)).toEqual({ labels: [], inMergeQueue: true, headRefOid: 'head2', baseRefName: 'main' });
    expect(reader.landingPrs(['review:accepted', 'in-merge-queue'])).toEqual([1, 2]);
    expect(reader.stateFor(99)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('gh');
    expect(calls[0][1]).toEqual(expect.arrayContaining(['api', 'graphql', 'owner=owner', 'name=project']));
    expect(calls[0][1].find(arg => arg.startsWith('query='))).toContain('baseRefName');
    expect(calls[1][1]).toContain('cursor=next');
  });
  it.each([
    ['stacked child', 'lane/x', false],
    ['child retargeted to main', 'main', true],
    ['legacy state without a base', undefined, true],
  ])('%s only holds when landable, preserving unrelated main holders', (_name, baseRefName, hold) => {
    const child = { ...node(1, ['review:accepted']), baseRefName };
    const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec: () => page([child, node(2, ['review:accepted'])]) });
    const setting = policy().value.waitForLandingHolder;
    expect(policyApi.landingHolderDecision({ state: reader.stateFor(1), setting })).toMatchObject({ hold });
    expect(policyApi.landingHolderDecision({ state: reader.stateFor(2), setting })).toMatchObject({ hold: true, landing: true });
    expect(reader.landingPrs(setting.holderStates)).toEqual(hold ? [1, 2] : [2]);
    if (baseRefName === undefined) expect(reader.stateFor(1)).not.toHaveProperty('baseRefName');
  });
  it('excludes a stacked child from landing holds even when queued', () => {
    const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec: () => page([{ ...node(1, [], true), baseRefName: 'lane/x' }]) });
    const setting = policy().value.waitForLandingHolder;
    expect(policyApi.landingHolderDecision({ state: reader.stateFor(1), setting })).toMatchObject({ hold: false });
    expect(reader.landingPrs(setting.holderStates)).toEqual([]);
  });
  it('reads isDraft from the snapshot and fails closed on a malformed isDraft', () => {
    const calls = [];
    const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec: (cmd, args) => {
      calls.push(args); return page([{ ...node(1, ['review:accepted']), isDraft: true }, { ...node(2, ['review:accepted']), isDraft: false }]);
    } });
    expect(reader.stateFor(1)).toMatchObject({ isDraft: true });
    expect(calls[0].find(arg => arg.startsWith('query='))).toContain('isDraft');
    const setting = policy().value.waitForLandingHolder;
    expect(policyApi.landingHolderDecision({ state: reader.stateFor(1), setting })).toMatchObject({ hold: false, why: expect.stringContaining('holder cannot land: draft') });
    expect(policyApi.landingHolderDecision({ state: reader.stateFor(2), setting })).toMatchObject({ hold: true, landing: true });
    expect(policyApi.parseHolderStates(page([{ ...node(1, ['review:accepted']), isDraft: 'yes' }]))).toBeNull();
  });
  it('fails closed and caches subprocess or malformed response failures', () => {
    for (const exec of [() => { throw Error('offline'); }, () => '{}']) {
      const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec });
      expect(reader.stateFor(1)).toBeNull(); expect(reader.landingPrs(['review:accepted'])).toEqual([]);
    }
  });
  it('caps pagination at five pages and fails closed on an incomplete snapshot', () => {
    let calls = 0;
    const reader = policyApi.createHolderStateReader({ repo: 'owner/project', exec: () => { calls++; return page([node(calls)], true, 'next' + calls); } });
    expect(reader.stateFor(1)).toBeNull(); expect(reader.landingPrs(['review:accepted'])).toEqual([]);
    expect(calls).toBe(5);
  });
});
describe('wait only for a landing holder', () => {
  const conflict = () => ({ overlap: true, why: 'trial merge conflicts', conflict: true });
  const run = (state, overrides = {}, options = {}, claims = [claim(1)]) => gate([entry(2)], claims,
    { overlapGranularity: 'region', ...overrides }, { regionOverlap: conflict, holderState: () => state, ...options });
  it('admits a waiter past a holder not near landing and names each setting leaf', () => {
    const out = run({ labels: ['review:pending'] });
    expect(out.planned.map(e => e.pr)).toEqual([2]);
    expect(out.scopeDecisions[0]).toMatchObject({ rule: 'waitForLandingHolder', decision: 'admitted', why: expect.stringContaining('not near landing') });
    expect(out.scopeDecisions[0].setting).toBe('fixScope.waitForLandingHolder.enabled=true (standard), fixScope.waitForLandingHolder.holderStates=["review:accepted","in-merge-queue"] (standard)');
  });
  it('holds a waiter behind an accepted holder', () => {
    const out = run({ labels: ['review:accepted'] });
    expect(out.planned).toEqual([]);
    expect(out.scopeDecisions[0]).toMatchObject({ rule: 'waitForLandingHolder', decision: 'blocked', why: expect.stringContaining('holder is landing (review:accepted)') });
  });
  it.each([
    ['draft', { labels: ['review:accepted'], isDraft: true }, 'holder cannot land: draft'],
    ['red-team:blocked', { labels: ['review:accepted', 'red-team:blocked'] }, 'holder cannot land: red-team:blocked'],
  ])('admits a waiter past an accepted holder that cannot land (%s), including a landing-only holder', (_name, state, reason) => {
    for (const [options, claims] of [[{}, [claim(1)]], [{ landingHolders: [{ pr: 1, scope: [F] }] }, []]]) {
      const out = run(state, {}, options, claims);
      expect(out.planned.map(e => e.pr)).toEqual([2]);
      expect(out.scopeDecisions[0]).toMatchObject({ rule: 'waitForLandingHolder', decision: 'admitted', why: expect.stringContaining(reason) });
    }
  });
  it('retains the hold on unreadable state', () => {
    expect(run(null).scopeDecisions[0]).toMatchObject({ decision: 'blocked', rule: 'waitForLandingHolder', failedClosed: true });
  });
  it('restores legacy holds when disabled', () => {
    const out = run({ labels: ['review:pending'] }, { waitForLandingHolder: { enabled: false } });
    expect(out.planned).toEqual([]);
    expect(out.scopeDecisions[0]).toMatchObject({ rule: 'overlapGranularity', why: 'trial merge conflicts' });
  });
  it('holds behind a queued PR even without a fixer and preserves refusal text', () => {
    const out = run({ inMergeQueue: true }, {}, { landingHolders: [{ pr: 1, scope: [F] }] }, []);
    expect(out.planned).toEqual([]);
    expect(out.refusals[0].why).toContain('waiting 2nd behind #1');
  });
  it('does not hold or emit a decision for a margin-only landing holder', () => {
    const out = run({ inMergeQueue: true }, {}, { landingHolders: [{ pr: 1, scope: [F] }], regionOverlap: () => ({ overlap: true, why: 'changed regions intersect within margin' }) }, []);
    expect(out.planned.map(e => e.pr)).toEqual([2]); expect(out.scopeDecisions).toEqual([]);
  });
  it('ignores landing holders in file mode', () => {
    expect(run({ inMergeQueue: true }, { overlapGranularity: 'file' }, { landingHolders: [{ pr: 1, scope: [F] }] }, []).planned).toHaveLength(1);
  });
  it('deduplicates claims and exempts self and stack ancestors', () => {
    const landingHolders = [{ pr: 1, scope: [F] }, { pr: 2, scope: [F] }];
    expect(run({ inMergeQueue: true }, {}, { landingHolders }).scopeDecisions).toHaveLength(1);
    expect(run({ inMergeQueue: true }, {}, { landingHolders, stackAbove: new Map([[2, new Set([1])]]) }).planned).toHaveLength(1);
  });
});
