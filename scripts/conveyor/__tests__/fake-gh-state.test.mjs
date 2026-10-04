/**
 * @file fake-gh-state.test.mjs — proves generation 2 of `helpers/fake-gh.mjs` (#3383, daemon-scenario
 * simulator part 2 "Fake GitHub") against REAL git, exercised through the REAL `execFileSync('gh', …)` call
 * path (never an injected spawner) — mirrors the reasoning `helpers/real-repo.mjs` and `helpers/fake-claude.mjs`
 * give for their own real-subprocess fixtures: asserting an argv's spelling never proves a CLI accepts it.
 *
 * Every scenario builds its own throwaway bare `origin` + work clone with `real-repo.mjs`'s identity
 * conventions (see that file's header details (1)-(3): per-invocation `-c user.*`/`commit.gpgsign=false` PLUS
 * the same written into each repo's own `.git/config`, so a commit made by code this test does not control —
 * `createMergeCommit`'s own `git commit-tree` — never dies on a missing signing program).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGithub, addLabelsPure, removeLabelsPure, applyBranchDeletionPure, requirePr } from './helpers/fake-gh.mjs';
import { git, writeLocalIdentity, DEFAULT_BRANCH } from '../../operations/__tests__/helpers/real-repo.mjs';

const execFileAsync = promisify(execFile);
const cleanups = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()(); } catch { /* best effort */ } } });

/** One bare origin + one work clone, both git-identity-safe (real-repo.mjs conventions). */
function makeOrigin(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const originPath = join(tmp, 'origin.git');
  git(['init', '--quiet', '--bare', '-b', DEFAULT_BRANCH, originPath], { cwd: tmp });
  writeLocalIdentity(originPath);
  const clonePath = join(tmp, 'clone');
  git(['clone', '--quiet', originPath, clonePath], { cwd: tmp });
  writeLocalIdentity(clonePath);
  writeFileSync(join(clonePath, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], { cwd: clonePath });
  git(['commit', '--quiet', '-m', 'init'], { cwd: clonePath });
  git(['push', '--quiet', 'origin', DEFAULT_BRANCH], { cwd: clonePath });
  return { tmp, originPath, clonePath };
}

/** Branch a real commit onto `branch` in the clone and push it — for scenarios that need real file content
 *  (conflicts, diffs). */
function commitBranch(clonePath, branch, files, from = DEFAULT_BRANCH) {
  git(['checkout', '--quiet', '-B', branch, from], { cwd: clonePath });
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(clonePath, rel), content);
  git(['add', '-A'], { cwd: clonePath });
  git(['commit', '--quiet', '-m', `fixture: ${branch}`], { cwd: clonePath });
  git(['push', '--quiet', '--force', 'origin', branch], { cwd: clonePath });
}

/** A branch with no new commit — cheap plumbing, used by the 200-PR / concurrency fixtures that only need
 *  the ref to EXIST (createFakeGithub.openPr's own branch-exists guard), not real diff content. */
function seedBranchAt(originPath, branch, atRef = DEFAULT_BRANCH) {
  const oid = git(['rev-parse', atRef], { cwd: originPath }).trim();
  git(['update-ref', `refs/heads/${branch}`, oid], { cwd: originPath });
}

function makeGithub(originPath, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fake-gh-store-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const gh = createFakeGithub({ root, repos: [{ slug: 'web-everything/web-everything', originPath, defaultBranch: DEFAULT_BRANCH, ...opts }] });
  cleanups.push(gh.cleanup);
  return gh;
}

const SLUG = 'web-everything/web-everything';

function ghExec(gh, args, cwd) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gh.env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

function ghExecAsync(gh, args, cwd) {
  return execFileAsync('gh', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gh.env } });
}

