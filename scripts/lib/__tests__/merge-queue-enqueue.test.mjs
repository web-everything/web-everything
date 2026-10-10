// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENQUEUE_MUTATION, mergeActionFor, buildEnqueueArgs, enqueuePr, planQueueFollowUps, rulesetSuggestion, workflowEditHold, normalizeGatePath, readPinnedChangedFiles } from '../merge-queue-enqueue.mjs';

const HEAD = 'a'.repeat(40);

// A fake `gh` + `git`: the PR read (live head), the pinned git diff of HEAD (NUL-separated paths), the mutation.
// `--no-renames` means a rename arrives as two paths (old + new), so the fakes list both.
const execFor = ({ files, liveHead = HEAD, mutation = '{}', calls = [], filesError }) => (cmd, args) => {
  calls.push([cmd, args]);
  if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'PR_1', headRefOid: liveHead, baseRefName: 'main' });
  if (cmd === 'git') {
    if (args[0] === 'diff') {
      if (filesError) throw new Error(filesError);
      return files.map((f) => (Array.isArray(f) ? f.filter(Boolean).join('\0') : f)).join('\0');
    }
    return '';
  }
  return mutation;
};
const CWD = '/clone';

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
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['scripts/a.mjs', '']], mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: entry } } }), calls }) });
    expect(result).toEqual({ ok: true, entry });
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '7', '--repo', 'o/r', '--json', 'id,headRefOid,baseRefName']]);
    const diff = calls.find(([c, a]) => c === 'git' && a[0] === 'diff');
    expect(diff[1]).toEqual(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', `refs/remotes/origin/main...${HEAD}`]);
    expect(calls.some(([c, a]) => c === 'gh' && a.includes('--paginate'))).toBe(false);
    const last = calls.at(-1);
    expect(last[0]).toBe('gh');
    expect(last[1]).toEqual(buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD }));
    expect(last[1]).toContain(`sha=${HEAD}`);
  });

  it.each([
    ['already in the merge queue', { ok: true, already: true }],
    ['permission denied', { ok: false, error: 'permission denied' }],
  ])('handles GraphQL errors: %s', (message, expected) => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], mutation: JSON.stringify({ errors: [{ message }] }), calls }) });
    expect(result).toEqual(expected);
    expect(calls.filter(([c, a]) => c === 'gh' && a[1] === 'graphql')).toHaveLength(1);
  });

  it('fails without enqueueing when the PR read throws', () => {
    let calls = 0;
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: () => {
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
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files, calls, ...extra }) });
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
    ['the pinned git diff fails', { files: [], filesError: 'fatal: bad object' }],
  ])('fails closed (retryable hold, no mutation) when %s', (_name, opts) => {
    const { result, mutated } = held(opts.files, opts);
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable' });
    expect(mutated).toBe(false);
  });

  it('fails closed with no checkout to read the pinned diff from', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: execFor({ files: [['a.txt', '']], calls }) });
    expect(result).toMatchObject({ ok: false, held: true, retryable: true, reason: 'unreadable' });
    expect(calls.some(([, a]) => a[1] === 'graphql')).toBe(false);
  });

  it('holds (retryable, no mutation) when the PR head is no longer the judged sha', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], liveHead: 'b'.repeat(40), calls }) });
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'head-moved' });
    expect(calls.some(([c]) => c === 'git')).toBe(false);
    expect(calls.some(([, a]) => a[1] === 'graphql')).toBe(false);
  });

  it('fails closed on a malformed repo or PR number before any read', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r/../../x', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], calls }) });
    expect(result).toMatchObject({ ok: false, held: true, reason: 'unreadable' });
    expect(calls).toEqual([]);
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

// PR #4708 round-6 finding (merge-queue-enqueue.mjs, ruled block): the workflow-edit refusal read the REST
// `pulls/{n}/files` list, which describes whatever the branch points at NOW, not the head being enqueued. The
// refusal now reads git at the exact sha. Real repos: the branch moves between judging and enqueueing.
describe('the workflow-edit refusal reads the change list of the exact enqueued sha (real git)', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'mq-pin-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-qb', 'lane/x');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'safe');
    const safe = git(work, 'rev-parse', 'HEAD');
    mkdirSync(join(work, '.github/workflows'), { recursive: true });
    writeFileSync(join(work, '.github/workflows/merge-gate.yml'), 'jobs: {}\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'evil');
    const evil = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'lane/x');
    git(root, 'clone', '-q', origin, clone);
    return { root, work, clone, safe, evil };
  };
  // gh answers with the given live head; git runs for real in the clone.
  const realExec = (liveHead, calls) => (cmd, args, opts) => {
    calls.push([cmd, args]);
    if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'PR_1', headRefOid: liveHead, baseRefName: 'main' });
    if (cmd === 'gh') return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } });
    return execFileSync(cmd, args, opts);
  };

  it('holds the sha that touches a workflow, even when the branch NAME now points at a safe commit', () => {
    const { root, work, clone, safe, evil } = setup();
    try {
      git(work, 'push', '-qf', 'origin', `${safe}:refs/heads/lane/x`); // the branch moves back to the safe commit
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: evil, cwd: clone, exec: realExec(evil, calls) });
      expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: 'workflow-edit', paths: ['.github/workflows/merge-gate.yml'] });
      expect(calls.some(([c, a]) => c === 'gh' && a[1] === 'graphql')).toBe(false);
      expect(calls.some(([c, a]) => c === 'git' && a.includes('lane/x'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('enqueues the safe sha with expectedHeadOid pinned to it, even though the branch now carries the workflow edit', () => {
    const { root, clone, safe } = setup();
    try {
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: safe, cwd: clone, exec: realExec(safe, calls) });
      expect(result).toMatchObject({ ok: true });
      const mutation = calls.find(([c, a]) => c === 'gh' && a[1] === 'graphql');
      expect(mutation[1]).toContain(`sha=${safe}`);
      expect(readPinnedChangedFiles({ headSha: safe, cwd: clone }).files).toEqual(['b.txt']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lists both sides of a rename out of the workflows directory', () => {
    const { root, work, clone, evil } = setup();
    try {
      git(work, 'push', '-q', 'origin', `${evil}:refs/heads/main`);
      git(work, 'mv', '.github/workflows/merge-gate.yml', 'docs-gate.yml');
      git(work, 'commit', '-qm', 'rename');
      const renamed = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '-qf', 'origin', `${renamed}:refs/heads/lane/x`);
      const files = readPinnedChangedFiles({ headSha: renamed, cwd: clone }).files;
      expect(files.sort()).toEqual(['.github/workflows/merge-gate.yml', 'docs-gate.yml']);
      expect(workflowEditHold({ files, expectedCount: files.length })).toMatchObject({ hold: true, humanOnly: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an unfetchable sha fails closed', () => {
    const { root, clone } = setup();
    try {
      expect(readPinnedChangedFiles({ headSha: 'f'.repeat(40), cwd: clone })).toHaveProperty('error');
      expect(readPinnedChangedFiles({ headSha: 'nope', cwd: clone })).toHaveProperty('error');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
