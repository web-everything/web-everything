// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { evaluatePrGates, evaluateGroup, groupPrNumbers, groupMembership, asQueuedPr, resolveMergeGateMode, loadMergeGateMode, applyGateMode, runGate, STANDARD_MERGE_GATE_MODE } from '../merge-gate-ci.mjs';
import { DRAIN_GATES } from '../merge-gate-inventory.mjs';
import { rulesetSuggestion } from '../merge-queue-enqueue.mjs';
import { scoreEscalation } from '../review-escalation.mjs';
import { MANIFEST_BODY_BEGIN, MANIFEST_BODY_END, extractManifestFromBody } from '../../readiness/lane-manifest.mjs';
import { gatherPrFacts, readGroupPrs, readLedgerConfig, mergeEventOfFlags, pinnedHeadOf, bodyHistoryOf, groupHeadsOf, verifyRunningWorkflow } from '../../merge-gate-check.mjs';
import { findDuplicateIds } from '../duplicate-id-tripwire.mjs';

const HEAD = 'a'.repeat(40);
const base = () => ({
  repo: 'o/r', num: 7, defaultBranch: 'main',
  pr: { number: 7, title: 't', body: 'A real body', baseRefName: 'main', headRefName: 'lane/x', headRefOid: HEAD, isCrossRepository: false,
    labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
    commits: [{ oid: HEAD, messageHeadline: 'x', messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
    statusCheckRollup: [] },
  manifest: { live: null },
  netSignals: { scored: true, changedFiles: ['docs/a.md'], diffLines: 2, humanBasisFiles: ['docs/a.md'], cumulativeDiffLines: 2, basisNarrowed: true, netDiffText: { text: '', scored: true }, diffHunks: '' },
  acceptance: { headSha: HEAD, acceptedSha: HEAD, acceptedDiff: null, acceptedContribution: null, operatorClearance: null, humanClearedSha: null, headDiff: null, headContribution: null, headReadFailed: false },
  bodyHistory: { bodies: ['A real body'], complete: true },
  duplicateIds: { main: [] },
  redMain: { source: 'ops/red-main', frozen: false },
  enqueueClearance: null,
  ledger: { authority: 'labels', folded: null, derived: null },
  pinnedHead: { sha: HEAD },
  gatePaths: { files: ['docs/a.md'] },
});

// Merge one level of fact fields; each call starts with fresh objects and arrays.
function facts(over = {}) {
  const result = base();
  for (const [key, value] of Object.entries(over)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...result[key], ...value } : value;
  }
  return result;
}
function check(input, id, status, ok = false, options) {
  const result = evaluatePrGates(input, options);
  expect(result.results.find((gate) => gate.id === id), JSON.stringify(result.blocking)).toMatchObject({ id, status });
  expect(result.ok, JSON.stringify(result.blocking)).toBe(ok);
  return result;
}
const labels = (...names) => names.map((name) => ({ name }));
const codeql = [{ name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-01-01T00:00:00Z' }];
const manifestBody = `${MANIFEST_BODY_BEGIN}\n${JSON.stringify({ item: '123', blockedBy: ['9'], dismissedFindings: 2 })}\n${MANIFEST_BODY_END}`;

describe('evaluatePrGates', () => {
  it('passes the accepted baseline', () => {
    const result = evaluatePrGates(base());
    expect(result.ok, JSON.stringify(result.blocking)).toBe(true);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where === 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: 'pass' });
    }
  });

  it.each([
    ['missing shared red-main source', { redMain: { source: null } }, 'red-main-freeze', 'fail-closed'],
    ['frozen main', { redMain: { frozen: true } }, 'red-main-freeze', 'hold'],
    ['missing candidate label', { pr: { labels: labels('review:accepted') } }, 'candidate-label', 'hold'],
    ['pending review label', { pr: { labels: labels('ready-to-merge', 'review:pending') } }, 'review-hold-labels', 'hold'],
    ['pending acceptance', { pr: { labels: labels('ready-to-merge', 'review:pending') } }, 'review-acceptance', 'hold'],
    ['human review label', { pr: { labels: labels('ready-to-merge', 'review:human') } }, 'review-hold-labels', 'hold'],
    ['unreadable acceptance', { acceptance: { error: 'boom' } }, 'review-acceptance', 'fail-closed'],
    ['stale acceptance', { acceptance: { acceptedSha: 'b'.repeat(40) } }, 'review-acceptance', 'hold'],
    ['blank body', { pr: { body: '   ' } }, 'non-empty-body', 'hold'],
    ['non-default base', { pr: { baseRefName: 'lane/y' } }, 'default-base', 'hold'],
    ['unknown default branch', { defaultBranch: null }, 'default-base', 'fail-closed'],
    ['failed CodeQL', { pr: { statusCheckRollup: codeql } }, 'codeql', 'hold'],
    ['deleted test', { netSignals: { netDiffText: { text: "diff --git a/x.test.mjs b/x.test.mjs\ndeleted file mode 100644\n--- a/x.test.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-it('a', () => {})\n", scored: true } } }, 'test-gaming', 'hold'],
    ['unscored diff without fallback files', { netSignals: { scored: false } }, 'test-gaming', 'fail-closed'],
    ['removed historical manifest', { bodyHistory: { bodies: ['A real body', manifestBody] } }, 'manifest-baseline', 'hold'],
    ['incomplete body history', { bodyHistory: { complete: false } }, 'manifest-baseline', 'fail-closed'],
    ['tree manifest', { manifest: { fromTree: true } }, 'manifest-baseline', 'fail-closed'],
    ['duplicate on main', { duplicateIds: { main: [{ id: '12' }] } }, 'duplicate-id-on-main', 'hold'],
    ['unreadable duplicates', { duplicateIds: { error: 'x' } }, 'duplicate-id-on-main', 'fail-closed'],
    ['duplicate in group', { duplicateIds: { main: [], group: [{ id: '5' }] } }, 'duplicate-id-on-main', 'hold'],
  ])('%s', (_name, over, id, status) => {
    check(facts(over), id, status);
  });

  it('allows failed CodeQL when explicitly disabled', () => {
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'pass', true, { blockOnCodeQL: false });
  });

  it('requires head-covering enqueue clearance for both manifest ordering gates', () => {
    const live = extractManifestFromBody(manifestBody);
    expect(live).toMatchObject({ item: 123, blockedBy: [9], dismissedFindings: 2 });
    const over = { pr: { body: manifestBody }, manifest: { live } };
    for (const id of ['blocked-by', 'couple-whole']) {
      check(facts(over), id, 'fail-closed');
      check(facts({ ...over, enqueueClearance: { coversHead: true } }), id, 'pass', true);
    }
  });

  it('fails every merge gate closed on a PR read error', () => {
    const result = evaluatePrGates(facts({ prReadError: 'unreadable' }));
    expect(result.ok).toBe(false);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where === 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: 'fail-closed' });
    }
  });

  it('reports queue and enqueue ownership without blocking', () => {
    const result = evaluatePrGates(facts());
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where !== 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: gate.where });
    }
    expect(result.results).toContainEqual(expect.objectContaining({ id: 'freshness', status: 'queue' }));
    expect(result.results).toContainEqual(expect.objectContaining({ id: 'overlap-yield', status: 'enqueue' }));
  });

  it('skips CodeQL in CI when drain-direct policy keeps it in the drain', () => {
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'skipped-by-policy', true, {
      policy: { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } },
      mergeEvent: 'pull_request',
    });
  });

  // The merge actually happens in the queue on a merge_group run, whatever strategy is configured: a drain
  // placement there means NO merger re-checks the gate, so it must be evaluated, never skipped.
  it('never skips a gate on a merge_group run, even under drain-direct + placement drain', () => {
    const policy = { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } };
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'hold', false, { policy, mergeEvent: 'merge_group' });
  });

  it('fails closed to evaluating when the merge event is unknown or omitted', () => {
    const policy = { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } };
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'hold', false, { policy });
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'hold', false, { policy, mergeEvent: 'workflow_dispatch' });
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'hold', false, { policy, mergeEvent: 'MERGE_GROUP' });
  });

  it('also evaluates every drain-placed gate on a merge_group run (all placements, not just codeql)', () => {
    const gatePlacement = Object.fromEntries(DRAIN_GATES.filter((g) => g.where === 'merge-gate').map((g) => [g.id, 'drain']));
    const result = evaluatePrGates(facts(), { policy: { strategy: 'drain-direct', gatePlacement }, mergeEvent: 'merge_group' });
    expect(result.results.filter((row) => row.status === 'skipped-by-policy')).toEqual([]);
  });

  it('threads the merge event from the CLI: --merge-group runs as merge_group, --pr as pull_request only on a pull_request runner', () => {
    expect(mergeEventOfFlags({ 'merge-group': true }, {})).toBe('merge_group');
    expect(mergeEventOfFlags({ pr: '7' }, { GITHUB_EVENT_NAME: 'pull_request' })).toBe('pull_request');
    expect(mergeEventOfFlags({ pr: '7', 'merge-group': true }, {})).toBe('merge_group');
  });

  // A drain skip needs POSITIVE proof the event is a pull_request. An absent / unrecognised runner event (a local
  // run, workflow_dispatch, a wrong-cased or future event name) must not read as one, or the queue could merge a
  // PR that nothing re-checked.
  it('never reads "pull_request" without proof: no runner event, workflow_dispatch or odd casing evaluates every gate', () => {
    for (const env of [{}, { GITHUB_EVENT_NAME: '' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'PULL_REQUEST' }, { GITHUB_EVENT_NAME: 'merge_queue' }, { GITHUB_EVENT_NAME: ' pull_request' }]) {
      expect(mergeEventOfFlags({ pr: '7' }, env)).toBeNull();
      expect(mergeEventOfFlags({}, env)).toBeNull();
    }
    const policy = { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } };
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'hold', false, { policy, mergeEvent: mergeEventOfFlags({ pr: '7' }, {}) });
  });

  it('the live process.env is the default runner event, so a merge_group runner is never read as pull_request', () => {
    const prev = process.env.GITHUB_EVENT_NAME;
    try {
      process.env.GITHUB_EVENT_NAME = 'merge_group';
      expect(mergeEventOfFlags({ pr: '7' })).toBe('merge_group');
      delete process.env.GITHUB_EVENT_NAME;
      expect(mergeEventOfFlags({ pr: '7' })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GITHUB_EVENT_NAME; else process.env.GITHUB_EVENT_NAME = prev;
    }
  });

  it('a merge_group run without the group-tree duplicate scan fails duplicate-id-on-main closed; pull_request is unaffected', () => {
    const noGroup = facts({ duplicateIds: { main: [] } });
    check(noGroup, 'duplicate-id-on-main', 'fail-closed', false, { mergeEvent: 'merge_group' });
    check(noGroup, 'duplicate-id-on-main', 'pass', true, { mergeEvent: 'pull_request' });
    check(facts({ duplicateIds: { main: [], group: [] } }), 'duplicate-id-on-main', 'pass', true, { mergeEvent: 'merge_group' });
  });

  it('the runner event wins over the flags: GITHUB_EVENT_NAME=merge_group is a merge_group run even via --pr', () => {
    expect(mergeEventOfFlags({ pr: '7' }, { GITHUB_EVENT_NAME: 'merge_group' })).toBe('merge_group');
    expect(mergeEventOfFlags({ pr: '7' }, { GITHUB_EVENT_NAME: 'pull_request' })).toBe('pull_request');
  });

  it('the workflow cannot reach --pr on a merge_group event: no head sha and no PR number fails closed', () => {
    const run = workflowOf('merge-gate.yml').jobs['merge-gate'].steps.find((s) => /merge-gate-check\.mjs/.test(s.run || '')).run;
    // --merge-group is chosen by the group head sha alone; the --pr branches need a PR number / dispatch list,
    // which a merge_group event never carries, and the final else exits 1.
    expect(run).toMatch(/if \[ -n "\$MG_HEAD_SHA" \]; then[\s\S]*--merge-group[\s\S]*elif \[ -n "\$PR_NUMBER" \]/);
    expect(run).toMatch(/else[\s\S]*failing closed[\s\S]*exit 1/);
  });
});

