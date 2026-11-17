/** @file accepted-conflict-rebase.test.mjs — admission and durable review hand-back guarantees. */
import { describe, it, expect, vi } from 'vitest';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { isAcceptedConflictRebase, planAcceptedConflictRebase, conflictRebaseReceipt } from '../accepted-conflict-rebase.mjs';
import { buildConflictRearmComment, buildConflictStartComment, countRearmComments } from '../rearm-review.mjs';
import { buildConflictFixMarkComment } from '../conflict-fix-mark.mjs';
import { planFixesFromReconcile, withPlannedContext } from '../reconcile-fix-dispatch.mjs';

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { fixDispatchResource } from '../fix-claim-store.mjs';
import { readLiveFixClaimStrict } from '../fix-procedure.mjs';
import { decideSetLabel, presentRemoveLabels, runReviewLabelCli } from '../../review-set-label.mjs';
import { countConflictFixComments } from '../conflict-fix-round-count.mjs';
import { enrichPrsWithFixClaims } from '../reconcile-pass.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40), earlier = 'c'.repeat(40);
const pr = (over = {}) => ({ number: 6911, state: 'OPEN', baseRefName: 'main', headRefOid: head,
  mergeStateStatus: 'DIRTY', labels: ['review:accepted'], comments: [], ...over });
const plan = (over = {}, opts = {}) => planAcceptedConflictRebase({ pr: pr(over), mainSha: target, cap: 3, ceiling: 9, ...opts });
const marker = (sha = target, actor = 'fixer') => ({ author: { login: AUTOMATION_LOGINS[0] },
  body: buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: sha }) });

describe('accepted conflict-rebase planner', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])('admits %s with no CI requirement', label => {
    expect(plan({ labels: [{ name: label }] })).toMatchObject({ kind: 'fix', isConflict: true, mode: 'conflict-rebase', attempts: 0 });
  });
  it.each(['review:changes', 'review:human', 'review:pending', 'review:pending-with-bounce',
    'review:held-mechanical', 'status:held', 'held', 'status:hold', 'hold'])('refuses approval combined with %s', label => {
    expect(plan({ labels: ['review:accepted', label] })).toBeNull();
  });
  it.each([{ labels: null }, { labels: ['review:accepted', {}] }, { isDraft: true },
    { baseRefName: 'lane/base' }, { baseRefName: null }, { state: 'CLOSED' }, { mergeStateStatus: 'UNKNOWN' }])('refuses ineligible evidence %j', over => {
    expect(isAcceptedConflictRebase(pr(over))).toBe(false);
    expect(plan(over)).toBeNull();
  });
  it.each([{ headRefOid: null }, { comments: null }])('fails closed for incomplete evidence %j', over => {
    expect(plan(over)).toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh') });
  });
  it('admits mergeable CONFLICTING without DIRTY through the shared predicate', () => {
    expect(plan({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }).kind).toBe('fix');
  });
  it('fails closed for an unreadable target', () => expect(plan({}, { mainSha: null }).kind).toBe('refuse'));
  it('refuses unknown claim evidence with a refresh fallback', () => {
    expect(plan({ fixClaimUnknown: true })).toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh the claim') });
  });
  it('uses strict claim reads for accepted conflicts and holds unreadable evidence', () => {
    const readClaim = vi.fn(() => null);
    const readClaimStrict = vi.fn(() => { throw new Error('corrupt claim'); });
    const [enriched] = enrichPrsWithFixClaims([pr()], { readClaim, readClaimStrict });
    expect(readClaim).not.toHaveBeenCalled();
    expect(readClaimStrict).toHaveBeenCalledWith({ repo: 'we', pr: 6911 });
    expect(enriched.fixClaimUnknown).toBe(true);
    expect(planAcceptedConflictRebase({ pr: enriched, mainSha: target, cap: 3, ceiling: 9 }).kind).toBe('refuse');
  });
  it('refuses live fixer claims and referral holds', () => {
    expect(plan({ fixClaim: { who: 'fixer' } }).kind).toBe('refuse');
    expect(plan({ referralHold: { why: 'ruling owed' } }).kind).toBe('refuse');
  });
  it.each([
    ['marker-only', actor => buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: target })],
    ['rearm-review', actor => buildConflictRearmComment({ actor, decision: { keepsHuman: false }, mainRef: 'main', mainSha: target })],
  ])('deduplicates %s receipts for a completed head after main advances and planner restarts', (_name, build) => {
    const first = plan();
    const comments = [{ author: { login: AUTOMATION_LOGINS[0] }, body: build(first.conflictRebase.receipt) }];
    expect(plan({ comments })).toMatchObject({ kind: 'refuse', why: expect.stringContaining('already completed for this head') });
    expect(plan({ comments, headRefOid: earlier }).kind).toBe('fix');
    expect(plan({ comments }, { mainSha: earlier }).kind).toBe('refuse');
    expect(plan({ comments: [{ ...comments[0], author: { login: 'untrusted' } }] }).kind).toBe('fix');
    expect(plan({ comments: [{ ...comments[0], body: build(first.conflictRebase.receipt + 'junk') }] }).kind).toBe('fix');
  });
  it('does not deduplicate a receipt quoted outside the rearm actor or under a different marker', () => {
    const actor = conflictRebaseReceipt(head, target);
    const real = buildConflictRearmComment({ actor: 'fixer', decision: { keepsHuman: false } });
    for (const body of [real + '\n' + actor, real.replace('fixer', actor + 'junk'),
      buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: target }).replace('repair completed', 'quoted repair completed')]) {
      expect(plan({ comments: [{ author: { login: AUTOMATION_LOGINS[0] }, body }] }).kind).toBe('fix');
    }
  });
  it('refuses both existing conflict budgets with an operator fallback', () => {
    for (const comments of [Array.from({ length: 3 }, () => marker()), Array.from({ length: 9 }, () => marker(earlier))]) {
      expect(plan({ comments })).toMatchObject({ kind: 'cap-exhausted', capKind: 'conflict-rebase', why: expect.stringContaining('person must take over') });
    }
  });
  it('carries mode and review receipt through itemless planning into the fix mandate', () => {
    const entry = { ...plan(), prNumber: 6911, headRefName: 'topic', headRefOid: head, files: ['scripts/example.mjs'] };
    const { planned, refusals } = planFixesFromReconcile([entry], () => null, () => []);
    expect(refusals).toEqual([]);
    expect(planned[0]).toMatchObject({ mode: 'conflict-rebase', conflictRebase: { receipt: conflictRebaseReceipt(head, target) } });
    expect(withPlannedContext('brief', planned[0])).toContain('ACCEPTED-CONFLICT-REBASE MODE');
  });
});


