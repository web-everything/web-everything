// A mechanical round (conflict-resolution merge, no other edits) never spends a review round (live: #4631 f0f4943fb,
// refused cap-exhausted 6/5 after a mechanical conflict round).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mechanicalRoundGrant, resolveMechanicalRoundsSetting, isReviewVerdictComment, isMechanicalBounce,
  MECHANICAL_BOUNCE_PHRASE, readMechanicalRoundFacts, hasPendingMechanicalRound,
} from '../mechanical-round-cap.mjs';
import { RECONCILE_FINDING_BANNER } from '../reconcile-finding.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { takeoverMarkerBody } from '../fix-takeover.mjs';
import { takeoverReviewGrant } from '../takeover-review.mjs';
import { planReconcile } from '../reconcile-core.mjs';

const BOT = { login: 'web-everything' };
const PRIOR = 'a'.repeat(40);  // the head the mechanical round merged main into
const HEAD = 'b'.repeat(40);   // the mechanical round's merge commit
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;

const rearm = (h) => ({ author: BOT, createdAt: at(h), body: `${REARM_COMMENT_MARKER}\n\nrepaired` });
const bounceOn = (head, h) => ({ author: BOT, createdAt: at(h),
  body: `🔁 review — changes requested\n\n### Findings\n- bad\n\nNet basis: \`${'0'.repeat(40)}..${head}\`` });
const acceptOn = (head, h) => ({ author: BOT, createdAt: at(h), body: `✅ review — accepted\n\n<!-- reviewed-sha: ${head} -->` });
const conflictBounce = (h) => ({ author: { login: 'chalbert' }, createdAt: at(h),
  body: `🔁 review — changes requested\n\nRecorded by parked-pr-conflict-watch\n\n${RECONCILE_FINDING_BANNER}\n\nPR #7 has drifted into a real GIT merge conflict.` });