// PR #4708 round 6 (ruled block): a workflow edit must not be acceptable by an AI-reviewable escalation evaluated
// by the very check being edited. The PR-leg run (main's YAML via pull_request_target) holds it for a human.
describe('workflow edits are human-only in the merge-gate evaluator (workflowEditFact)', () => {
  const wfFiles = (files) => ({ gatePaths: { files } });
  it.each([
    ['the gate workflow', ['.github/workflows/merge-gate.yml']],
    ['a new workflow next to ordinary files', ['docs/a.md', '.github/workflows/evil.yml']],
    ['a composite action', ['.github/actions/setup/action.yml']],
    ['the old side of a rename (git --no-renames lists both)', ['.github/workflows/ci.yml', 'docs/ci.yml']],
    ['an odd spelling', ['.GitHub//Workflows\\X.yml']],
  ])('holds %s for a human even with review:accepted and an AI accept at the head', (_n, files) => {
    const result = check(facts(wfFiles(files)), 'review-acceptance', 'hold');
    expect(result.results.find((x) => x.id === 'review-acceptance').reason).toMatch(/human-only/);
  });
  it('passes once a clear-human ceremony reviewed exactly the pinned head', () => {
    check(facts({ ...wfFiles(['.github/workflows/merge-gate.yml']), acceptance: { humanClearedSha: HEAD } }), 'review-acceptance', 'pass', true);
  });
  it('a human clearance of another sha does not carry over', () => {
    const r = check(facts({ ...wfFiles(['.github/workflows/merge-gate.yml']), acceptance: { humanClearedSha: 'b'.repeat(40) } }), 'review-acceptance', 'hold');
    expect(r.results.find((x) => x.id === 'review-acceptance').reason).toMatch(/human clearance is for bbbbbbbbb/);
  });
  it.each([
    ['an unreadable pinned change list', { gatePaths: { error: 'fatal: bad object' } }],
    ['no pinned change list at all', { gatePaths: null }],
    ['no pinned head', { pinnedHead: { sha: null, error: 'head moved' } }],
  ])('fails closed on %s', (_n, over) => {
    check(facts(over), 'review-acceptance', 'fail-closed');
  });
  it('ordinary paths that merely name github or workflows pass', () => {
    check(facts(wfFiles(['docs/github/workflows.md', 'workflows/x.yml'])), 'review-acceptance', 'pass', true);
  });
  it('pull_request_target is the PR leg (the runner event of merge-gate.yml), never merge_group', () => {
    expect(mergeEventOfFlags({ pr: '7' }, { GITHUB_EVENT_NAME: 'pull_request_target' })).toBe('pull_request');
    expect(mergeEventOfFlags({ 'merge-group': true }, { GITHUB_EVENT_NAME: 'pull_request_target' })).toBe('merge_group');
  });
});

