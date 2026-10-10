// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { ENQUEUE_MUTATION, mergeActionFor, buildEnqueueArgs, enqueuePr, planQueueFollowUps, rulesetSuggestion, workflowEditHold, normalizeGatePath } from '../merge-queue-enqueue.mjs';

const HEAD = 'a'.repeat(40);

// A fake `gh`: the PR read, the paginated file listing (one `[filename, previous]` JSON line per file), the mutation.
const execFor = ({ files, changedFiles = files?.length, mutation = '{}', calls = [], filesError }) => (cmd, args) => {
  calls.push([cmd, args]);
  if (args[0] === 'pr') return JSON.stringify({ id: 'PR_1', changedFiles });
  if (args[0] === 'api' && args[1] === '--paginate') {
    if (filesError) throw new Error(filesError);
    return files.map((f) => JSON.stringify(f)).join('\n');
  }
  return mutation;
};

describe('merge queue enqueue', () => {
  it.each([
    [{ strategy: 'github-merge-queue' }, 'enqueue'],
    [{ strategy: 'drain-direct' }, 'merge'],
    [null, 'merge'],
  ])('chooses the action for %j', (policy, action) => {
    expect(mergeActionFor(policy)).toBe(action);
  });

  it('builds a mutation pinned to the PR node and judged head', () => {
    const args = buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD });
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining([`query=${ENQUEUE_MUTATION}`, 'id=PR_1', `sha=${HEAD}`]));
    expect(() => buildEnqueueArgs({ headSha: HEAD })).toThrow(/node id required/);
    expect(() => buildEnqueueArgs({ nodeId: 'PR_1' })).toThrow(/head SHA required/);
  });

  it('reads the node id and file list, then enqueues exactly the judged head', () => {
    const calls = [];
    const entry = { id: 'E', position: 1, state: 'QUEUED' };
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: execFor({ files: [['scripts/a.mjs', '']], mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: entry } } }), calls }) });
    expect(result).toEqual({ ok: true, entry });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '7', '--repo', 'o/r', '--json', 'id,changedFiles']]);
    expect(calls[1][1].slice(0, 3)).toEqual(['api', '--paginate', 'repos/o/r/pulls/7/files?per_page=100']);
    expect(calls[2][0]).toBe('gh');
    expect(calls[2][1]).toEqual(buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD }));
    expect(calls[2][1]).toContain(`sha=${HEAD}`);
  });

  it.each([
    ['already in the merge queue', { ok: true, already: true }],
    ['permission denied', { ok: false, error: 'permission denied' }],
  ])('handles GraphQL errors: %s', (message, expected) => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: execFor({ files: [['a.txt', '']], mutation: JSON.stringify({ errors: [{ message }] }), calls }) });
    expect(result).toEqual(expected);
    expect(calls).toHaveLength(3);
  });

  it('fails without enqueueing when the PR read throws', () => {
    let calls = 0;
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: () => {
      calls += 1;
      throw new Error('offline');
    } });
    expect(result).toEqual({ ok: false, error: 'node id read failed: offline' });
    expect(calls).toBe(1);
  });

  it('filters completed follow-ups and orders the remainder by merge time', () => {
    expect(planQueueFollowUps({ merged: [
      { number: 3, mergedAt: '2026-01-03T00:00:00Z', mergeCommit: { oid: 'c' } },
      { number: 1, mergedAt: '2026-01-01T00:00:00Z', mergeCommit: { oid: 'a' } },
      { number: 2, mergedAt: '2026-01-02T00:00:00Z', mergeCommit: { oid: 'b' } },
    ], followedUp: new Set([2]) })).toEqual([
      { num: 1, mergeSha: 'a', mergedAt: '2026-01-01T00:00:00Z' },
      { num: 3, mergeSha: 'c', mergedAt: '2026-01-03T00:00:00Z' },
    ]);
  });

  it('suggests the configured queue and required safety checks', () => {
    const result = rulesetSuggestion({ mergeMethod: 'merge', batchSize: 3, maxGroupWaitMinutes: 5 });
    expect(result.mergeQueue).toMatchObject({ mergeMethod: 'MERGE', maxEntriesToBuild: 3, minEntriesToMergeWaitMinutes: 5 });
    expect(result.requiredStatusChecks).toEqual(expect.arrayContaining(['merge-gate', 'test']));
  });
});

// The required checks' workflow YAML is read from the PR merge ref / group commit, so the ruleset must run
// those workflows from main (a `workflows` rule) and only accept a check posted by the GitHub Actions app.
describe('rulesetSuggestion pins the required workflows to main', () => {
  const result = rulesetSuggestion({ mergeMethod: 'merge', batchSize: 3, maxGroupWaitMinutes: 5 });

  it('requires merge-gate.yml, ci.yml and soak-replay-gate.yml from refs/heads/main', () => {
    const byPath = Object.fromEntries(result.requiredWorkflows.map((w) => [w.path, w]));
    for (const path of ['.github/workflows/merge-gate.yml', '.github/workflows/ci.yml', '.github/workflows/soak-replay-gate.yml']) {
      expect(byPath[path], path).toMatchObject({ ref: 'refs/heads/main' });
    }
  });

  it('only accepts required checks posted by the GitHub Actions app', () => {
    expect(result.requiredStatusCheckIntegrationId).toBe(15368);
  });
});

