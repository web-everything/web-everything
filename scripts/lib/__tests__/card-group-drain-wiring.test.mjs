// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPrPageFixture } from '../../__tests__/fixtures/open-pr-page-fixture.mjs';
import { cardGroupHold } from '../card-group.mjs';

const script = fileURLToPath(new URL('../../merge-ai-prs.mjs', import.meta.url));
const sha = 'a'.repeat(40), slug = 'web-everything/web-everything';
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
const pr = JSON.parse(fs.readFileSync(process.env.GROUP_PR, 'utf8'));
fs.appendFileSync(process.env.GROUP_LOG, JSON.stringify(['gh', ...a]) + '\\n');
const out = x => { fs.writeSync(1, typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
const page = ${openPrPageFixture};
if (a[0] === 'repo') out('main');
if (a[0] === 'pr' && a[1] === 'list') out(a.includes('--base') ? [] : [pr]);
if (a[0] === 'pr' && a[1] === 'view') {
  const row = a[2] === '77' && process.env.GROUP_COMBINED_STATE ? { ...pr, number: 77, state: process.env.GROUP_COMBINED_STATE } : { ...pr };
  if (!(a[a.indexOf('--json') + 1] || '').split(',').includes('mergeStateStatus')) delete row.mergeStateStatus;
  out(row);
}
if (a[0] === 'pr' && a[1] === 'close' && process.env.GROUP_CLOSE_FAIL === '1') process.exit(1);
if (a[0] === 'api') {
  if (a[1] === 'user') out('chalbert');
  const path = a.find(x => x.startsWith('repos/')) || '';
  if (path.includes('/rules/branches/')) out(a.includes('--slurp') ? [[{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]] : [{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]);
  if (path.includes('/comments')) out([pr.comments]);
  if (path.includes('/reviews')) out([[]]);
  if (path.includes('/files')) out([[{filename:'README.md',status:'modified'}]]);
  if (path.endsWith('/branches/main')) out({protected:false});
  if (a[1] === 'graphql') {
    const q = a.find(x => x.startsWith('query=')) || '';
    if (q.includes('enqueuePullRequest')) {
      fs.writeFileSync(process.env.GROUP_PR + '.queued', '');
      out({data:{enqueuePullRequest:{mergeQueueEntry:{id:'ENTRY',position:1,state:'QUEUED'}}}});
    }
    if (q.includes('mergeQueue(')) out({data:{repository:{mergeQueue:{entries:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
    if (q.includes('isInMergeQueue')) out({data:{repository:{pullRequest:{headRefOid:pr.headRefOid,isInMergeQueue:fs.existsSync(process.env.GROUP_PR + '.queued')}}}});
    out(page([pr], q));
  }
}
out([]);
`;
const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
fs.appendFileSync(process.env.GROUP_LOG, JSON.stringify(['git', ...a]) + '\\n');
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:${slug}.git\\n');
else if (['rev-parse','merge-base'].includes(a[0])) process.stdout.write('${sha}\\n');
else if (a[0] === 'diff') {
  if (a.includes('--name-only')) process.stdout.write('README.md\\0');
  else if (a.includes('--numstat')) process.stdout.write('1\\t0\\tREADME.md\\n');
  else process.stdout.write('diff --git a/README.md b/README.md\\n--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-old\\n+new\\n');
} else if (a[0] === 'show') process.exit(1);
// Repair entry is observable even if plumbing refuses: never mint or push fixture commits.
else if (a[0] === 'merge-tree') { process.stderr.write('fixture stops repair here'); process.exit(1); }
`;

function world(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'card-group-drain-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin); mkdirSync(join(dir, 'backlog'));
    for (const [name, body] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), body, { mode: 0o755 });
    const statePath = join(dir, 'groups.json'), fixture = join(dir, 'pr.json'), log = join(dir, 'calls.jsonl'), settings = join(dir, 'settings.json');
    const pr = { number: 42, id: 'PR_NODE', title: 'Update readme', body: 'Update readme.', state: 'OPEN', isDraft: false,
      headRefOid: sha, headRefName: 'lane/readme', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }], files: [{ path: 'README.md', changeType: 'MODIFIED' }],
      commits: [{ oid: sha, messageHeadline: 'Update readme', authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: sha }],
      comments: [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${sha} -->`, createdAt: new Date().toISOString() }], reviews: [] };
    const run = ({ role = 'source', grouped = true, only = true, queue = true, heal = false, rebase = false, unreadable = false, combinedState = '', preserveGroup = false, closeFail = false } = {}) => {
      const group = { id: 'fixture', repo: slug, pr: role === 'combined' ? 42 : 77,
        branch: role === 'combined' ? pr.headRefName : 'lane/card-group-fixture', createdAt: Date.now(),
        sources: [{ num: role === 'source' ? 42 : 99, headSha: sha }], files: ['backlog/xfixture.md'] };
      // Preserve the queue-created record across a strategy switch; simulate the next due reconcile tick.
      const state = preserveGroup ? JSON.parse(readFileSync(statePath, 'utf8')) : { groups: grouped ? [group] : [], failed: {} };
      writeFileSync(statePath, unreadable ? '{broken' : JSON.stringify({ ...state, lastReconcileAt: 0 }));
      rmSync(fixture + '.queued', { force: true });
      writeFileSync(fixture, JSON.stringify(pr)); writeFileSync(log, '');
      writeFileSync(settings, JSON.stringify({ mergeDelivery: { strategy: queue ? 'github-merge-queue' : 'drain-direct' } }));
      const result = spawnSync(process.execPath, [script, '--this-repo', '--label=ready-to-merge', '--json',
        ...(only ? ['--only=42'] : []), '--no-drain-lease', '--no-red-main-freeze', '--no-overlap-yield',
        ...(!heal ? ['--no-heal-collision'] : []), ...(!rebase ? ['--no-rebase-drop'] : [])], {
        cwd: dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GROUP_PR: fixture, GROUP_LOG: log, GROUP_COMBINED_STATE: combinedState, GROUP_CLOSE_FAIL: closeFail ? '1' : '0',
          // This world supplies its own gh, with no App credentials or token-cache dependency.
          // Pin both auth setup and throttle routing so an inherited host shim cannot replace it.
          WE_GITHUB_AUTH: 'personal', WE_GH_THROTTLE_GH_BIN: join(bin, 'gh'),
          WE_GH_THROTTLE_LOCK_ROOT: mkdtempSync(join(dir, 'throttle-')),
          WE_DRAIN_CARD_GROUP_STATE: statePath, WE_DRAIN_GROUP_ENABLED: 'on', WE_COORDINATION_ROOT: join(dir, 'coord'),
          LANE_POOL_ROOT: dir, WE_MERGE_DELIVERY_SETTINGS_FILE: settings, WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'off',
          WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: 'off', WE_DRAIN_WORKFLOW_EDIT_HUMAN: 'off', WE_REVIEW_LEDGER_MODE: 'off',
          WE_MQ_REFRESH_EVIDENCE_ONLY_CONFLICTS: 'off', WE_MQ_REFRESH_WHEN_MAIN_ACCEPTS_DRAIN_NUMBERS: 'off',
          WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: 'off',
          WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '0', WE_VERDICT_LEDGER_DIR: join(dir, 'ledger'), WE_VERDICT_LEDGER_STORE: 'home' },
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      return { report: JSON.parse(result.stdout), stderr: result.stderr,
        calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
        state: unreadable ? null : JSON.parse(readFileSync(statePath, 'utf8')) };
    };
    return fn({ pr, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const collisionCalls = calls => calls.filter(a => JSON.stringify(a)
  === JSON.stringify(['git', 'ls-tree', '-r', '--name-only', 'origin/lane/readme', '--', 'backlog/']));
const rebaseCalls = calls => calls.filter(a => JSON.stringify(a)
  === JSON.stringify(['git', 'merge-tree', '--write-tree', 'origin/main', 'origin/lane/readme']));

describe('real drain card-group orchestration', () => {
  it.each([true, false])('cascade holds an otherwise mergeable source as card-grouped (queue=%s)', queue => world(({ run }) => {
    const r = run({ queue });
    expect(r.report.enqueueOutcomes).toContainEqual(expect.objectContaining({ num: 42, kind: 'card-grouped', outcome: 'not-enqueued' }));
    expect(r.calls.some(a => a.some(x => x.includes('enqueuePullRequest')) || a[0] === 'gh' && a[1] === 'pr' && a[2] === 'merge')).toBe(false);
  }));

  it.each(['source', 'combined'])('group members skip collision repair and ordinary rebase (%s)', role => world(({ pr, run }) => {
    pr.statusCheckRollup[0].conclusion = 'FAILURE';
    const collision = run({ role, heal: true });
    expect(collisionCalls(collision.calls)).toEqual([]);
    const unheldCollision = run({ role, heal: true, grouped: false });
    expect(collisionCalls(unheldCollision.calls).length).toBeGreaterThan(0);
    pr.statusCheckRollup[0].conclusion = 'SUCCESS'; pr.mergeable = 'CONFLICTING'; pr.mergeStateStatus = 'DIRTY';
    expect(rebaseCalls(run({ role, rebase: true }).calls)).toEqual([]);
    expect(rebaseCalls(run({ role, rebase: true, grouped: false }).calls).length).toBeGreaterThan(0);
  }));

  it.each(['source', 'combined'])('group members still undergo manifest stripping (%s)', role => world(({ pr, run }) => {
    pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({ item: 'xabc123',
      repos: [{ repo: 'we', ref: pr.headRefName }], blockedBy: [], stackParents: [] }) + '\n```\n<!-- lane-manifest:end -->';
    expect(rebaseCalls(run({ role, rebase: true }).calls)).toHaveLength(1);
  }));

  it('reconciles and attempts formation only on a whole merge-queue pass', () => world(({ run }) => {
    expect(run({ only: true }).state.lastReconcileAt).toBe(0);
    const full = run({ only: false });
    // The reconcile stamp is per repository, so another repo's drain never throttles this one.
    expect(full.state.lastReconcileAt[slug]).toBeGreaterThan(0);
    // A non-card outcome reaches form(), which rejects it without a group or mutation.
    expect(full.state.groups).toHaveLength(1);
    // Reconcile runs under direct merging too (a group formed under the queue must still release its holds).
    expect(run({ only: false, queue: false }).state.lastReconcileAt[slug]).toBeGreaterThan(0);
    // Malformed state makes form() return a visible reason, even with zero eligible outcomes.
    expect(run({ only: false, unreadable: true }).stderr).toContain('card-group: no group this pass — state unreadable');
    expect(run({ only: true, unreadable: true }).stderr).not.toContain('card-group: no group this pass');
    expect(run({ only: false, queue: false, unreadable: true }).stderr).not.toContain('card-group: no group this pass');
  }));

  it('after a switch to direct merging, a closed combined PR is dissolved and its source released', () => world(({ run }) => {
    const r = run({ only: false, queue: false, combinedState: 'CLOSED' });
    expect(r.state.groups).toEqual([]);
    expect(r.calls.some(a => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'close' && a[3] === '77')).toBe(false); // already closed
    expect(r.calls.some(a => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'comment' && a[3] === '42')).toBe(true);
  }));

  it.each([true, false].flatMap(queue => ['source', 'combined'].flatMap(role =>
    ['BEHIND', 'DIRTY'].map(mergeState => ({ queue, role, mergeState }))))
  )('stale group freshness has an owner (queue=$queue, role=$role, state=$mergeState)', ({ queue, role, mergeState }) => world(({ pr, run }) => {
    // A persisted group belongs to the queue initially. Keep that exact record when switching strategies.
    const initial = run({ role, queue: true });
    const sourceNum = initial.state.groups[0].sources[0].num;
    const combinedNum = initial.state.groups[0].pr;
    expect(cardGroupHold(initial.state, { num: sourceNum, localSlug: slug })?.kind).toBe('card-grouped');
    // Main advances: BEHIND remains MERGEABLE, whereas DIRTY has a content conflict.
    pr.mergeStateStatus = mergeState;
    pr.mergeable = mergeState === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE';
    const r = run({ role, queue, only: false, rebase: true, preserveGroup: true });
    expect(rebaseCalls(r.calls)).toEqual([]); // sources keep their reviewed heads until reconciliation
    const queueOwnsFreshness = queue && mergeState === 'BEHIND';
    expect(r.state.groups).toHaveLength(queueOwnsFreshness ? 1 : 0);
    const hold = cardGroupHold(r.state, { num: sourceNum, localSlug: slug });
    const reservation = cardGroupHold(r.state, { num: 123, localSlug: slug, files: ['backlog/xfixture.md'] });
    if (queueOwnsFreshness) {
      expect(hold?.kind).toBe('card-grouped');
      expect(reservation?.kind).toBe('card-grouped');
    } else {
      expect(hold).toBeNull();
      expect(reservation).toBeNull();
      expect(r.calls.some(a => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'close' && a[3] === String(combinedNum))).toBe(true);
      expect(r.calls.some(a => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'comment' && a[3] === String(sourceNum))).toBe(true);
    }
  }));

  it('a failed close after switching to direct keeps holds until the next successful reconcile', () => world(({ pr, run }) => {
    run({ queue: true });
    pr.mergeStateStatus = 'BEHIND';
    const failed = run({ queue: false, only: false, preserveGroup: true, closeFail: true });
    expect(failed.stderr).toContain('closing combined PR failed');
    expect(cardGroupHold(failed.state, { num: 42, localSlug: slug })?.kind).toBe('card-grouped');
    const retried = run({ queue: false, only: false, preserveGroup: true });
    expect(retried.state.groups).toEqual([]);
    expect(cardGroupHold(retried.state, { num: 42, localSlug: slug })).toBeNull();
  }));
});