describe('conflict-rebase pre-repair demotion', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])(
    'sanctioned rearm removes %s and every merge clearance before repair', label => {
      const labels = [label, 'ready-to-merge', 'status:ready-to-merge'];
      const decision = decideSetLabel({ to: 'rearm', currentLabels: labels,
        requireLive: label === 'review:accepted' ? 'accepted' : 'missing' });
      expect(decision.allowed).toBe(true);
      expect(decision.addLabel).toBe('review:pending');
      const remaining = labels.filter(l => !presentRemoveLabels(decision.removeLabels, labels).includes(l));
      expect(remaining).toEqual([]);
    });
  it('brief states dispatcher demotion and preserves marker/report/fix-end hand-back', () => {
    const brief = readFileSync('skills-src/conveyor/fix-agent-brief.md', 'utf8')
      .split('> **ACCEPTED-CONFLICT-REBASE MODE')[1].split('> **STALE-BASE MODE')[0];
    expect(brief).toContain('already demoted this PR to `review:pending`');
    expect(brief).toContain('must not re-add review labels');
    expect(brief).not.toContain('--round=conflict-start');
    expect(brief.indexOf('conflict-fix-mark.mjs')).toBeLessThan(brief.indexOf('completion-cli.mjs'));
    expect(brief.indexOf('completion-cli.mjs')).toBeLessThan(brief.indexOf('fix-procedure.mjs'));
    expect(brief).not.toContain('--round=conflict ');
    const prompt = withPlannedContext('brief', { mode: 'conflict-rebase' });
    expect(prompt).toContain('already demoted this PR to review:pending');
    expect(prompt).toContain('must not re-add review labels');
    expect(prompt).not.toContain('--round=conflict-start');
  });
  it('admission receipt survives crashes and target movement without spending either round budget', () => {
    const comments = [{ author: { login: AUTOMATION_LOGINS[0] },
      body: buildConflictStartComment({ actor: conflictRebaseReceipt(head, target) }) }];
    expect(countConflictFixComments(comments)).toBe(0);
    expect(countRearmComments(comments)).toBe(0);
    const completed = [...comments, marker(target, conflictRebaseReceipt(earlier, target))];
    expect(countConflictFixComments(completed)).toBe(1);
    expect(countRearmComments(completed)).toBe(0);
    expect(plan({ comments }, { mainSha: earlier }).kind).toBe('refuse');
    expect(plan({ comments, headRefOid: earlier }).kind).toBe('fix');
  });
  it.each([
    ['missing head pin', []],
    ['mismatched receipt', [`--expect-head=${head}`, '--only-if=accepted', `--actor=${conflictRebaseReceipt(earlier, target)}`]],
    ['missing verdict guard', [`--expect-head=${head}`, `--actor=${conflictRebaseReceipt(head, target)}`]],
  ])('refuses conflict-start with %s before any forge IO', (_name, args) => {
    const result = spawnSync(process.execPath, ['scripts/conveyor/rearm-review.mjs', '6911',
      '--repo=o/n', '--round=conflict-start', ...args], { encoding: 'utf8', timeout: 10000,
      maxBuffer: 1024 * 1024, env: { ...process.env, GH_TOKEN: '', PATH: '' } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('conflict-start requires a pinned head');
    expect(result.stderr).not.toContain('ENOENT');
  });
});