describe('merge group helpers', () => {
  it('rejects an empty group and identifies a failing PR', () => {
    expect(evaluateGroup([]).ok).toBe(false);
    expect(evaluateGroup([{ num: 1, ok: true }, { num: 2, ok: false }], { complete: true })).toMatchObject({ ok: false, reason: expect.stringContaining('#2') });
  });

  it('unions ref, subjects and entries up to the group head', () => {
    expect(groupPrNumbers({
      headRef: 'refs/heads/gh-readonly-queue/main/pr-42-abc123', headSha: 'h',
      entries: [
        { position: 1, headCommit: { oid: 'x' }, pullRequest: { number: 40 } },
        { position: 2, headCommit: { oid: 'h' }, pullRequest: { number: 42 } },
        { position: 3, headCommit: { oid: 'z' }, pullRequest: { number: 43 } },
      ], commitSubjects: ['Merge pull request #41 from a/b'],
    })).toEqual([40, 41, 42]);
  });

  it('replaces existing test rows and preserves other checks', () => {
    const other = { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' };
    const pr = { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND', statusCheckRollup: [
      { name: 'test', conclusion: 'FAILURE' }, { context: 'test', state: 'PENDING' }, other,
    ] };
    const result = asQueuedPr(pr);
    expect(result).toMatchObject({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    expect(result.statusCheckRollup).toEqual([other, expect.objectContaining({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' })]);
    expect(pr.statusCheckRollup).toHaveLength(3);
  });
});

// ── the fact gatherer (merge-gate-check.mjs), driven through an injected exec ─────────────────────────────

const tmpRoots = [];
afterEach(() => { for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout({ backlog = true, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'merge-gate-'));
  tmpRoots.push(root);
  if (backlog) mkdirSync(join(root, 'backlog'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}
const failure = (stderr) => Object.assign(new Error(stderr), { stderr });
const prJson = (over = {}) => JSON.stringify({ ...base().pr, ...over });
/** An exec that answers by the first matching [regex, handler] over "<cmd> <args…>"; any other call throws. */
function fakeExec(rules) {
  const calls = [];
  const exec = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    for (const [re, handler] of rules) {
      if (!re.test(key)) continue;
      if (handler instanceof Error) throw handler;
      return typeof handler === 'function' ? handler(args) : handler;
    }
    throw failure(`unexpected call: ${key}`);
  };
  exec.calls = calls;
  return exec;
}
const GH_FILES = [/pr view 7 .*--json files/, JSON.stringify({ files: [{ path: 'docs/a.md', additions: 1, deletions: 1 }] })];
const GH_PR = [/pr view 7 .*--json number,title/, () => prJson()];
const GH_HISTORY = (totalCount, nodes) => [/api graphql .*userContentEdits/, JSON.stringify({ data: { repository: { pullRequest: { userContentEdits: { totalCount, nodes } } } } })];
const GH_MANIFEST_404 = [/contents\/\.lane-manifest\.json/, failure('gh: Not Found (HTTP 404)')];
const gather = (rules, extra = {}) => gatherPrFacts({
  repo: 'o/r', num: 7, cwd: checkout(), defaultBranch: 'main', ledgerConfig: { authority: 'labels' },
  exec: fakeExec([...rules, GH_FILES]), ...extra,
});
const evaluated = (facts, id) => evaluatePrGates(facts).results.find((row) => row.id === id);

describe('gatherPrFacts (injected exec)', () => {
  it('turns a PR read error into fail-closed on every merge gate', () => {
    const facts = gather([[/pr view 7 .*--json number,title/, failure('HTTP 502')]]);
    expect(facts.prReadError).toContain('502');
    const result = evaluatePrGates(facts);
    expect(result.ok).toBe(false);
    for (const gate of DRAIN_GATES.filter((g) => g.where === 'merge-gate')) expect(result.results.find((r) => r.id === gate.id).status).toBe('fail-closed');
  });

  it('splits the manifest read: 404 is "no manifest", any other error is a fail-closed review gate', () => {
    const rules = (manifest) => [GH_PR, manifest, GH_HISTORY(1, [])];
    const missing = gather(rules(GH_MANIFEST_404));
    expect(missing.manifest).toEqual({ live: null });
    const broken = gather(rules([/contents\/\.lane-manifest\.json/, failure('HTTP 500 server error')]));
    expect(broken.manifest.error).toContain('500');
    expect(evaluated(broken, 'review-acceptance').status).toBe('fail-closed');
  });

  it('flags truncated body history as incomplete and a failed history read as an error', () => {
    const truncated = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(3, [{ diff: 'a' }])]);
    expect(truncated.bodyHistory.complete).toBe(false);
    expect(evaluated(truncated, 'manifest-baseline').status).toBe('fail-closed');
    const failed = gather([GH_PR, GH_MANIFEST_404, [/api graphql/, failure('rate limited')]]);
    expect(failed.bodyHistory.error).toContain('rate limited');
    expect(evaluated(failed, 'manifest-baseline').status).toBe('fail-closed');
    expect(gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(2, [{ editedAt: '2026-10-02T00:00:00Z', diff: 'A real body' }, { editedAt: '2026-10-01T00:00:00Z', diff: 'old body' }])]).bodyHistory).toMatchObject({ complete: true });
  });

  it('never marks body history complete when an edit node has no readable diff (null/redacted/non-string)', () => {
    // GraphQL UserContentEdit.diff is nullable: a deleted or redacted edit counts toward totalCount but carries no body,
    // so the baseline would silently skip a version that may have held the manifest.
    for (const node of [{ diff: null }, {}, null, { diff: 42 }, { diff: ['x'] }]) {
      const facts = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(2, [{ editedAt: '2026-10-02T00:00:00Z', diff: 'A real body' }, node])]);
      expect(facts.bodyHistory.complete, JSON.stringify(node)).toBe(false);
      expect(evaluated(facts, 'manifest-baseline').status, JSON.stringify(node)).toBe('fail-closed');
    }
    // a fully readable history is still complete (the empty-string body is a real, readable version)
    expect(gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(2, [{ editedAt: '2026-10-02T00:00:00Z', diff: 'A real body' }, { editedAt: '2026-10-01T00:00:00Z', diff: '' }])]).bodyHistory.complete).toBe(true);
  });

  it('fails closed when the pinned head sha is not fetchable — never falls back to the live gh file list', () => {
    const facts = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])]);
    expect(facts.netSignals).toMatchObject({ scored: false, error: expect.stringContaining('not fetchable') });
    expect(facts.netSignals.fallbackFiles).toBeUndefined();
    expect(evaluated(facts, 'test-gaming').status).toBe('fail-closed');
    expect(evaluated(facts, 'review-acceptance').status).toBe('fail-closed');
  });

  it('reports a missing backlog dir as an error and a duplicate id as a hold', () => {
    const rules = [GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])];
    expect(evaluated(gather(rules, { cwd: checkout({ backlog: false }) }), 'duplicate-id-on-main').status).toBe('fail-closed');
    const dupRoot = checkout({ files: {} });
    writeFileSync(join(dupRoot, 'backlog', '9001-a.md'), '# a');
    writeFileSync(join(dupRoot, 'backlog', '9001-b.md'), '# b');
    const row = evaluated(gather(rules, { cwd: dupRoot }), 'duplicate-id-on-main');
    expect(row.status).toBe('hold');
    // the reason names the colliding id and files (findDuplicateIds returns {num, names}, not {id})
    expect(findDuplicateIds(join(dupRoot, 'backlog'))).toEqual([{ num: '9001', names: ['9001-a.md', '9001-b.md'] }]);
    expect(row.reason).toBe('duplicate backlog ids: #9001 (9001-a.md + 9001-b.md)');
    expect(row.reason).not.toContain('[object Object]');
  });

  it('reads the group tree duplicate scan result through to the gate', () => {
    const facts = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])], { groupDuplicateIds: [{ num: '5', names: ['a', 'b'] }] });
    expect(evaluated(facts, 'duplicate-id-on-main')).toMatchObject({ status: 'hold', reason: expect.stringContaining('#5 (a + b)') });
    // a group tree that could not be scanned is an error (fail closed), never a fake duplicate entry
    const missing = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])], { groupDuplicateIds: { error: 'group tree has no backlog dir' } });
    expect(evaluated(missing, 'duplicate-id-on-main')).toMatchObject({ status: 'fail-closed', reason: expect.stringContaining('group tree') });
  });
});

describe('ledger authority (mergeGate.reviewAuthority) reaches the evaluator', () => {
  const rules = [GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])];
  it('honors configured ledger authority and refuses unreadable ledger evidence', () => {
    expect(evaluated(gather(rules, { ledgerConfig: { authority: 'labels' } }), 'ledger').status).toBe('pass');
    for (const authority of ['both', 'ledger', 'bogus']) {
      const facts = gather(rules, { ledgerConfig: { authority } });
      expect(facts.ledger.authority, authority).toBe(authority);
      expect(evaluated(facts, 'ledger'), authority).toMatchObject({ status: 'fail-closed' });
      expect(evaluatePrGates(facts).ok).toBe(false);
    }
  });

  it('defaults an unset authority to labels but fails closed when the settings could not be read', () => {
    expect(evaluated(gather(rules, { ledgerConfig: {} }), 'ledger').status).toBe('pass');
    const unreadable = gather(rules, { ledgerConfig: { error: 'settings/x.json: not a JSON object' } });
    expect(evaluated(unreadable, 'ledger')).toMatchObject({ status: 'fail-closed', reason: expect.stringContaining('settings') });
  });

  it('fails closed when no ledger facts were gathered at all (never a silent labels default)', () => {
    const { ledger: _gone, ...without } = facts();
    expect(evaluated(without, 'ledger').status).toBe('fail-closed');
  });

  it('a gatherer called without ledgerConfig fails the ledger gate closed, not to labels', () => {
    const facts = gatherPrFacts({ repo: 'o/r', num: 7, cwd: checkout(), defaultBranch: 'main', exec: fakeExec([...rules, GH_FILES]) });
    expect(facts.ledger.error).toMatch(/not supplied/);
    expect(evaluated(facts, 'ledger').status).toBe('fail-closed');
  });

  describe('readLedgerConfig (the settings read)', () => {
    const cfg = (over) => readLedgerConfig(() => ({ settings: {}, errors: [], duplicates: [], ...over }));
    it('reads the configured authority and leaves an unset one undefined (the drain default)', () => {
      expect(cfg({ settings: { mergeGate: { reviewAuthority: 'both' } } })).toEqual({ authority: 'both' });
      expect(cfg({})).toEqual({ authority: undefined });
    });
    it.each([
      ['an unreadable settings file', { errors: [{ source: 'settings/x.json', error: 'bad json' }] }],
      ['two files setting mergeGate.reviewAuthority', { duplicates: [{ path: 'mergeGate.reviewAuthority', sources: ['a.json', 'b.json'] }] }],
      ['an explicit null authority', { settings: { mergeGate: { reviewAuthority: null } } }],
      ['a non-string authority', { settings: { mergeGate: { reviewAuthority: true } } }],
      ['an unknown authority', { settings: { mergeGate: { reviewAuthority: 'Ledger ' } } }],
      ['a malformed mergeGate block', { settings: { mergeGate: 'both' } }],
    ])('returns an error for %s', (_name, over) => {
      const got = cfg(over);
      expect(got.error, JSON.stringify(got)).toBeTruthy();
    });
    it('returns an error when the read itself throws', () => {
      expect(readLedgerConfig(() => { throw new Error('boom'); }).error).toContain('boom');
    });
  });

  it('populates the fact of every gate that reads a ledger or a local-only source', () => {
    const gathered = gather(rules);
    const factOf = { ledger: 'ledger', 'local-only': 'redMain' };
    for (const gate of DRAIN_GATES.filter((g) => g.where === 'merge-gate' && factOf[g.input])) {
      expect(gathered[factOf[gate.input]], `${gate.id} reads facts.${factOf[gate.input]}`).toBeDefined();
    }
  });
});

// ── merge-group membership: a partial list must never read as the whole group ─────────────────────────────