// The required `merge-gate` check is a workflow a PR can edit to `exit 0`, and no check a PR can edit can defend
// that. So the drain (running from main, outside the PR's reach) never enqueues a PR whose diff touches one.
describe('a PR that touches a workflow file is never enqueued (human-only hold)', () => {
  const held = (files, extra = {}) => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: execFor({ files, calls, ...extra }) });
    return { result, mutated: calls.some(([, args]) => args[1] === 'graphql') };
  };

  it.each([
    ['the gate workflow itself', [['.github/workflows/merge-gate.yml', '']]],
    ['a new workflow carrying a required check name', [['.github/workflows/evil.yml', ''], ['scripts/a.mjs', '']]],
    ['the .yaml spelling', [['.github/workflows/merge-gate.yaml', '']]],
    ['a composite action the workflows call', [['.github/actions/setup/action.yml', '']]],
    ['a rename OUT of the workflows directory', [['docs/gate.yml', '.github/workflows/merge-gate.yml']]],
    ['a rename INTO the workflows directory', [['.github/workflows/merge-gate.yml', 'docs/gate.yml']]],
    ['a different case', [['.GitHub/Workflows/Merge-Gate.yml', '']]],
    ['a ./ prefix', [['./.github/workflows/x.yml', '']]],
    ['backslash separators', [['.github\\workflows\\x.yml', '']]],
    ['doubled slashes', [['.github//workflows/x.yml', '']]],
    ['fullwidth look-alike characters', [['．github/workflows/x.yml', '']]],
    ['a dot-dot segment', [['scripts/../.github/workflows/x.yml', '']]],
  ])('holds %s for a human and sends no mutation', (_name, files) => {
    const { result, mutated } = held(files);
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: expect.stringMatching(/workflow-edit/) });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(mutated).toBe(false);
  });

  it.each([
    ['the PR file listing is truncated', { files: [['a.txt', '']], changedFiles: 2 }],
    ['the listing has more entries than the PR reports', { files: [['a.txt', ''], ['b.txt', '']], changedFiles: 1 }],
    ['the PR reports no file count', { files: [['a.txt', '']], changedFiles: null }],
    ['the listing reaches the 3000-file REST limit', { files: Array.from({ length: 3000 }, (_, i) => [`f${i}.txt`, '']) }],
    ['the file listing call fails', { files: [], changedFiles: 1, filesError: 'rate limited' }],
  ])('fails closed (human hold, no mutation) when %s', (_name, opts) => {
    const { result, mutated } = held(opts.files, opts);
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable' });
    expect(mutated).toBe(false);
  });

  it('fails closed on a malformed repo or PR number instead of building a REST path from it', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r/../../x', num: 7, headSha: HEAD, exec: execFor({ files: [['a.txt', '']], calls }) });
    expect(result).toMatchObject({ ok: false, held: true, reason: 'unreadable' });
    expect(calls.some(([, a]) => a[1] === 'graphql' || a[1] === '--paginate')).toBe(false);
  });

  it('enqueues an ordinary PR, including one that merely names github or workflows in a path', () => {
    const files = [['docs/github/workflows.md', ''], ['scripts/.github-notes.txt', ''], ['workflows/x.yml', ''], ['.githubx/workflows/x.yml', '']];
    const { result, mutated } = held(files, { mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } }) });
    expect(result).toMatchObject({ ok: true });
    expect(mutated).toBe(true);
  });

  it('a workflow-edit hold is human-only and not retryable', () => {
    expect(held([['.github/workflows/x.yml', '']]).result).toMatchObject({ humanOnly: true, retryable: false });
  });

  // The refusal only binds if nothing else can send the mutation: any script that does is a bypass.
  it('no script other than merge-queue-enqueue.mjs sends the enqueue mutation', () => {
    const root = new URL('../../../scripts/', import.meta.url);
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '.git') continue;
        const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:mjs|js|cjs|ts)$/.test(e.name) && e.name !== 'merge-queue-enqueue.mjs' && /enqueuePullRequest|ENQUEUE_MUTATION|buildEnqueueArgs/.test(readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) offenders.push(p.pathname);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('workflowEditHold is a pure decision over plain strings too, and normalizes paths consistently', () => {
    expect(workflowEditHold({ files: ['a.txt', '.github/workflows/x.yml'], expectedCount: 2 })).toMatchObject({ hold: true, reason: 'workflow-edit', paths: ['.github/workflows/x.yml'] });
    expect(workflowEditHold({ files: ['a.txt'], expectedCount: 1 })).toEqual({ hold: false });
    expect(workflowEditHold({ files: [], expectedCount: 0 })).toEqual({ hold: false });
    expect(workflowEditHold({})).toMatchObject({ hold: true, reason: 'unreadable' });
    expect(normalizeGatePath('.\\.GitHub//Workflows/X.yml')).toBe('.github/workflows/x.yml');
  });
});