const mechMarker = (h) => ({ author: BOT, createdAt: at(h), body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nA mechanical conflict-resolution round (no other edits)` });

const facts = (over = {}) => ({ head: HEAD, priorHead: PRIOR, merged: 'c'.repeat(40), netDiffIdentical: false,
  changedFiles: ['src/a.mjs'], proven: true, ...over });
function pr(comments, { head = HEAD, mechanicalRound = facts(), labels = ['review:pending'] } = {}) {
  return {
    number: 7, headRefName: 'lane/x-thing', headRefOid: head, baseRefName: 'main', isDraft: false, createdAt: at(0),
    labels: labels.map((name) => ({ name })), files: [{ path: 'src/a.mjs' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }],
    comments, ...(mechanicalRound ? { mechanicalRound } : {}),
  };
}
// Rounds spent (5/5), then the final review bounced PRIOR, then a mechanical round made HEAD.
const spent = [rearm(1), rearm(2), rearm(3), rearm(4), rearm(5), bounceOn(PRIOR, 6)];
const plan = (p, opts = {}) => planReconcile({ prs: [p], agents: [], durableCounts: {}, now: Date.parse(at(12)),
  requiredChecks: ['test'], takeoverReviewAttempts: 1, ...opts });
const row = (p) => p.dispatch.find((x) => x.prNumber === 7);
const refusal = (p) => p.refusals.find((x) => x.prNumber === 7 && x.kind !== 'no-findings');

describe('review.mechanicalRoundsCountTowardCap cascade', () => {
  const none = () => null;
  it('standard default false, then platform, then repo override, then env — each with its source', () => {
    expect(resolveMechanicalRoundsSetting({ env: {}, readPlatform: none, readRepo: none })).toEqual({ value: false, source: 'standard' });
    expect(resolveMechanicalRoundsSetting({ env: {}, readPlatform: () => ({ review: { mechanicalRoundsCountTowardCap: true } }), readRepo: none }))
      .toEqual({ value: true, source: 'platform' });
    expect(resolveMechanicalRoundsSetting({ env: {}, readPlatform: () => ({ review: { mechanicalRoundsCountTowardCap: true } }),
      readRepo: () => ({ mechanicalRoundsCountTowardCap: false }) })).toEqual({ value: false, source: 'repo' });
    expect(resolveMechanicalRoundsSetting({ env: { WE_REVIEW_MECHANICAL_ROUNDS_COUNT_TOWARD_CAP: 'true' }, readPlatform: none,
      readRepo: () => ({ mechanicalRoundsCountTowardCap: false }) })).toEqual({ value: true, source: 'env' });
    expect(resolveMechanicalRoundsSetting({ env: { WE_REVIEW_MECHANICAL_ROUNDS_COUNT_TOWARD_CAP: 'yes' }, readPlatform: none,
      readRepo: () => ({ mechanicalRoundsCountTowardCap: 'x' }) })).toEqual({ value: false, source: 'standard' });
  });
});

describe('a conflict-watch bounce is not a review verdict', () => {
  it('the phrase is pinned to the reconcile-finding banner, and the bounce spends nothing', () => {
    expect(RECONCILE_FINDING_BANNER).toContain(MECHANICAL_BOUNCE_PHRASE);
    expect(isMechanicalBounce(conflictBounce(7))).toBe(true);
    expect(isReviewVerdictComment(conflictBounce(7))).toBe(false);
    expect(isReviewVerdictComment(bounceOn(PRIOR, 6))).toBe(true);
  });
  it('#4631 shape: a takeover head bounced for a conflict, then a mechanical round, still has its takeover review', () => {
    const takeover = { author: BOT, createdAt: at(7), body: takeoverMarkerBody({ pr: 7, head: PRIOR, attempts: 5, cap: 5, rung: { id: 'x' } }) };
    const comments = [...spent, takeover, rearm(8), conflictBounce(9), mechMarker(10)];
    expect(takeoverReviewGrant({ pr: pr(comments), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0 });
    const p = plan(pr(comments, { mechanicalRound: facts({ priorHead: 'd'.repeat(40) }) }));
    // Since the takeover is a round beyond the cap (reviewCap = roundCap + started takeovers, card xx0055i), 6 attempts
    // against a cap of 5 + 1 takeover is a plain owed review, not a cap-exhausted refusal that needs the grant.
    expect(row(p)).toMatchObject({ kind: 'review' });
    expect(refusal(p)).toBeUndefined();
  });
});

describe('mechanical round vs the review round cap', () => {
  it('a mechanical round does not increment the round count (false); it does when the setting is true', () => {
    const comments = [rearm(1), rearm(2), bounceOn(PRIOR, 3), mechMarker(4)];
    expect(row(plan(pr(comments)))).toMatchObject({ kind: 'review', attempts: 2 });
    expect(row(plan(pr(comments), { mechanicalRoundsCountTowardCap: true }))).toMatchObject({ kind: 'review', attempts: 3 });
  });
  it('identical net diff carries the prior verdict forward: an accept is carried, no review, no person note', () => {
    const p = plan(pr([...spent.slice(0, 5), acceptOn(PRIOR, 6), rearm(7), mechMarker(8)], { mechanicalRound: facts({ netDiffIdentical: true }) }));
    expect(row(p)).toBeUndefined();
    expect(refusal(p)).toMatchObject({ kind: 'mechanical-carry-forward', mechanicalRound: { action: 'carry', verdict: 'accept' } });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
  });
  it('identical net diff after a changes verdict carries the bounce: still capped, no review', () => {
    const p = plan(pr([...spent, rearm(7), mechMarker(8)], { mechanicalRound: facts({ netDiffIdentical: true }) }));
    expect(row(p)).toBeUndefined();
    expect(refusal(p)).toMatchObject({ kind: 'cap-exhausted', mechanicalRound: { action: 'carry', verdict: 'changes' } });
  });
  it('net diff changed in the conflict hunks gets exactly one review past the cap for that head', () => {
    const comments = [...spent, rearm(7), mechMarker(8)];
    expect(row(plan(pr(comments)))).toMatchObject({ kind: 'review', mechanicalRound: { action: 'review', allowance: 1 } });
    // once a verdict names this head, it is capped again
    const after = plan(pr([...comments, bounceOn(HEAD, 9)]));
    expect(row(after)).toBeUndefined();
    expect(refusal(after)?.kind).toBe('cap-exhausted');
    expect(mechanicalRoundGrant({ pr: pr([...comments, bounceOn(HEAD, 9)]) })).toMatchObject({ ok: false, reason: 'head-already-reviewed' });
  });
  it('a non-mechanical round is still capped: unproven by git, no marker, setting true, or forged marker', () => {
    const comments = [...spent, rearm(7), mechMarker(8)];
    const capped = (p) => { expect(row(p)).toBeUndefined(); expect(refusal(p)?.kind).toBe('cap-exhausted'); };
    capped(plan(pr(comments, { mechanicalRound: facts({ proven: false, reason: 'edits-outside-conflict-files' }) })));
    capped(plan(pr([...spent, rearm(7)])));
    capped(plan(pr(comments), { mechanicalRoundsCountTowardCap: true }));
    capped(plan(pr([...spent, rearm(7), { ...mechMarker(8), author: { login: 'mallory' } }])));
    capped(plan(pr(comments, { mechanicalRound: facts({ head: 'e'.repeat(40) }) })));
  });
  describe('the parent head counts as reviewed only by a structured sha, never by prose', () => {
    const OTHER = 'd'.repeat(40);
    const identical = facts({ netDiffIdentical: true });
    const grant = (verdict) => mechanicalRoundGrant({ pr: pr([rearm(5), verdict, rearm(7), mechMarker(8)], { mechanicalRound: identical }) });
    it('a verdict whose reviewed-sha marker names another commit but mentions the parent in prose is not a verdict on the parent', () => {
      const v = { author: BOT, createdAt: at(6), body: `✅ review — accepted\n\nCompared against earlier commit ${PRIOR}.\n\n<!-- reviewed-sha: ${OTHER} -->` };
      expect(grant(v)).toMatchObject({ ok: false, reason: 'prior-head-unreviewed' });
    });
    it('a bounce whose Net basis head is another commit but mentions the parent in prose is not a verdict on the parent', () => {
      const v = { author: BOT, createdAt: at(6),
        body: `🔁 review — changes requested\n\nSee also ${PRIOR}.\n\nNet basis: \`${'0'.repeat(40)}..${OTHER}\`` };
      expect(grant(v)).toMatchObject({ ok: false, reason: 'prior-head-unreviewed' });
    });
    it('a bare sha in prose with no structured marker at all is not a verdict on the parent', () => {
      const v = { author: BOT, createdAt: at(6), body: `🔁 review — changes requested\n\nrebased from ${PRIOR}` };
      expect(grant(v)).toMatchObject({ ok: false, reason: 'prior-head-unreviewed' });
    });
    it('a structured marker naming the parent (full or abbreviated, any case) still counts', () => {
      expect(grant(acceptOn(PRIOR, 6))).toMatchObject({ ok: true, action: 'carry', verdict: 'accept' });
      expect(grant(acceptOn(PRIOR.slice(0, 12).toUpperCase(), 6))).toMatchObject({ ok: true, action: 'carry', verdict: 'accept' });
      expect(grant(bounceOn(PRIOR, 6))).toMatchObject({ ok: true, action: 'carry', verdict: 'changes' });
    });
  });
  it('red CI still refuses the mechanical review (the review gate is not weakened)', () => {
    const p0 = pr([...spent, rearm(7), mechMarker(8)]);
    const p = plan({ ...p0, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headSha: HEAD }] });
    expect(p.dispatch.find((x) => x.prNumber === 7 && x.kind === 'review')).toBeUndefined();
  });
  it('the IO pre-filter reads git only when a mechanical round is the latest event after the latest verdict', () => {
    expect(hasPendingMechanicalRound(pr([...spent, mechMarker(8)]))).toBe(true);
    expect(hasPendingMechanicalRound(pr([...spent, mechMarker(8), bounceOn(HEAD, 9)]))).toBe(false);
    expect(hasPendingMechanicalRound(pr([...spent, conflictBounce(7)]))).toBe(false);
  });
});