describe('merge group membership completeness', () => {
  const HEAD_REF = 'refs/heads/gh-readonly-queue/main/pr-42-abc123';
  const group = (over) => ({ repo: 'o/r', headSha: 'h', baseSha: 'b', headRef: HEAD_REF, cwd: '/x', ...over });
  // `<sha>\t<parents>\t<subject>` (the --format=%H%x09%P%x09%s the reader asks for).
  const log = (...lines) => ['git', /^git log /, lines.map((l) => { const [sha, ...rest] = l.split('\t'); return `${sha}\tp0 ${sha}h\t${rest.join('\t')}\n`; }).join('')];
  const rulesFor = (...rules) => fakeExec(rules.map(([cmd, re, out]) => [re, out]));

  it('rejects incomplete group discovery when only the head ref remains', () => {
    const exec = rulesFor([0, /api graphql/, failure('denied')], [0, /^git log /, failure('bad revision')]);
    const found = readGroupPrs(group({ exec }));
    expect(found.nums).toEqual([42]);
    expect(found.complete).toBe(false);
    expect(found.reasons.join(' ')).toMatch(/history/i);
  });

  it('is complete when every first-parent commit names a PR, even if the queue API is unreadable', () => {
    const exec = rulesFor([0, /api graphql/, failure('denied')], log('aaa1111\tMerge pull request #41 from a/b', 'bbb2222\tMerge pull request #42 from a/c'));
    expect(readGroupPrs(group({ exec }))).toMatchObject({ nums: [41, 42], complete: true, reasons: [] });
  });

  it('fails closed on a first-parent commit that maps to no PR (squash/rebase subject without a number)', () => {
    const exec = rulesFor([0, /api graphql/, JSON.stringify({})], log('aaa1111\tMerge pull request #41 from a/b', 'ccc3333\tfix: something'), [0, /commits\/ccc3333\/pulls/, '[]']);
    const found = readGroupPrs(group({ exec }));
    expect(found.complete).toBe(false);
    expect(found.reasons.join(' ')).toContain('ccc3333');
  });

  it('resolves an unnumbered commit through the commit→PR API', () => {
    const exec = rulesFor([0, /api graphql/, JSON.stringify({})], log('ccc3333\tfix: something'), [0, /commits\/ccc3333\/pulls/, '[{"number":40}]']);
    expect(readGroupPrs(group({ exec }))).toMatchObject({ nums: [40, 42], complete: true });
  });

  it('is incomplete with no commits to cross-check and treats the pure function the same way', () => {
    expect(groupMembership({ headRef: HEAD_REF, commits: [], commitsRead: true })).toMatchObject({ nums: [42], complete: false });
    expect(groupMembership({ headRef: HEAD_REF, commits: [{ sha: 'a', subject: 'x (#7)' }], commitsRead: true })).toMatchObject({ nums: [7, 42], complete: true });
  });

  it('fails the whole group closed when membership is incomplete, even if every listed PR passes', () => {
    const passing = [{ num: 42, ok: true }];
    expect(evaluateGroup(passing, { complete: true, reasons: [] }).ok).toBe(true);
    for (const unproven of [undefined, null, {}, { complete: undefined }, { complete: 'yes' }]) {
      expect(evaluateGroup(passing, unproven), JSON.stringify(unproven)).toMatchObject({ ok: false, reason: expect.stringContaining('incomplete') });
    }
    expect(evaluateGroup(passing, { complete: false, reasons: ['first-parent history unreadable'] })).toMatchObject({ ok: false, reason: expect.stringContaining('incomplete') });
  });
});

// ── the workflows: structure pinned, so a dropped trigger or ref cannot pass silently ─────────────────────

const workflowOf = (name) => yaml.load(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8'));
// js-yaml 3 parses the bare key `on` as boolean true.
const triggersOf = (wf) => wf.on ?? wf[true];

describe('merge-gate workflow structure', () => {
  const wf = workflowOf('merge-gate.yml');
  const job = wf.jobs['merge-gate'];
  const evaluate = job.steps.find((s) => /merge-gate-check\.mjs/.test(s.run || ''));

  it('runs on pull_request_target, merge_group and workflow_dispatch', () => {
    expect(Object.keys(triggersOf(wf))).toEqual(expect.arrayContaining(['pull_request_target', 'merge_group', 'workflow_dispatch']));
  });

  // PR #4708 round 6 (ruled block): for `pull_request` GitHub reads the YAML from the PR merge ref, so a PR could
  // edit this file to `exit 0`. `pull_request_target` reads it from main. Its classic danger (PR code + write
  // token) is pinned out: main checkout, read-only token, no cache write.
  it('never runs on `pull_request` (whose YAML the PR controls), and the pull_request_target leg stays read-only on main', () => {
    expect(Object.keys(triggersOf(wf))).not.toContain('pull_request');
    expect(triggersOf(wf).pull_request_target.branches).toEqual(['main']);
    for (const [scope, level] of Object.entries(wf.permissions)) expect(level, scope).toBe('read');
    expect(job.permissions).toBeUndefined();
    for (const step of job.steps) {
      if (/actions\/checkout/.test(step.uses || '')) expect(step.with?.ref, 'checkout must be main').toBe('main');
      if (/actions\/setup-node/.test(step.uses || '')) expect(step.with?.cache, 'no cache write from pull_request_target').toBeUndefined();
      expect(String(step.run || ''), 'no PR code is executed').not.toMatch(/github\.event\.pull_request\.head\.(ref|sha)\s*}}\s*$|checkout[^\n]*PR_HEAD/m);
    }
    expect(JSON.stringify(wf)).not.toMatch(/secrets\./);
  });

  it('checks out main, never the PR ref, before running the scripts', () => {
    const checkoutStep = job.steps.find((s) => /actions\/checkout/.test(s.uses || ''));
    expect(checkoutStep.with.ref).toBe('main');
    expect(job.steps.indexOf(checkoutStep)).toBeLessThan(job.steps.indexOf(evaluate));
  });

  it('validates the dispatch merge-group shas as 40-hex before git can read them as options', () => {
    const run = evaluate.run;
    expect(run).toMatch(/\[\[ "\$sha" =~ \^\[0-9a-f\]\{40\}\$ \]\][\s\S]*git fetch origin -- "\$MG_HEAD_SHA" "\$MG_BASE_SHA"/);
    const guard = run.match(/for sha in [^\n]*; do[\s\S]*?\n\s*done/)[0].replace(/^\s+/gm, '');
    const exits = (head, baseSha) => spawnSync('bash', ['-ec', guard], { env: { PATH: process.env.PATH, MG_HEAD_SHA: head, MG_BASE_SHA: baseSha }, encoding: 'utf8' }).status;
    expect(exits('a'.repeat(40), 'b'.repeat(40))).toBe(0);
    for (const bad of ['--upload-pack=touch /tmp/x', '-' + 'a'.repeat(39), 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(40) + '\n--upload-pack=x', '']) {
      expect(exits(bad, 'b'.repeat(40)), JSON.stringify(bad)).not.toBe(0);
      expect(exits('a'.repeat(40), bad), JSON.stringify(bad)).not.toBe(0);
    }
  });

  it('does not claim the YAML itself is pinned to main (only the scripts are)', () => {
    const header = readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8').split('\nname:')[0];
    expect(header).not.toMatch(/cannot neuter its\s+own gate/i);
    expect(header).toMatch(/not pinned[^\n]*workflow YAML/i);
    expect(header).toMatch(/workflow\s*(?:#\s*)?file from the PR's merge ref/i);
    expect(header).toMatch(/pull_request_target[^\n]*reads the YAML from the base branch/i);
    expect(header).toMatch(/from the group commit/i);
  });

  it('names the ruleset required-workflow pin as the defence for the unpinned YAML, not only escalation', () => {
    const header = readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8').split('\nname:')[0];
    expect(header).toMatch(/rulesetSuggestion[\s\S]*requiredWorkflows|requiredWorkflows[\s\S]*refs\/heads\/main/);
  });

  it('names the human-only enqueue refusal as the guard that needs no ruleset, and no longer calls review escalation the only one', () => {
    const header = readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8').split('\nname:')[0];
    expect(header).not.toMatch(/the only guard is review escalation/i);
    expect(header).toMatch(/enqueuePr[\s\S]*refuses[\s\S]*HUMAN[\s\S]*\.github\/workflows\/\*\*/);
    // honest limits: not wired yet, and a hand-added queue entry bypasses it (only the ruleset pin closes that)
    expect(header).toMatch(/does not call enqueuePr yet/);
    expect(header).toMatch(/by hand[\s\S]*bypasses enqueuePr[\s\S]*only by the ruleset/);
    // the PR-run human-only hold is named as the layer that does not depend on the ruleset
    expect(header).toMatch(/HUMAN-ONLY WORKFLOW EDITS IN THE PR RUN[\s\S]*workflowEditFact/);
    expect(header).not.toMatch(/never decides a merge/);
  });

  describe('bootstrap shim', () => {
    const run = (present, headSha = 'c'.repeat(40)) => {
      const root = mkdtempSync(join(tmpdir(), 'merge-gate-boot-'));
      tmpRoots.push(root);
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      for (const f of present) writeFileSync(join(root, f), '');
      for (const tool of ['git', 'node']) writeFileSync(join(root, 'bin', tool), `#!/bin/sh\necho "${tool} $@" >> calls.log\n`, { mode: 0o755 });
      const proc = spawnSync('bash', ['-c', evaluate.run], { cwd: root, encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, PR_NUMBER: '5', PR_HEAD_SHA: headSha, REPO: 'o/r', EVENT: 'pull_request', RUNNER_TEMP: root } });
      let calls = '';
      try { calls = readFileSync(join(root, 'calls.log'), 'utf8'); } catch { /* none */ }
      return { status: proc.status, calls, out: `${proc.stdout}${proc.stderr}` };
    };
    it('reports clear only while main has neither the script nor this workflow (true bootstrap)', () => {
      expect(run([])).toMatchObject({ status: 0, calls: '' });
    });
    it('fails closed when the workflow is on main but the script is gone (rename/removal)', () => {
      const result = run(['.github/workflows/merge-gate.yml']);
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/failing closed/i);
    });
    it('runs the check when the script is present', () => {
      const result = run(['scripts/merge-gate-check.mjs', '.github/workflows/merge-gate.yml']);
      expect(result.status).toBe(0);
      expect(result.calls).toContain(`merge-gate-check.mjs --repo=o/r --pr=5 --expect-head=${'c'.repeat(40)}`);
    });
    it('fails closed on a pull_request without a 40-hex head sha (the pin cannot be dropped)', () => {
      for (const bad of ['', 'lane/x', '-' + 'c'.repeat(39)]) {
        const result = run(['scripts/merge-gate-check.mjs', '.github/workflows/merge-gate.yml'], bad);
        expect(result.status, JSON.stringify(bad)).toBe(1);
        expect(result.calls, JSON.stringify(bad)).not.toContain('merge-gate-check.mjs');
      }
    });
    it('references a script that exists in this tree', () => {
      expect(() => readFileSync(new URL('../../merge-gate-check.mjs', import.meta.url))).not.toThrow();
      expect(evaluate.run).toContain('scripts/merge-gate-check.mjs');
    });
  });
});

