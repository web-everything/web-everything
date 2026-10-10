// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { evaluatePrGates, evaluateGroup, groupPrNumbers, groupMembership, asQueuedPr } from '../merge-gate-ci.mjs';
import { DRAIN_GATES } from '../merge-gate-inventory.mjs';
import { scoreEscalation } from '../review-escalation.mjs';
import { MANIFEST_BODY_BEGIN, MANIFEST_BODY_END, extractManifestFromBody } from '../../readiness/lane-manifest.mjs';
import { gatherPrFacts, readGroupPrs, readLedgerConfig, mergeEventOfFlags } from '../../merge-gate-check.mjs';

const HEAD = 'a'.repeat(40);
const base = () => ({
  repo: 'o/r', num: 7, defaultBranch: 'main',
  pr: { number: 7, title: 't', body: 'A real body', baseRefName: 'main', headRefName: 'lane/x', headRefOid: HEAD,
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
    expect(gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [{ diff: 'old body' }])]).bodyHistory).toMatchObject({ complete: true });
  });

  it('falls back to the gh file list when git cannot score the diff, and test-gaming then fails closed', () => {
    const facts = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])]);
    expect(facts.netSignals).toMatchObject({ scored: false, fallbackFiles: true, changedFiles: ['docs/a.md'] });
    expect(evaluated(facts, 'test-gaming').status).toBe('fail-closed');
  });

  it('reports a missing backlog dir as an error and a duplicate id as a hold', () => {
    const rules = [GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])];
    expect(evaluated(gather(rules, { cwd: checkout({ backlog: false }) }), 'duplicate-id-on-main').status).toBe('fail-closed');
    const dupRoot = checkout({ files: {} });
    writeFileSync(join(dupRoot, 'backlog', '9001-a.md'), '# a');
    writeFileSync(join(dupRoot, 'backlog', '9001-b.md'), '# b');
    expect(evaluated(gather(rules, { cwd: dupRoot }), 'duplicate-id-on-main').status).toBe('hold');
  });

  it('reads the group tree duplicate scan result through to the gate', () => {
    const facts = gather([GH_PR, GH_MANIFEST_404, GH_HISTORY(1, [])], { groupDuplicateIds: [{ num: '5', names: ['a', 'b'] }] });
    expect(evaluated(facts, 'duplicate-id-on-main').status).toBe('hold');
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
  const log = (...lines) => ['git', /^git log /, lines.map((l) => `${l}\n`).join('')];
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

  it('runs on pull_request, merge_group and workflow_dispatch', () => {
    expect(Object.keys(triggersOf(wf))).toEqual(expect.arrayContaining(['pull_request', 'merge_group', 'workflow_dispatch']));
  });

  it('checks out main, never the PR ref, before running the scripts', () => {
    const checkoutStep = job.steps.find((s) => /actions\/checkout/.test(s.uses || ''));
    expect(checkoutStep.with.ref).toBe('main');
    expect(job.steps.indexOf(checkoutStep)).toBeLessThan(job.steps.indexOf(evaluate));
  });

  it('does not claim the YAML itself is pinned to main (only the scripts are)', () => {
    const header = readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8').split('\nname:')[0];
    expect(header).not.toMatch(/cannot neuter its\s+own gate/i);
    expect(header).toMatch(/not pinned[^\n]*workflow YAML/i);
    expect(header).toMatch(/workflow file from the PR's merge ref/i);
    expect(header).toMatch(/from the group commit/i);
  });

  describe('bootstrap shim', () => {
    const run = (present) => {
      const root = mkdtempSync(join(tmpdir(), 'merge-gate-boot-'));
      tmpRoots.push(root);
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      for (const f of present) writeFileSync(join(root, f), '');
      for (const tool of ['git', 'node']) writeFileSync(join(root, 'bin', tool), `#!/bin/sh\necho "${tool} $@" >> calls.log\n`, { mode: 0o755 });
      const proc = spawnSync('bash', ['-c', evaluate.run], { cwd: root, encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, PR_NUMBER: '5', REPO: 'o/r', EVENT: 'pull_request', RUNNER_TEMP: root } });
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
      expect(result.calls).toContain('merge-gate-check.mjs --repo=o/r --pr=5');
    });
    it('references a script that exists in this tree', () => {
      expect(() => readFileSync(new URL('../../merge-gate-check.mjs', import.meta.url))).not.toThrow();
      expect(evaluate.run).toContain('scripts/merge-gate-check.mjs');
    });
  });
});

describe('ci.yml and soak-replay-gate.yml report on merge_group', () => {
  const ci = workflowOf('ci.yml');
  const onMergeGroup = (job) => job.if === undefined || /merge_group/.test(String(job.if)) || /!cancelled\(\)/.test(String(job.if));

  it('triggers on merge_group', () => {
    expect(Object.keys(triggersOf(ci))).toContain('merge_group');
  });

  it('runs the daemon-soak scope and aggregator on merge_group, and never excludes test or smoke', () => {
    for (const name of ['daemon-soak-scope', 'daemon-soak']) expect(String(ci.jobs[name].if), name).toMatch(/github\.event_name == 'merge_group'/);
    for (const name of ['test', 'smoke']) expect(onMergeGroup(ci.jobs[name]), name).toBe(true);
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