describe('readMechanicalRoundFacts (real git)', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'mech-round-'));
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    g('remote', 'add', 'origin', dir);
    const write = (f, t) => writeFileSync(join(dir, f), t);
    write('a.txt', '1\n2\n3\n'); write('b.txt', 'b\n'); g('add', '.'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'lane/x'); write('a.txt', '1\n2-pr\n3\n'); write('c.txt', 'pr\n'); g('add', '.'); g('commit', '-qm', 'pr');
    g('checkout', '-q', 'main'); write('a.txt', '1\n2-main\n3\n'); g('add', '.'); g('commit', '-qm', 'main moves');
    g('checkout', '-q', 'lane/x');
    try { g('merge', '-q', 'main', '-m', 'merge main'); } catch { /* conflict expected */ }
    write('a.txt', '1\n2-main-and-pr\n3\n'); g('add', 'a.txt'); g('commit', '-qm', 'merge main (resolved)', '--no-edit');
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    return { dir, g, write, exec };
  }
  it('a conflict-resolution merge is proven mechanical; changed files are only the conflicted ones', () => {
    const r = repo();
    try {
      const f = readMechanicalRoundFacts({ pr: { headRefOid: r.g('rev-parse', 'HEAD'), headRefName: 'lane/x', baseRefName: 'main' }, exec: r.exec });
      expect(f).toMatchObject({ proven: true, netDiffIdentical: false, changedFiles: ['a.txt'], priorHead: r.g('rev-parse', 'HEAD^1') });
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('an extra edit outside the files main changed is not mechanical', () => {
    const r = repo();
    try {
      r.write('c.txt', 'pr + sneaky\n'); r.g('add', 'c.txt'); r.g('commit', '-q', '--amend', '--no-edit');
      const f = readMechanicalRoundFacts({ pr: { headRefOid: r.g('rev-parse', 'HEAD'), headRefName: 'lane/x', baseRefName: 'main' }, exec: r.exec });
      expect(f).toMatchObject({ proven: false, reason: 'edits-outside-conflict-files', outside: ['c.txt'] });
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('a non-merge head is not mechanical', () => {
    const r = repo();
    try {
      r.write('c.txt', 'more\n'); r.g('add', 'c.txt'); r.g('commit', '-qm', 'more');
      expect(readMechanicalRoundFacts({ pr: { headRefOid: r.g('rev-parse', 'HEAD'), headRefName: 'lane/x', baseRefName: 'main' }, exec: r.exec }))
        .toMatchObject({ proven: false, reason: 'not-a-merge' });
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
});