describe('ci.yml and soak-replay-gate.yml report on merge_group', () => {
  const ci = workflowOf('ci.yml');
  // Exact allow-list: a required job runs on merge_group only with no `if`, or an `if` that is exactly
  // `!cancelled()` (no event filter at all). Any other condition — including one that merely CONTAINS
  // `!cancelled()` beside an event filter — is refused, because a skipped required job counts as passing.
  const RUNS_ON_EVERY_EVENT = new Set(['${{ !cancelled() }}', '!cancelled()']);
  const onMergeGroup = (job) => job.if === undefined || RUNS_ON_EVERY_EVENT.has(String(job.if).trim());

  it('triggers on merge_group', () => {
    expect(Object.keys(triggersOf(ci))).toContain('merge_group');
  });

  it('runs the daemon-soak scope and aggregator on merge_group, and never excludes test or smoke', () => {
    for (const name of ['daemon-soak-scope', 'daemon-soak']) expect(String(ci.jobs[name].if), name).toMatch(/github\.event_name == 'merge_group'/);
    for (const name of ['test', 'smoke']) expect(onMergeGroup(ci.jobs[name]), name).toBe(true);
  });

  it('the merge_group predicate rejects a job condition that would skip on merge_group', () => {
    for (const cond of ["${{ github.event_name == 'pull_request' && !cancelled() }}", "github.event_name != 'merge_group' && !cancelled()",
      "${{ !cancelled() && github.event_name == 'push' }}", '${{ false }}', "${{ github.event_name == 'merge_group' && false }}"]) {
      expect(onMergeGroup({ if: cond }), cond).toBe(false);
    }
    expect(onMergeGroup({})).toBe(true);
    expect(onMergeGroup({ if: '${{ !cancelled() }}' })).toBe(true);
  });

  it('soak-replay-gate triggers on merge_group and its group step fails closed on a failed or empty list', () => {
    const wf = workflowOf('soak-replay-gate.yml');
    expect(Object.keys(triggersOf(wf))).toContain('merge_group');
    const step = wf.jobs['soak-replay-gate'].steps.find((s) => /merge_group/.test(String(s.if || '')));
    expect(step.run).toMatch(/--list-group [^\n]*\) *\|\| *\{[^}]*exit 1/);
    expect(step.run).toMatch(/\[ -n "\$PRS" \] *\|\| *\{[^}]*exit 1/);
    expect(step.run).toMatch(/merge-gate-check\.mjs/);
  });
});

// The merge-gate workflow YAML is NOT pinned to main (only the scripts are): a PR that edits it is judged by the
// review escalation alone. Pin that this escalation fires, so the header's honest claim stays true.
describe('a diff to the merge-gate workflow is escalated, not waved through', () => {
  const file = '.github/workflows/merge-gate.yml';
  const patch = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-run: node scripts/merge-gate-check.mjs\n+run: exit 0\n`;
  const edit = { netSignals: { changedFiles: [file], humanBasisFiles: [file], diffLines: 2, cumulativeDiffLines: 2, netDiffText: { text: patch, scored: true }, diffHunks: patch } };

  it('scores the edit as a blast-radius escalation', () => {
    const score = scoreEscalation({ changedFiles: [file], diffLines: 2, humanBasisFiles: [file], cumulativeDiffLines: 2, dismissedFindings: 0, crossRepo: false, diffHunks: patch, basisNarrowed: true });
    expect(score).toMatchObject({ escalate: true, signals: { blastRadius: [file] } });
  });

  it('holds review-acceptance for that edit until an independent review accepts it', () => {
    const pending = facts({ ...edit, pr: { labels: labels('ready-to-merge', 'review:pending') }, acceptance: null });
    expect(evaluated(pending, 'review-acceptance'), JSON.stringify(evaluatePrGates(pending).blocking)).toMatchObject({ status: 'hold' });
  });
});

// Class guard: every workflow file that defines a required check is run from main by the ruleset. A workflow added
// later with a job named like a required check (the review's "add a new workflow with a job named merge-gate"
// shape) fails here until it is listed, so the YAML pin cannot silently miss one.
describe('every workflow defining a required check is in the ruleset required-workflow pin', () => {
  const dir = new URL('../../../.github/workflows/', import.meta.url);
  const required = rulesetSuggestion({}).requiredStatusChecks;
  const pinned = new Set(rulesetSuggestion({}).requiredWorkflows.map((w) => w.path));

  it('lists each such workflow file', () => {
    const definers = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const wf = yaml.load(readFileSync(new URL(file, dir), 'utf8'));
      const names = Object.entries(wf.jobs || {}).flatMap(([id, job]) => [id, job?.name].filter(Boolean).map(String));
      if (names.some((n) => required.includes(n))) definers.push(`.github/workflows/${file}`);
    }
    expect(definers).toEqual(expect.arrayContaining(['.github/workflows/merge-gate.yml']));
    expect(definers.filter((p) => !pinned.has(p)), 'workflow defines a required check but is not pinned to main').toEqual([]);
  });
});

// ── every git read is pinned to the PR's exact head sha, never to its branch name (review finding, #4708) ──

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'merge-gate-pin-'));
  tmpRoots.push(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const clone = join(root, 'clone');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, work);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  mkdirSync(join(work, 'backlog'));
  writeFileSync(join(work, 'backlog', '1-a.md'), '# a');
  writeFileSync(join(work, 'README.md'), 'base\n');
  git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'base'); git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  const commit = (branch, file, text) => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), text);
    git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', file);
    git(work, 'push', '--quiet', '-f', 'origin', `HEAD:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  };
  git(root, 'clone', '--quiet', origin, clone);
  return { git, work, clone, commit };
}
/** Real git in the clone, faked gh. Records every git argv. */
function realGitExec(clone, ghRules) {
  const gh = fakeExec(ghRules);
  const gitCalls = [];
  const exec = (cmd, args, opts = {}) => {
    if (cmd !== 'git') return gh(cmd, args, opts);
    gitCalls.push(args.join(' '));
    return execFileSync('git', args, { ...opts, cwd: opts.cwd || clone });
  };
  exec.gitCalls = gitCalls;
  return exec;
}