describe('live incomplete fixer claims fail closed', () => {
  it.each([undefined, {}, { who: '' }, { who: '   ' }, { who: 42 }])(
    'production strict reader preserves live lock with incomplete metadata %j', meta => {
      const root = mkdtempSync(join(tmpdir(), 'accepted-incomplete-claim-'));
      try {
        const dir = lockDirFor(root, fixDispatchResource({ repo: 'we', pr: 6911, kind: 'fixing' }));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'lock.json'), JSON.stringify({ owner: 'fixer:live',
          heartbeatAt: new Date().toISOString(), meta }));
        const readClaimStrict = args => readLiveFixClaimStrict({ ...args, lockRoot: root });
        expect(readClaimStrict({ repo: 'we', pr: 6911 })).not.toBeNull();
        const [enriched] = enrichPrsWithFixClaims([pr()], { readClaimStrict });
        expect(enriched.fixClaimUnknown).toBe(true);
        expect(planAcceptedConflictRebase({ pr: enriched, mainSha: target, cap: 3, ceiling: 9 }))
          .toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh the claim') });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
});


it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])(
  'shared label IO verifies %s demotion before repair is permitted', label => {
    let labels = [...new Set([label, 'ready-to-merge', 'status:ready-to-merge'])];
    const events = [], comments = [], output = [];
    const readLabels = () => {
      if (events.includes('demote')) events.push('verify-demotion');
      return [...labels];
    };
    const provider = {
      readPrState: () => ({ state: 'OPEN', isDraft: false, headRefOid: head,
        headRefName: 'lane/test', baseRefName: 'main', comments, labels: readLabels() }),
      readLabels,
      setLabels: (_repo, _pr, spec) => {
        labels = [...labels.filter(l => !spec.remove.includes(l)), spec.add];
        events.push('demote');
      },
      postComment: (_repo, _pr, body) => { comments.push({ author: { login: AUTOMATION_LOGINS[0] }, body }); events.push('receipt'); },
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    try {
      expect(() => runReviewLabelCli({ argv: ['6911', '--repo=o/n', `--expect-head=${head}`,
        `--only-if=${label === 'review:accepted' ? 'accepted' : 'missing'}`,
        `--actor=${conflictRebaseReceipt(head, target)}`], fixedTo: 'rearm', defaultActor: 'fixer',
        usage: 'test rearm', provider, buildComment: buildConflictStartComment,
        successResult: ({ labels }) => ({ ok: true, labels }), refusalResult: ({ decision }) => ({ ok: false, reason: decision.reason }),
        emit: line => output.push(JSON.parse(line)),
      })).toThrow('exit:0');
      expect(output).toEqual([{ ok: true, labels: ['review:pending'] }]);
      expect(events).toContain('demote');
      expect(events).toContain('receipt');
      expect(events.at(-1)).toBe('verify-demotion');
      events.push('repair');
      expect(events.indexOf('demote')).toBeLessThan(events.indexOf('repair'));
      expect(events.indexOf('receipt')).toBeLessThan(events.indexOf('repair'));
      expect(events.indexOf('demote')).toBeLessThan(events.indexOf('verify-demotion'));
      expect(labels).toEqual(['review:pending']);
      expect(plan({ comments }).kind).toBe('refuse');
      expect(countConflictFixComments(comments)).toBe(0);
    } finally { exit.mockRestore(); }
  });