describe('fake-gh generation 2 — stateful fake GitHub (#3383)', () => {
  it('open/list/view produce realistic GitHub shapes', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-open-');
    const gh = makeGithub(originPath);
    commitBranch(clonePath, 'lane/x1-thing', { 'a.txt': 'hello\n' });

    const n = gh.openPr({ repo: SLUG, head: 'lane/x1-thing', base: DEFAULT_BRANCH, title: 'Thing', labels: ['review:pending'] });
    expect(n).toBe(1);

    const listOut = ghExec(gh, ['pr', 'list', '--repo', SLUG, '--state', 'open', '--json', 'number,title,headRefName,baseRefName,labels,state,isDraft,author'], clonePath);
    const list = JSON.parse(listOut);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: 1, title: 'Thing', headRefName: 'lane/x1-thing', baseRefName: DEFAULT_BRANCH,
      state: 'OPEN', isDraft: false, author: { login: 'agent' },
    });
    expect(list[0].labels).toEqual([{ name: 'review:pending' }]);

    const viewOut = ghExec(gh, ['pr', 'view', '1', '--repo', SLUG, '--json', 'number,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'], clonePath);
    const view = JSON.parse(viewOut);
    expect(view.number).toBe(1);
    expect(view.headRefOid).toMatch(/^[0-9a-f]{40}$/);
    expect(view.mergeable).toBe('MERGEABLE');
    expect(view.mergeStateStatus).toBe('CLEAN');
    expect(view.statusCheckRollup).toEqual([{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: expect.any(String), completedAt: expect.any(String) }]);
  });

  it('label add/remove writes labeled/unlabeled events; missing label fails, label create fixes it', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-labels-');
    const gh = makeGithub(originPath);
    commitBranch(clonePath, 'lane/x2', { 'a.txt': 'hi\n' });
    const n = gh.openPr({ repo: SLUG, head: 'lane/x2', title: 'x2' });

    // seeded label works
    expect(() => ghExec(gh, ['pr', 'edit', String(n), '--repo', SLUG, '--add-label', 'review:accepted'], clonePath)).not.toThrow();
    expect(gh.pr(SLUG, n).labels).toEqual([{ name: 'review:accepted' }]);

    // unseeded label fails loudly
    expect(() => ghExec(gh, ['pr', 'edit', String(n), '--repo', SLUG, '--add-label', 'review-round:3'], clonePath)).toThrow();

    // label create fixes it
    ghExec(gh, ['label', 'create', 'review-round:3', '--repo', SLUG, '--color', 'ededed', '--description', ''], clonePath);
    ghExec(gh, ['pr', 'edit', String(n), '--repo', SLUG, '--add-label', 'review-round:3'], clonePath);
    expect(gh.pr(SLUG, n).labels.map((l) => l.name)).toEqual(expect.arrayContaining(['review:accepted', 'review-round:3']));

    // remove + events
    ghExec(gh, ['pr', 'edit', String(n), '--repo', SLUG, '--remove-label', 'review:accepted'], clonePath);
    const view = gh.pr(SLUG, n);
    expect(view.labels.map((l) => l.name)).toEqual(['review-round:3']);

    const eventsOut = ghExec(gh, ['api', '--method', 'GET', `repos/${SLUG}/issues/${n}/events`], clonePath);
    const events = JSON.parse(eventsOut);
    const eventNames = events.map((e) => e.event);
    expect(eventNames.filter((e) => e === 'labeled')).toHaveLength(2);
    expect(eventNames.filter((e) => e === 'unlabeled')).toHaveLength(1);
  });

  it('unit: addLabelsPure/removeLabelsPure are pure — no I/O, testable on a plain object', () => {
    const repoState = { labels: { 'review:pending': {} }, prs: { 1: { number: 1, labels: [], events: [], comments: [] } }, nextCommentId: 1 };
    addLabelsPure(repoState, 1, ['review:pending'], { actor: 'bot', now: 1000 });
    expect(repoState.prs[1].labels).toEqual(['review:pending']);
    expect(repoState.prs[1].events).toEqual([{ event: 'labeled', label: 'review:pending', actor: 'bot', createdAt: new Date(1000).toISOString() }]);
    expect(() => addLabelsPure(repoState, 1, ['nope'])).toThrow(/not found/);
    removeLabelsPure(repoState, 1, ['review:pending'], { actor: 'bot', now: 2000 });
    expect(repoState.prs[1].labels).toEqual([]);
  });

  it('comment viewerDidAuthor reflects the CALLER, not the comment author', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-comment-');
    const gh = makeGithub(originPath); // default actor: we-daemon-bot
    commitBranch(clonePath, 'lane/x3', { 'a.txt': 'hi\n' });
    const n = gh.openPr({ repo: SLUG, head: 'lane/x3', title: 'x3' });

    ghExec(gh, ['pr', 'comment', String(n), '--repo', SLUG, '--body', 'from the daemon'], clonePath);
    gh.comment(SLUG, n, 'from a human', { author: 'nic' });

    const view = gh.pr(SLUG, n); // read as the fake's own actor (we-daemon-bot)
    expect(view.comments).toHaveLength(2);
    expect(view.comments[0]).toMatchObject({ body: 'from the daemon', author: { login: 'we-daemon-bot' }, viewerDidAuthor: true });
    expect(view.comments[1]).toMatchObject({ body: 'from a human', author: { login: 'nic' }, viewerDidAuthor: false });
  });

  it('conflict detection: a real conflicting commit on main flips mergeable/mergeStateStatus', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-conflict-');
    const gh = makeGithub(originPath);
    commitBranch(clonePath, 'lane/conflict', { 'a.txt': 'feature side\n' }, DEFAULT_BRANCH);
    commitBranch(clonePath, DEFAULT_BRANCH, { 'a.txt': 'main side\n' }, DEFAULT_BRANCH);
    const n = gh.openPr({ repo: SLUG, head: 'lane/conflict', base: DEFAULT_BRANCH, title: 'conflict' });

    const view = gh.pr(SLUG, n);
    expect(view.mergeable).toBe('CONFLICTING');
    expect(view.mergeStateStatus).toBe('DIRTY');
  });

  it('merge creates a real merge commit, deletes the head branch, and closes a PR stacked on it', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-merge-close-');
    const gh = makeGithub(originPath, { deleteBranchOnMerge: false });
    commitBranch(clonePath, 'lane/a', { 'a.txt': 'a\n' }, DEFAULT_BRANCH);
    commitBranch(clonePath, 'lane/b', { 'b.txt': 'b\n' }, 'lane/a');
    const prA = gh.openPr({ repo: SLUG, head: 'lane/a', base: DEFAULT_BRANCH, title: 'A' });
    const prB = gh.openPr({ repo: SLUG, head: 'lane/b', base: 'lane/a', title: 'B (stacked on A)' });

    const commitOid = gh.mergePr(SLUG, prA, { deleteBranch: true });
    expect(commitOid).toMatch(/^[0-9a-f]{40}$/);

    expect(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/lane/a'], { cwd: originPath })).toThrow();
    expect(git(['rev-parse', DEFAULT_BRANCH], { cwd: originPath }).trim()).toBe(commitOid);

    const viewA = gh.pr(SLUG, prA);
    expect(viewA.state).toBe('MERGED');
    expect(viewA.mergedAt).toEqual(expect.any(String));

    const viewB = gh.pr(SLUG, prB);
    expect(viewB.state).toBe('CLOSED'); // deleteBranchOnMerge: false → close, not retarget
  });

  it('merge with repo.deleteBranchOnMerge retargets the stacked PR instead of closing it', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-merge-retarget-');
    const gh = makeGithub(originPath, { deleteBranchOnMerge: true });
    commitBranch(clonePath, 'lane/a', { 'a.txt': 'a\n' }, DEFAULT_BRANCH);
    commitBranch(clonePath, 'lane/b', { 'b.txt': 'b\n' }, 'lane/a');
    const prA = gh.openPr({ repo: SLUG, head: 'lane/a', base: DEFAULT_BRANCH, title: 'A' });
    const prB = gh.openPr({ repo: SLUG, head: 'lane/b', base: 'lane/a', title: 'B (stacked on A)' });

    gh.mergePr(SLUG, prA, { deleteBranch: true });

    const viewB = gh.pr(SLUG, prB);
    expect(viewB.state).toBe('OPEN');
    expect(viewB.baseRefName).toBe(DEFAULT_BRANCH);
  });

  it('unit: applyBranchDeletionPure — the two GitHub-performed fates, without any git at all', () => {
    const closeCase = {
      deleteBranchOnMerge: false,
      prs: { 2: { number: 2, state: 'OPEN', baseRefName: 'lane/a', events: [] } },
    };
    const touchedClose = applyBranchDeletionPure(closeCase, 'lane/a', DEFAULT_BRANCH, { actor: 'bot', now: 1 });
    expect(touchedClose).toEqual([2]);
    expect(closeCase.prs[2].state).toBe('CLOSED');
    expect(closeCase.prs[2].events.at(-1).event).toBe('closed');

    const retargetCase = {
      deleteBranchOnMerge: true,
      prs: { 3: { number: 3, state: 'OPEN', baseRefName: 'lane/a', events: [] } },
    };
    applyBranchDeletionPure(retargetCase, 'lane/a', DEFAULT_BRANCH, { actor: 'bot', now: 1 });
    expect(retargetCase.prs[3].state).toBe('OPEN');
    expect(retargetCase.prs[3].baseRefName).toBe(DEFAULT_BRANCH);
    expect(retargetCase.prs[3].events.at(-1).event).toBe('base_ref_changed');
  });

  it('a 200-PR pr list whose JSON exceeds 64KB parses completely through execFileSync (the 8KB-pipe lesson)', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-big-list-');
    const gh = makeGithub(originPath);
    const bigBody = 'x'.repeat(500);
    for (let i = 0; i < 200; i += 1) {
      seedBranchAt(originPath, `lane/big-${i}`);
      gh.openPr({ repo: SLUG, head: `lane/big-${i}`, title: `PR ${i}`, body: bigBody });
    }

    const out = ghExec(gh, ['pr', 'list', '--repo', SLUG, '--state', 'open', '--limit', '200', '--json', 'number,title,body'], clonePath);
    expect(out.length).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(out); // throws "Unterminated string" if truncated — see this file's own header
    expect(parsed).toHaveLength(200);
    expect(new Set(parsed.map((p) => p.number)).size).toBe(200);
  }, 30_000);

  it('--jq pipes the result through the real jq', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-jq-');
    const gh = makeGithub(originPath);
    commitBranch(clonePath, 'lane/jq', { 'a.txt': 'hi\n' });
    gh.openPr({ repo: SLUG, head: 'lane/jq', title: 'jq target', labels: ['review:pending'] });

    const out = ghExec(gh, ['pr', 'list', '--repo', SLUG, '--json', 'number,title', '--jq', '.[0].title'], clonePath);
    expect(out.trim()).toBe('jq target');
  });

  it('a revoked GH_TOKEN gets a 401', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-401-');
    const gh = makeGithub(originPath);
    gh.revokeToken('stale-token-123');

    expect(() => execFileSync('gh', ['pr', 'list', '--repo', SLUG, '--json', 'number'], {
      cwd: clonePath, encoding: 'utf8', env: { ...process.env, ...gh.env, GH_TOKEN: 'stale-token-123' }, stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/401|Bad credentials/);

    // a DIFFERENT token still works
    expect(() => execFileSync('gh', ['pr', 'list', '--repo', SLUG, '--json', 'number'], {
      cwd: clonePath, encoding: 'utf8', env: { ...process.env, ...gh.env, GH_TOKEN: 'fresh-token' }, stdio: ['ignore', 'pipe', 'pipe'],
    })).not.toThrow();
  });

  it('an armed rate-limit fault fires exactly once, then clears', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-fault-');
    const gh = makeGithub(originPath);
    gh.fault({ verb: 'pr list', kind: 'rate-limit', times: 1 });

    expect(() => ghExec(gh, ['pr', 'list', '--repo', SLUG, '--json', 'number'], clonePath)).toThrow(/rate limit/i);
    // second call: fault consumed, succeeds
    expect(() => ghExec(gh, ['pr', 'list', '--repo', SLUG, '--json', 'number'], clonePath)).not.toThrow();
  });

  it('an unknown verb fails loudly as a fixture gap, never silently', () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-unknown-');
    const gh = makeGithub(originPath);
    try {
      ghExec(gh, ['issue', 'list', '--repo', SLUG], clonePath);
      expect.fail('expected the unknown verb to throw');
    } catch (err) {
      expect(String(err.stderr || err.message)).toMatch(/unsupported/);
    }
  });

  it('concurrency: 30 parallel `gh pr edit --add-label` processes on distinct PRs all land, no lost write', async () => {
    const { originPath, clonePath } = makeOrigin('fake-gh-concurrency-');
    const gh = makeGithub(originPath);
    const numbers = [];
    for (let i = 0; i < 30; i += 1) {
      seedBranchAt(originPath, `lane/c-${i}`);
      numbers.push(gh.openPr({ repo: SLUG, head: `lane/c-${i}`, title: `c${i}` }));
    }

    // Drain every child before teardown, including when one command fails early.
    const results = await Promise.allSettled(numbers.map((n) => ghExecAsync(gh, ['pr', 'edit', String(n), '--repo', SLUG, '--add-label', 'review:accepted'], clonePath)));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }

    const prs = gh.prs(SLUG);
    for (const n of numbers) {
      const pr = prs.find((p) => p.number === n);
      expect(pr.labels).toEqual([{ name: 'review:accepted' }]);
    }
  }, 30_000);

  it('keeps requirePr\'s error shape stable for the shim\'s error mapping (unit, no I/O)', () => {
    const repoState = { prs: {} };
    expect(() => requirePr(repoState, 99)).toThrow(/no pull requests found/);
  });
});