describe('gatherPrFacts pins every git read to the exact head sha', () => {
  it('TOCTOU: the branch moves after the PR was read — the gate still judges the pinned sha, not the branch', () => {
    const { git, work, clone, commit } = gitRepo();
    git(work, 'checkout', '--quiet', '-b', 'lane/x');
    const pinned = commit('lane/x', 'docs/a.md', 'pinned change\n');
    // After the event (and after `gh pr view` returned headRefOid=pinned), the branch is moved to a commit that
    // edits a test and a workflow. Diffing the branch NAME would judge this commit instead.
    commit('lane/x', 'scripts/__tests__/x.test.mjs', 'it.skip("x", () => {})\n');
    const moved = commit('lane/x', '.github/workflows/ci.yml', 'run: exit 0\n');
    expect(moved).not.toBe(pinned);
    const exec = realGitExec(clone, [[/pr view 7 .*--json number,title/, () => prJson({ headRefOid: pinned, headRefName: 'lane/x', labels: [{ name: 'ready-to-merge' }] })],
      GH_MANIFEST_404, GH_HISTORY(0, [])]);
    const facts = gatherPrFacts({ repo: 'o/r', num: 7, cwd: clone, defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, expectedHeadSha: pinned, exec });
    expect(facts.pinnedHead).toEqual({ sha: pinned });
    expect(facts.netSignals).toMatchObject({ scored: true, changedFiles: [expect.stringContaining('docs/a.md')] });
    expect(facts.netSignals.netDiffText.rev).toBe(pinned);
    expect(facts.netSignals.netDiffText.text).toContain('pinned change');
    expect(facts.netSignals.netDiffText.text).not.toMatch(/exit 0|it\.skip/);
    // the human-only workflow-edit rule reads the PINNED sha's files too: the moved branch's workflow edit is unseen
    expect(facts.gatePaths).toEqual({ files: ['docs/a.md'] });
    // no git call names the branch — fetch, merge-base and diff all use the sha
    expect(exec.gitCalls.filter((c) => /lane\/x/.test(c))).toEqual([]);
    expect(exec.gitCalls.some((c) => c.includes(`fetch --quiet --end-of-options origin ${pinned}`))).toBe(true);
  });

  it('a pinned head that edits a workflow is held for a human, even after the branch moved to a safe commit', () => {
    const { git, work, clone, commit } = gitRepo();
    git(work, 'checkout', '--quiet', '-b', 'lane/x');
    const safe = commit('lane/x', 'docs/a.md', 'safe\n');
    const evil = commit('lane/x', '.github/workflows/merge-gate.yml', 'jobs: { merge-gate: { steps: [{ run: exit 0 }] } }\n');
    git(work, 'push', '--quiet', '-f', 'origin', `${safe}:refs/heads/lane/x`);
    const exec = realGitExec(clone, [[/pr view 7 .*--json number,title/, () => prJson({ headRefOid: evil, headRefName: 'lane/x' })], GH_MANIFEST_404, GH_HISTORY(0, []),
      [/pr view 7 .*headRefOid,headRefName,comments/, JSON.stringify({ headRefOid: evil, headRefName: 'lane/x', comments: [] })]]);
    const facts = gatherPrFacts({ repo: 'o/r', num: 7, cwd: clone, defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, expectedHeadSha: evil, exec });
    expect(facts.gatePaths.files).toEqual(expect.arrayContaining(['.github/workflows/merge-gate.yml']));
    expect(evaluated(facts, 'review-acceptance')).toMatchObject({ status: 'hold', reason: expect.stringContaining('human-only') });
    expect(exec.gitCalls.filter((c) => /lane\/x/.test(c))).toEqual([]);
  });

  it('a head that moved since the event (PR now at another sha) fails the diff-reading gates closed', () => {
    const { git, work, clone, commit } = gitRepo();
    git(work, 'checkout', '--quiet', '-b', 'lane/x');
    const eventSha = commit('lane/x', 'docs/a.md', 'one\n');
    const now = commit('lane/x', 'docs/b.md', 'two\n');
    const exec = realGitExec(clone, [[/pr view 7 .*--json number,title/, () => prJson({ headRefOid: now })], GH_MANIFEST_404, GH_HISTORY(0, [])]);
    const facts = gatherPrFacts({ repo: 'o/r', num: 7, cwd: clone, defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, expectedHeadSha: eventSha, exec });
    expect(facts.netSignals.error).toMatch(/head moved since the event/);
    expect(facts.acceptance.error).toMatch(/head moved/);
    for (const id of ['review-acceptance', 'test-gaming']) expect(evaluated(facts, id).status, id).toBe('fail-closed');
    expect(exec.gitCalls).toEqual([]);
  });

  it('fails closed for a fork head, an unread isCrossRepository, a merge-group PR with no pinned sha, and a malformed sha', () => {
    const live = { headRefOid: HEAD, isCrossRepository: false };
    expect(pinnedHeadOf(live)).toEqual({ sha: HEAD });
    expect(pinnedHeadOf(live, { expected: HEAD, requireExpected: true })).toEqual({ sha: HEAD });
    expect(pinnedHeadOf({ ...live, isCrossRepository: true }).error).toMatch(/fork/);
    expect(pinnedHeadOf({ headRefOid: HEAD }).error).toMatch(/isCrossRepository unread/);
    expect(pinnedHeadOf(live, { requireExpected: true }).error).toMatch(/merge group/);
    expect(pinnedHeadOf(live, { expected: 'lane/x' }).error).toMatch(/40-hex/);
    expect(pinnedHeadOf({ ...live, headRefOid: 'main' }).error).toMatch(/40-hex/);
    const fork = gather([[/pr view 7 .*--json number,title/, () => prJson({ isCrossRepository: true })], GH_MANIFEST_404, GH_HISTORY(1, [])]);
    expect(evaluated(fork, 'review-acceptance').status).toBe('fail-closed');
    expect(evaluated(fork, 'test-gaming').status).toBe('fail-closed');
  });

  it('a merge group pins each PR to the second parent of its queue merge commit; ambiguous or squash commits get no pin', () => {
    const a = '1'.repeat(40); const b = '2'.repeat(40);
    expect(groupHeadsOf([
      { sha: 'm1', parents: ['p', a], subject: 'Merge pull request #41 from o/x' },
      { sha: 'm2', parents: ['m1', b], subject: 'Merge pull request #42 from o/y' },
      { sha: 'm3', parents: ['m2'], subject: 'squashed thing (#43)' },
    ])).toEqual({ 41: a, 42: b });
    expect(groupHeadsOf([
      { sha: 'm1', parents: ['p', a], subject: 'Merge pull request #41 from o/x' },
      { sha: 'm2', parents: ['m1', b], subject: 'Merge pull request #41 from o/x' },
    ])).toEqual({});
    const exec = fakeExec([[/api graphql/, '{}'], [/^git log /, `m1\tp ${a}\tMerge pull request #41 from o/x\n`]]);
    expect(readGroupPrs({ repo: 'o/r', headSha: 'h', baseSha: 'b', headRef: '', cwd: '/x', exec })).toMatchObject({ nums: [41], complete: true, heads: { 41: a } });
  });
});

// ── historical PR bodies: each edit entry must be PROVEN a full body before it serves as a baseline ────────

describe('bodyHistoryOf', () => {
  const live = 'A real body';
  const edits = (...nodes) => ({ totalCount: nodes.length, nodes });
  it('accepts edit entries as full bodies only when the newest equals the live body', () => {
    expect(bodyHistoryOf(live, edits())).toEqual({ bodies: [live], complete: true });
    expect(bodyHistoryOf(live, edits({ editedAt: '2026-10-02T00:00:00Z', diff: live }, { editedAt: '2026-10-01T00:00:00Z', diff: manifestBody })))
      .toEqual({ bodies: [live, live, manifestBody], complete: true });
    // CRLF-only difference is the same body (GitHub stores some edits with \r\n)
    expect(bodyHistoryOf('a\nb', edits({ editedAt: '2026-10-02T00:00:00Z', diff: 'a\r\nb' })).complete).toBe(true);
  });
  it('fails closed when the newest entry is not the live body (an entry that is a diff/fragment, not a full body)', () => {
    for (const nodes of [[{ editedAt: '2026-10-02T00:00:00Z', diff: '+ added line' }], [{ diff: live }],
      [{ editedAt: '2026-10-01T00:00:00Z', diff: live }, { editedAt: '2026-10-02T00:00:00Z', diff: '- removed manifest' }]]) {
      const h = bodyHistoryOf(live, edits(...nodes));
      expect(h.complete, JSON.stringify(nodes)).toBe(false);
      expect(evaluated(facts({ bodyHistory: h }), 'manifest-baseline').status).toBe('fail-closed');
    }
  });
  it('a manifest in the earliest full body that a later edit removed holds the PR', () => {
    const h = bodyHistoryOf(live, edits({ editedAt: '2026-10-03T00:00:00Z', diff: live }, { editedAt: '2026-10-01T00:00:00Z', diff: manifestBody }));
    expect(evaluated(facts({ bodyHistory: h }), 'manifest-baseline')).toMatchObject({ status: 'hold', reason: expect.stringContaining('weakened') });
  });
});

// ── the running workflow must be main's (self-check) ─────────────────────────────────────────────────────

describe('verifyRunningWorkflow', () => {
  const WF = '.github/workflows/merge-gate.yml';
  const setup = () => {
    const { git, work, clone, commit } = gitRepo();
    commit('main', WF, 'name: Merge gate\n');
    git(clone, 'fetch', '--quiet', 'origin');
    git(work, 'checkout', '--quiet', '-b', 'lane/x');
    return { git, work, clone, commit };
  };
  const env = (sha, ref = `o/r/${WF}@refs/pull/7/merge`) => ({ GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: ref, GITHUB_WORKFLOW_SHA: sha });
  const run = (clone, e) => verifyRunningWorkflow({ env: e, cwd: clone, defaultBranch: 'main', exec: (c, a, o) => execFileSync(c, a, { ...o, cwd: clone }) });

  it('passes when the running workflow file is byte-identical to main, and outside Actions is local-only', () => {
    const { clone, commit } = setup();
    const sha = commit('lane/x', 'docs/a.md', 'x\n');
    expect(run(clone, env(sha))).toMatchObject({ ok: true, path: WF });
    expect(run(clone, {})).toMatchObject({ ok: true, local: true });
  });
  it('fails closed when the PR edits the running workflow, or the ref/sha is unreadable or unfetchable', () => {
    const { clone, commit } = setup();
    const sha = commit('lane/x', WF, 'name: Merge gate\non: push\njobs: { merge-gate: { steps: [{ run: exit 0 }] } }\n');
    expect(run(clone, env(sha))).toMatchObject({ ok: false, reason: expect.stringContaining('differs from main') });
    expect(run(clone, env(sha, 'garbage'))).toMatchObject({ ok: false, reason: expect.stringContaining('GITHUB_WORKFLOW_REF') });
    expect(run(clone, env('main'))).toMatchObject({ ok: false, reason: expect.stringContaining('GITHUB_WORKFLOW_SHA') });
    expect(run(clone, env('f'.repeat(40)))).toMatchObject({ ok: false, reason: expect.stringContaining('could not be compared') });
    // a new workflow file (named merge-gate job) that main does not have fails closed too
    const other = commit('lane/x', '.github/workflows/evil.yml', 'jobs: { merge-gate: {} }\n');
    expect(run(clone, env(other, 'o/r/.github/workflows/evil.yml@refs/pull/7/merge')).ok).toBe(false);
  });
});

// ── operator guidance: the printed ruleset carries the workflows pin and the Actions integration id ───────

describe('--print-ruleset (the operator ruleset steps come from rulesetSuggestion)', () => {
  it('prints the main-pinned required workflows and the GitHub Actions integration id', () => {
    const script = new URL('../../merge-gate-check.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--print-ruleset'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const rs = JSON.parse(out);
    expect(rs.requiredStatusCheckIntegrationId).toBe(15368);
    expect(rs.requiredStatusChecks).toEqual(expect.arrayContaining(['merge-gate', 'test', 'smoke']));
    expect(rs.requiredWorkflows).toEqual(expect.arrayContaining([{ path: '.github/workflows/merge-gate.yml', ref: 'refs/heads/main' }]));
    for (const w of rs.requiredWorkflows) expect(w.ref).toBe('refs/heads/main');
  });
  it('the workflow header names both the workflows pin and the integration-id restriction, and the self-check', () => {
    const header = readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8').split('\nname:')[0];
    expect(header).toMatch(/workflows[\s\S]*refs\/heads\/main/);
    expect(header).toMatch(/integration id/i);
    expect(header).toMatch(/--print-ruleset/);
    expect(header).toMatch(/verifyRunningWorkflow/);
  });
});

// ── main() glue, exercised through the real CLI (PR #4708 round-6 finding, merge-gate-check.mjs:330) ───────
// The pure helpers are unit-tested above; these spawn the script with a fake `gh` on PATH and a real git clone,
// so deleting a guard in main() (the self-check fold, the incomplete-group refusal, the --expect-head arity
// check, the --group-tree requirement) reddens a test.
describe('merge-gate-check.mjs main() (spawned CLI)', () => {
  const script = new URL('../../merge-gate-check.mjs', import.meta.url).pathname;
  const WF = '.github/workflows/merge-gate.yml';
  const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
if (/^repo view/.test(a)) out({ defaultBranchRef: { name: 'main' } });
if (/^pr view \\d+ .*--json number,title/.test(a)) out(JSON.parse(process.env.FAKE_PR_JSON));
if (/userContentEdits/.test(a)) out({ data: { repository: { pullRequest: { userContentEdits: { totalCount: 0, nodes: [] } } } } });
if (/mergeQueue/.test(a)) out({ data: { repository: { mergeQueue: { entries: { nodes: [] } } } } });
if (/^api repos\\/[^ ]+\\/commits\\/[0-9a-f]+\\/pulls/.test(a)) out([]);
process.stderr.write('fake gh: unexpected ' + a + '\\n'); process.exit(1);
`;
  const setup = () => {
    const repo = gitRepo();
    const bin = join(repo.clone, '..', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    return { ...repo, bin };
  };
  const run = (ctx, args, extraEnv = {}) => {
    const proc = spawnSync(process.execPath, [script, '--repo=o/r', `--cwd=${ctx.clone}`, ...args], {
      encoding: 'utf8',
      env: { PATH: `${ctx.bin}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_PR_JSON: prJson(extraEnv.pr || {}), ...extraEnv.env },
    });
    return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
  };
  // A merge group on top of main: one queue merge commit for PR #7 (+ optionally a commit that maps to no PR).
  const group = (ctx, { stray = false } = {}) => {
    const { git, work, clone, commit } = ctx;
    const base = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '--quiet', '-b', 'lane/x');
    const prHead = commit('lane/x', 'docs/a.md', 'pr\n');
    git(work, 'checkout', '--quiet', '-B', 'grp', base);
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'Merge pull request #7 from o/lane/x', prHead);
    if (stray) { writeFileSync(join(work, 'stray.txt'), 's\n'); git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'hand-made commit'); }
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', '-f', 'origin', 'HEAD:refs/heads/gh-readonly-queue/main/pr-7');
    git(clone, 'fetch', '--quiet', 'origin');
    return { base, head, prHead };
  };

  it('the workflow self-check forces HOLD: a running workflow that differs from main fails the verdict closed', () => {
    const ctx = setup();
    ctx.commit('main', WF, 'name: Merge gate\n');
    ctx.git(ctx.work, 'checkout', '--quiet', '-b', 'lane/x');
    const edited = ctx.commit('lane/x', WF, 'name: Merge gate\njobs: { merge-gate: { steps: [{ run: exit 0 }] } }\n');
    ctx.git(ctx.clone, 'fetch', '--quiet', 'origin');
    const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: `o/r/${WF}@refs/pull/7/merge`, GITHUB_WORKFLOW_SHA: edited };
    const r = run(ctx, ['--pr=7', '--json'], { env, pr: { headRefOid: edited } });
    expect(r.status, r.stderr).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.workflowCheck).toMatchObject({ ok: false, reason: expect.stringContaining('differs from main') });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/^workflow self-check failed — fail closed/);
    // control: the same run with the workflow equal to main's reports the self-check ok (so the reason above came from it)
    const same = run(ctx, ['--pr=7', '--json'], { env: { ...env, GITHUB_WORKFLOW_SHA: ctx.git(ctx.clone, 'rev-parse', 'origin/main') }, pr: { headRefOid: edited } });
    expect(JSON.parse(same.stdout).workflowCheck.ok).toBe(true);
    expect(JSON.parse(same.stdout).reason).not.toMatch(/workflow self-check failed/);
  });

  it('--list-group refuses an incomplete group (no numbers printed, exit 1) and prints a complete one', () => {
    const ctx = setup();
    const g = group(ctx, { stray: true });
    const bad = run(ctx, ['--merge-group', '--list-group', `--head-sha=${g.head}`, `--base-sha=${g.base}`]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/membership incomplete[\s\S]*maps to no PR/);
    const ok = setup();
    const g2 = group(ok);
    const good = run(ok, ['--merge-group', '--list-group', `--head-sha=${g2.head}`, `--base-sha=${g2.base}`]);
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toBe('7\n');
  });

  it('--expect-head pins exactly one PR: two PRs are a usage error (exit 3)', () => {
    const ctx = setup();
    const r = run(ctx, ['--pr=7,8', `--expect-head=${HEAD}`]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/--expect-head pins exactly one --pr/);
  });

  it('a merge_group run without --group-tree fails duplicate-id-on-main closed; with it, the scan runs', () => {
    const ctx = setup();
    const g = group(ctx);
    const args = ['--merge-group', '--json', `--head-sha=${g.head}`, `--base-sha=${g.base}`];
    const without = run(ctx, args, { pr: { headRefOid: g.prHead } });
    expect(without.status).toBe(1);
    const dupOf = (stdout) => JSON.parse(stdout).prs[0].results.find((x) => x.id === 'duplicate-id-on-main');
    expect(dupOf(without.stdout)).toMatchObject({ status: 'fail-closed', reason: expect.stringContaining('--group-tree missing') });
    const tree = join(ctx.clone, '..', 'group-tree');
    mkdirSync(join(tree, 'backlog'), { recursive: true });
    const withTree = run(ctx, [...args, `--group-tree=${tree}`], { pr: { headRefOid: g.prHead } });
    expect(dupOf(withTree.stdout)).toMatchObject({ status: 'pass' });
  });
});

// ── mergeGate.mode: shadow | enforce (operator-approved 2026-10-10: shadow until the red-main source, #4715) ──
// Shadow changes ONLY the exit code: every rule is evaluated and reported exactly as in enforce.

describe('mergeGate.mode resolves through the policy cascade', () => {
  it('defaults to the standard value, shadow, with its source named', () => {
    expect(resolveMergeGateMode({})).toMatchObject({ mode: 'shadow', source: 'standard' });
    expect(STANDARD_MERGE_GATE_MODE).toBe('shadow');
  });

  it('each higher layer wins: standard < platform < repo < env', () => {
    expect(resolveMergeGateMode({ platform: 'enforce' })).toMatchObject({ mode: 'enforce', source: 'platform' });
    expect(resolveMergeGateMode({ platform: 'enforce', repo: 'shadow' })).toMatchObject({ mode: 'shadow', source: 'repo' });
    expect(resolveMergeGateMode({ platform: 'shadow', repo: 'enforce' })).toMatchObject({ mode: 'enforce', source: 'repo' });
    expect(resolveMergeGateMode({ repo: 'enforce', env: 'shadow' })).toMatchObject({ mode: 'shadow', source: 'env' });
  });

  it('an empty env value (an unset repository variable) is "not set", not an override', () => {
    expect(resolveMergeGateMode({ repo: 'enforce', env: '' })).toMatchObject({ mode: 'enforce', source: 'repo' });
  });

  it('an invalid value at any layer fails closed to enforce, never silently to shadow', () => {
    for (const layers of [{ env: 'off' }, { repo: 'Shadow' }, { platform: 7 }, { repo: 'enforce', env: 'shadw' }]) {
      const r = resolveMergeGateMode(layers);
      expect(r.mode, JSON.stringify(layers)).toBe('enforce');
      expect(r.source).toMatch(/fail-closed/);
    }
  });

  it('loadMergeGateMode reads platform file, declared repo settings and the env', () => {
    const readFile = () => JSON.stringify({ mergeGate: { mode: 'enforce' } });
    const read = (repoMode) => () => ({ settings: repoMode ? { mergeGate: { mode: repoMode } } : {}, errors: [], duplicates: [] });
    expect(loadMergeGateMode({ env: {}, readFile, readDeclared: read(null) })).toMatchObject({ mode: 'enforce', source: 'platform' });
    expect(loadMergeGateMode({ env: {}, readFile, readDeclared: read('shadow') })).toMatchObject({ mode: 'shadow', source: 'repo' });
    expect(loadMergeGateMode({ env: { MERGE_GATE_MODE: 'enforce' }, readFile, readDeclared: read('shadow') })).toMatchObject({ mode: 'enforce', source: 'env' });
    const enoent = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    expect(loadMergeGateMode({ env: {}, readFile: enoent, readDeclared: read(null) })).toMatchObject({ mode: 'shadow', source: 'standard' });
  });

  it('an unreadable layer fails closed to enforce (a skipped file could be the one that says enforce)', () => {
    const ok = () => ({ settings: {}, errors: [], duplicates: [] });
    const bad = () => { throw new Error('EACCES'); };
    expect(loadMergeGateMode({ env: {}, readFile: bad, readDeclared: ok })).toMatchObject({ mode: 'enforce', source: expect.stringMatching(/fail-closed/) });
    const errs = () => ({ settings: {}, errors: [{ source: 'x.json', error: 'bad json' }], duplicates: [] });
    expect(loadMergeGateMode({ env: {}, readFile: () => '{}', readDeclared: errs })).toMatchObject({ mode: 'enforce' });
    const dup = () => ({ settings: { mergeGate: { mode: 'shadow' } }, errors: [], duplicates: [{ path: 'mergeGate.mode', sources: ['a.json', 'b.json'] }] });
    expect(loadMergeGateMode({ env: {}, readFile: () => '{}', readDeclared: dup })).toMatchObject({ mode: 'enforce' });
  });
});

describe('applyGateMode changes only the exit code', () => {
  const held = evaluatePrGates(facts({ redMain: { source: null } }), {});
  const passing = evaluatePrGates(facts(), {});
  const report = (prs) => ({ ok: prs.every((p) => p.ok), reason: prs.every((p) => p.ok) ? 'all pass' : 'held', prs });

  it('shadow: a HOLD verdict exits 0 and names the holding rules', () => {
    expect(held.ok).toBe(false);
    const out = applyGateMode({ mode: 'shadow', source: 'standard', childStatus: 1, report: report([held]) });
    expect(out.exitCode).toBe(0);
    expect(out.text).toMatch(/SHADOW: would HOLD on red-main-freeze/);
    expect(out.text).toMatch(/fail-closed\s+red-main-freeze\s+no shared red-main freeze source yet/);
    expect(out.text).toMatch(/merge-gate: HOLD/);
    expect(out.summary).toMatch(/SHADOW: would HOLD on red-main-freeze/);
    expect(out.summary).toMatch(/mode: shadow \(source: standard\)/);
  });

  it('enforce: the same HOLD exits 1 with the same table (today\'s behaviour)', () => {
    const s = applyGateMode({ mode: 'shadow', source: 'standard', childStatus: 1, report: report([held]) });
    const e = applyGateMode({ mode: 'enforce', source: 'repo', childStatus: 1, report: report([held]) });
    expect(e.exitCode).toBe(1);
    expect(e.text).not.toMatch(/SHADOW/);
    const table = (t) => t.split('\n').filter((l) => /^(#\d+:|\s{2}\S)/.test(l)).join('\n');
    expect(table(e.text)).toBe(table(s.text));
  });

  it('a pass is a pass in both modes', () => {
    for (const mode of ['shadow', 'enforce']) {
      const out = applyGateMode({ mode, source: 'standard', childStatus: 0, report: report([passing]) });
      expect(out.exitCode).toBe(0);
      expect(out.text).not.toMatch(/would HOLD/);
    }
  });

  it('a hold that is not one rule (workflow self-check) is still named in shadow', () => {
    const out = applyGateMode({ mode: 'shadow', source: 'standard', childStatus: 1, report: { ok: false, reason: 'workflow self-check failed — fail closed: x', prs: [passing] } });
    expect(out.exitCode).toBe(0);
    expect(out.text).toMatch(/SHADOW: would HOLD on workflow self-check failed/);
  });

  it('no verdict (crash, usage error, unparsable or inconsistent output) is never masked, even in shadow', () => {
    for (const [childStatus, rep] of [[1, null], [3, null], [1, { ok: true, prs: [] }], [0, { ok: false, prs: [held] }], [1, { prs: [] }]]) {
      const out = applyGateMode({ mode: 'shadow', source: 'standard', childStatus, report: rep });
      expect(out.exitCode, JSON.stringify([childStatus, rep])).toBe(childStatus === 0 ? 1 : childStatus);
      expect(out.text).toMatch(/no verdict/);
    }
  });
});

describe('runGate (the workflow wrapper around merge-gate-check.mjs)', () => {
  const script = join(new URL('../../', import.meta.url).pathname, 'merge-gate-check.mjs');
  const heldReport = () => {
    const p = evaluatePrGates(facts({ redMain: { source: null } }), {});
    return JSON.stringify({ ok: false, reason: 'held', prs: [p] });
  };
  const harness = (stdout, status) => {
    const calls = [];
    const written = [];
    const summary = [];
    return {
      calls, written, summary,
      deps: {
        spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout }; },
        write: (s) => written.push(s), warn: (s) => written.push(s), appendSummary: (s) => summary.push(s),
      },
    };
  };

  it('runs merge-gate-check.mjs with --json, logs the mode source, and exits 0 in shadow on a hold', () => {
    const h = harness(heldReport(), 1);
    const code = runGate({ argv: ['--', 'scripts/merge-gate-check.mjs', '--repo=o/r', '--pr=5'], modeInfo: { mode: 'shadow', source: 'standard' }, ...h.deps });
    expect(code).toBe(0);
    expect(h.calls[0].slice(1)).toEqual([script, '--repo=o/r', '--pr=5', '--json']);
    expect(h.written.join('')).toMatch(/merge-gate mode: shadow \(source: standard\)/);
    expect(h.summary.join('')).toMatch(/SHADOW: would HOLD on red-main-freeze/);
  });

  it('enforce passes the hold through as exit 1', () => {
    const h = harness(heldReport(), 1);
    expect(runGate({ argv: ['--', 'scripts/merge-gate-check.mjs', '--pr=5'], modeInfo: { mode: 'enforce', source: 'repo' }, ...h.deps })).toBe(1);
  });

  it('refuses to wrap anything but merge-gate-check.mjs (usage error, exit 3)', () => {
    for (const argv of [[], ['--'], ['--', 'scripts/evil.mjs', '--pr=5'], ['scripts/merge-gate-check.mjs']]) {
      const h = harness('', 0);
      expect(runGate({ argv, modeInfo: { mode: 'shadow', source: 'standard' }, ...h.deps }), JSON.stringify(argv)).toBe(3);
      expect(h.calls).toEqual([]);
    }
  });
});

describe('merge-gate workflow: mode wiring and trigger hygiene', () => {
  const wf = workflowOf('merge-gate.yml');
  const job = wf.jobs['merge-gate'];
  const evaluate = job.steps.find((s) => /merge-gate-check\.mjs/.test(s.run || ''));
  const UNWATCHED = "(github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.label.name != 'ready-to-merge' && !startsWith(github.event.label.name, 'review:')";

  it('every merge-gate-check.mjs call goes through the mode wrapper, and the env layer comes from a repo variable', () => {
    const calls = evaluate.run.split('\n').filter((l) => /node [^\n]*merge-gate-check\.mjs/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l).toMatch(/node scripts\/lib\/merge-gate-ci\.mjs --run-gate -- scripts\/merge-gate-check\.mjs /);
    expect(evaluate.env.MERGE_GATE_MODE).toBe('${{ vars.MERGE_GATE_MODE }}');
  });

  it('runs on head changes and label changes only (no edited / ready_for_review)', () => {
    expect(triggersOf(wf).pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
    expect(Object.keys(triggersOf(wf))).toContain('merge_group');
  });

  it('skips unwatched label events under a DIFFERENT check name, so a skipped run never stands in for merge-gate', () => {
    // A skipped job reports as passing for a required check: the skipped run must not be named `merge-gate`.
    expect(job.if).toBe(`\${{ !(${UNWATCHED}) }}`);
    expect(job.name).toBe(`\${{ ${UNWATCHED} && 'merge-gate (unwatched label, skipped)' || 'merge-gate' }}`);
  });

  it('one live run per PR, superseded runs cancelled, and an unwatched-label run can never cancel a real one', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(wf.concurrency.group).toBe(`merge-gate-\${{ ${UNWATCHED} && format('unwatched-{0}', github.run_id) || github.event.pull_request.number || github.event.merge_group.head_sha || github.run_id }}`);
  });
});
