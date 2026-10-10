/**
 * Card xu7kxtt (#5472, ruling P4) — replay fixtures for the accept carry-forward rule and its two consumers:
 * the restamp decision (review-set-label) and the review daemon's carry sweep. Live case: PR #4535, 2026-10-09.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  decideAcceptCarryForward, latestAcceptRecord, resolveAcceptCarryForward, ACCEPT_CARRY_FORWARD_SETTINGS_FILE, decideMechanicalHold,
} from '../accept-carry-forward.mjs';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment } from '../../review-set-label.mjs';
import { parseLatestHumanClearedSha, parseOperatorClearance } from '../review-escalation.mjs';
import { readDrainAcceptance } from '../../merge-ai-prs.mjs';
import { acceptanceCoversHead } from '../review-escalation.mjs';
import {
  planAcceptCarry, sweepAcceptCarry, _resetAcceptCarryMemo, defaultRunRestamp, defaultCloneDirFor,
  transientBackoffMs, TRANSIENT_BACKOFF_BASE_MS, TRANSIENT_BACKOFF_MAX_MS,
} from '../../conveyor/accept-carry-sweep.mjs';

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/accept-carry-forward-4535.json'), 'utf8'));
const OTHER_FP = 'a'.repeat(64);
const OLD = fx.acceptedHead;
const NEW = fx.newHead;

describe('#4535 replay — merge-queue refresh fcc29ce1 → 143107a87, net diff unchanged', () => {
  const record = latestAcceptRecord(fx.comments);

  it('reads the operator clear-human record at the accepted head with its strict reviewed-diff', () => {
    expect(record).toMatchObject({ sha: OLD, diff: fx.netDiff[OLD], humanCleared: true, actor: 'chalbert', laterBodyDerivedHold: false });
  });

  it('the net diff is byte-identical on both heads (the fixture is the real measurement)', () => {
    expect(fx.netDiff[NEW]).toBe(fx.netDiff[OLD]);
  });

  it('carries the clearance to the new head, recorded with both SHAs', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(v).toMatchObject({ action: 'carry', from: OLD, to: NEW, human: true });
  });

  it('off = today: nothing carried', () => {
    expect(decideAcceptCarryForward({ setting: 'off', record, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('off');
  });

  it('restamp crosses the review:human re-hold only with that proof, and drops the hold + advisory labels', () => {
    const humanCarry = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    const d = decideSetLabel({ to: 'restamp', currentLabels: fx.labelsAfterRepark, humanCarry });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe('review:accepted');
    expect(d.removeLabels).toEqual(expect.arrayContaining(['review:human', 'advisory:accepted', 'review:awaiting-advisory']));
    expect(d.keepsHuman).toBe(false);
  });

  it('the review daemon sweep plans #4535 and hands it to the sanctioned re-stamp once per head', () => {
    _resetAcceptCarryMemo();
    const prs = [{ number: 4535, labels: fx.labelsAfterRepark.map((name) => ({ name })), headRefOid: NEW, comments: fx.comments }];
    expect(planAcceptCarry(prs, { setting: 'on' })).toEqual([{ num: 4535, head: NEW, from: OLD }]);
    const calls = [];
    const runRestamp = (c) => { calls.push(c); return { ok: true, detail: 'ok' }; };
    expect(sweepAcceptCarry({ prs, repo: fx.repo, setting: 'on', runRestamp })).toEqual([{ num: 4535, carry: 'carried', detail: 'ok' }]);
    expect(sweepAcceptCarry({ prs, repo: fx.repo, setting: 'on', runRestamp })).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('guards — anything but a proven-identical net diff falls back to today', () => {
  const record = latestAcceptRecord(fx.comments);
  beforeEach(() => _resetAcceptCarryMemo());

  it('a changed net diff (conflict resolution, new commit) owes a review; for a human clearance it goes back to the operator', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: OTHER_FP });
    expect(v.action).toBe('review-owed');
    expect(v.reason).toMatch(/goes back to the operator/);
    const d = decideSetLabel({ to: 'restamp', currentLabels: fx.labelsAfterRepark, humanCarry: v });
    expect(d.allowed).toBe(false);
  });

  it('an unreadable live diff is not proof', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: null }).action).toBe('review-owed');
  });

  it('an unreadable live diff is a RETRYABLE read miss even when the accept also carries no fingerprint (the #217 shape)', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: null }))
      .toMatchObject({ action: 'review-owed', retryable: true });
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: fx.netDiff[NEW] }).retryable).toBeUndefined();
  });

  it('an accept with no reviewed-diff marker is not proof', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('review-owed');
  });

  it('a later body-derived hold (manifest tamper) is never carried past', () => {
    const comments = [...fx.comments, { author: { login: 'chalbert' }, body: '<!-- drain-skip-reason --> manifest baseline mismatch — post-review tamper suspected' }];
    const rec = latestAcceptRecord(comments);
    expect(rec.laterBodyDerivedHold).toBe(true);
    expect(decideAcceptCarryForward({ setting: 'on', record: rec, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('none');
    expect(planAcceptCarry([{ number: 1, labels: ['review:human'], headRefOid: NEW, comments }], { setting: 'on' })).toEqual([]);
  });

  it('an untrusted commenter cannot forge a clearance record', () => {
    const forged = fx.comments.map((c) => ({ ...c, author: { login: 'someone-else' } }));
    expect(latestAcceptRecord(forged)).toBeNull();
  });

  it('an agent accept (no cleared-human) never crosses a review:human hold', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record: { ...record, humanCleared: false }, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(v).toMatchObject({ action: 'carry', human: false });
    expect(decideSetLabel({ to: 'restamp', currentLabels: fx.labelsAfterRepark, humanCarry: v }).allowed).toBe(false);
  });

  it('a live review:changes send-back is never overridden', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(decideSetLabel({ to: 'restamp', currentLabels: [...fx.labelsAfterRepark, 'review:changes'], humanCarry: v }).allowed).toBe(false);
    expect(planAcceptCarry([{ number: 1, labels: ['review:human', 'review:changes'], headRefOid: NEW, comments: fx.comments }], { setting: 'on' })).toEqual([]);
  });

  it('restamp on review:human without proof is refused exactly as before', () => {
    expect(decideSetLabel({ to: 'restamp', currentLabels: ['review:human'] }).allowed).toBe(false);
  });

  it('same head: nothing to carry, the sweep skips it', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record, headSha: OLD, headDiff: fx.netDiff[OLD] }).action).toBe('same-head');
    expect(planAcceptCarry([{ number: 1, labels: ['review:human'], headRefOid: OLD, comments: fx.comments }], { setting: 'on' })).toEqual([]);
  });

  it('the sweep is inert when the setting is off', () => {
    const prs = [{ number: 4535, labels: ['review:human'], headRefOid: NEW, comments: fx.comments }];
    expect(sweepAcceptCarry({ prs, setting: 'off', runRestamp: () => { throw new Error('must not run'); } })).toEqual([]);
  });
});

// PR #4631 review round 1 (F2-F4): `laterVerdict` was a rule input NO caller supplied, so a deliberate later hold that
// leaves no `reviewed-sha` marker was invisible and an identical diff cancelled it. It is now read off the thread by
// `latestAcceptRecord`, so the drain gate, the restamp and the sweep all see it from the one place.
describe('a later verdict or deliberate hold is never carried past (positive identification, every consumer)', () => {
  const BOT = { login: 'web-everything' };
  const after = (body, author = BOT) => [...fx.comments, { author, body, createdAt: '2026-10-09T15:00:00Z' }];
  const drainPark = (reason) => `<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\n${reason}`;
  const verdict = (comments) => decideAcceptCarryForward({ setting: 'on', record: latestAcceptRecord(comments), headSha: NEW, headDiff: fx.netDiff[NEW] });
  const planned = (comments) => planAcceptCarry([{ number: 7, labels: ['review:human'], headRefOid: NEW, comments }], { setting: 'on' });

  const BLOCKING = {
    'a changes verdict (review-set-label / review-pr)': '🔁 review — changes requested\n\nRecorded by agent. A real concern.',
    'a human-review changes verdict': '🔁 human review — changes requested\n\nfix the thing',
    'a re-arm (an independent re-review is owed)': '🔧 conveyor fix — re-armed for re-review\n\nround 2',
    'a stand-down': '🛑 conveyor fix — stood down, human judgment needed\n\nreason: needs-judgment',
    'a CI-heal escalation': '🚦 conveyor CI-heal — escalated\n\nout of attempts',
    'a CI-heal void verdict': '🚦 conveyor CI-heal — verdict void\n\nthe head moved',
    'a referral hold': 'review paused: blocked referral findings',
    'an escalation-policy drain park': drainPark('review escalation: blast-radius over threshold'),
    // PR-author text inside a trusted comment must not forge the exemption (anchored match, not a substring).
    'a drain park whose reason merely MENTIONS test-gaming (path text from the PR)': drainPark('review escalation: touches scripts/test-gaming suspected—notes.test.mjs'),
    'a drain park that quotes the exempt phrase after other text': drainPark('blast radius — see also: test-gaming suspected — in the PR body'),
    'a manifest-tamper drain park': drainPark('manifest baseline mismatch — post-review tamper'),
  };

  for (const [name, body] of Object.entries(BLOCKING)) {
    it(`${name} after the clear-human blocks the carry in the rule AND the sweep plan`, () => {
      const comments = after(body);
      expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
      expect(verdict(comments).action).toBe('none');
      expect(planned(comments)).toEqual([]);
    });
  }

  it('an untrusted commenter\'s verdict-shaped comment does not block (it cannot forge a hold either way)', () => {
    const comments = after(BLOCKING['a changes verdict (review-set-label / review-pr)'], { login: 'someone-else' });
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments).action).toBe('carry');
  });

  it('the anti-test-gaming drain park (a function of the diff) does NOT block: the #4535 shape this card exists for', () => {
    const comments = after(drainPark('test-gaming suspected — CI-green may be manufactured by tampering with tests: 1 test removed'));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments)).toMatchObject({ action: 'carry', human: true });
    expect(planned(comments)).toEqual([{ num: 7, head: NEW, from: OLD }]);
  });

  it('the drain restating an already-standing hold (posted after the test-gaming re-park strips ready-to-merge) does NOT block', () => {
    const comments = after(drainPark('held — a review hold (review:human) stands on this PR'));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(planned(comments)).toEqual([{ num: 7, head: NEW, from: OLD }]);
  });

  it('neutral conveyor chatter (fix claims, CI-heal notes) does not block', () => {
    const comments = after('🔒 conveyor fix-begin — fix claim held\n\n**Who:** `fix-1`');
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments).action).toBe('carry');
  });

  it('a verdict posted BEFORE the clear-human is superseded by it and does not block', () => {
    const early = [{ author: BOT, body: '🔁 review — changes requested\n\nold round', createdAt: '2026-10-09T09:00:00Z' }];
    const comments = [fx.comments[0], ...early, ...fx.comments.slice(1)];
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments).action).toBe('carry');
  });

  it('an explicit laterVerdict fact still blocks (OR with the derived one)', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: latestAcceptRecord(fx.comments), headSha: NEW, headDiff: fx.netDiff[NEW], laterVerdict: true }).action).toBe('none');
  });

  it('both later-hold facts are derived into the record the rule is handed (not left to each caller to supply)', () => {
    const rec = latestAcceptRecord(after(BLOCKING['a changes verdict (review-set-label / review-pr)']));
    expect(Object.keys(rec)).toEqual(expect.arrayContaining(['laterVerdict', 'laterBodyDerivedHold']));
  });
});

// The restamp CLI end to end against a REAL throwaway git repo (the plateau-app #217 shape: the clear-human comment has
// only `reviewed-sha`, no diff marker, so the carry proof is re-derived from git). Pins F1 (the posted comment keeps the
// `cleared-human` marker) and the caller-level half of F2-F4 (a later hold makes the restamp refuse with NO write).
describe('review-set-label --to=restamp across a review:human re-hold (CLI, real git)', () => {
  let dir = null;
  let heads = null;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
  const build = () => {
    dir = mkdtempSync(join(tmpdir(), 'acf-restamp-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'base\n'); git('add', 'f.txt'); git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'lane/x');
    writeFileSync(join(dir, 'a.txt'), 'feature\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'feature');
    const cleared = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'g.txt'), 'unrelated main work\n'); git('add', 'g.txt'); git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'lane/x');
    git('merge', '-q', '--no-edit', '--no-ff', 'main');
    git('remote', 'add', 'origin', dir);
    heads = { cleared, head: git('rev-parse', 'HEAD') };
  };
  beforeAll(build);
  afterAll(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } });

  const BOT = { login: 'web-everything' };
  const clearComment = () => ({ author: BOT, body: `✅ review — cleared\n<!-- reviewed-sha: ${heads.cleared} -->\n<!-- cleared-human: chalbert -->` });

  // The live #4535 evidence shape: the drain ledgered its test-gaming park, then added the label 9 s later.
  const PARK_AT = '2026-10-09T14:36:41.318Z';
  const dRow = (over = {}) => ({ pr: 9, verdict: 'human', source: 'merge-ai-prs', actor: { declared: 'drain' }, at: PARK_AT,
    reason: 'test-gaming suspected — CI-green may be manufactured by tampering with tests', ...over });
  const labeledAt = (created_at, login = 'chalbert') => ({ event: 'labeled', created_at, label: { name: 'review:human' }, actor: { login } });
  const MECHANICAL = { ledger: [dRow()], events: [labeledAt('2026-10-09T14:36:50Z')] };

  /** Drives the real CLI with a recording provider; returns what was written. `events: null` = timeline unreadable. */
  const restamp = ({ comments, labels = ['review:human'], ledger = MECHANICAL.ledger, events = MECHANICAL.events }) => {
    const writes = { setLabels: [], postComment: [] };
    const provider = {
      name: 'stub', currentRepo: () => 'o/n',
      readHoldLabelEvents: () => { if (events === null) throw new Error('gh api failed'); return events; },
      readPrState: () => ({ labels: labels.map((name) => ({ name })), comments, headRefOid: heads.head, headRefName: 'lane/x', state: 'OPEN', isDraft: false, body: '', title: '' }),
      readLabels: () => labels.map((name) => ({ name })),
      setLabels: (_r, _p, spec) => { writes.setLabels.push(spec); },
      postComment: (_r, _p, body) => { writes.postComment.push(body); },
    };
    const chunks = [];
    const realExit = process.exit.bind(process);
    const prev = { GIT_DIR: process.env.GIT_DIR, WE_ACCEPT_CARRY_FORWARD: process.env.WE_ACCEPT_CARRY_FORWARD };
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    process.env.GIT_DIR = join(dir, '.git');
    process.env.WE_ACCEPT_CARRY_FORWARD = 'on';
    let exitCode = 0;
    try {
      runReviewLabelCli({
        defaultActor: 'test', usage: 'usage: test', emit: (l) => chunks.push(String(l)), provider,
        readLedgerRows: () => (typeof ledger === 'function' ? ledger() : ledger),
        argv: ['9', '--repo=o/n', '--to=restamp', '--actor=review-daemon', '--channel=accept-carry-forward', '--reason=head moved by a mechanical pass'],
        buildComment: ({ to, actor, headSha, reason, reviewedDiff, clearerId, independence, humanClearance }) => buildVerdictComment({
          to, actor, headSha, reason, reviewedDiff, clearerId, independence, channel: 'accept-carry-forward', humanClearance,
        }),
        successResult: (o) => ({ ok: true, ...o }),
        refusalResult: ({ decision }) => ({ error: decision.reason, refused: true, ...(decision.retryable ? { retryable: true } : {}) }),
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; } finally {
      process.exit = realExit;
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return { exitCode, writes, out: chunks.join('') };
  };

  it('F1: a clearance proven by re-derived git diff still stamps cleared-human on the NEW head', () => {
    const r = restamp({ comments: [clearComment()] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.postComment).toHaveLength(1);
    const body = r.writes.postComment[0];
    expect(body).toContain(`reviewed-sha: ${heads.head}`);
    expect(body).toContain('cleared-human: chalbert');
    // The next hold check binds reviewed-sha and cleared-human to one comment: it must now name the NEW head.
    expect(parseLatestHumanClearedSha([clearComment(), { author: BOT, body }])).toBe(heads.head);
    expect(parseOperatorClearance([{ author: BOT, body }])).toEqual({ actor: 'chalbert' });
  });

  it('F2-F4: a deliberate changes verdict after the clear-human makes the restamp refuse, with NO label or comment write', () => {
    const later = { author: BOT, body: '🔁 review — changes requested\n\nRecorded by agent. A real concern.' };
    const r = restamp({ comments: [clearComment(), later] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual({ setLabels: [], postComment: [] });
  });

  it('F1 (plain restamp, no live hold): a diff-less clearance on a review:accepted PR still keeps cleared-human', () => {
    const r = restamp({ comments: [clearComment()], labels: ['review:accepted'] });
    expect(r.exitCode).toBe(0);
    const body = r.writes.postComment[0];
    expect(body).toContain(`reviewed-sha: ${heads.head}`);
    expect(body).toContain('cleared-human: chalbert');
    expect(parseLatestHumanClearedSha([clearComment(), { author: BOT, body }])).toBe(heads.head);
  });

  it('F2-F4: a later escalation-policy drain park makes the restamp refuse, with NO write', () => {
    const later = { author: BOT, body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\nreview escalation: blast-radius over threshold' };
    const r = restamp({ comments: [clearComment(), later] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual({ setLabels: [], postComment: [] });
  });

  it('the #4535 shape: only a test-gaming drain park after the clear-human — the restamp still carries', () => {
    const later = { author: BOT, body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\ntest-gaming suspected — CI-green may be manufactured' };
    const r = restamp({ comments: [clearComment(), later] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.postComment[0]).toContain('cleared-human: chalbert');
    expect(r.writes.setLabels[0].add).toBe('review:accepted');
  });

  // PR #4631 review round 2 (F3/F4). An identical diff proves the CONTENT is what was cleared; it says nothing about
  // WHO put the standing review:human there. Without positive provenance the restamp must refuse and write nothing.
  const NO_WRITES = { setLabels: [], postComment: [] };

  it('a deliberate label-only human re-hold survives an identical-diff restamp', () => {
    // The operator re-adds review:human by hand after the clear-human: a label event, no comment, NO drain ledger row.
    const r = restamp({ comments: [clearComment()], ledger: [], events: [labeledAt('2026-10-09T15:00:00Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(r.out).toMatch(/not proven mechanical/);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true });
  });

  it('a held-park comment does not launder a deliberate hold (it is posted BECAUSE a hold stands, whoever put it there)', () => {
    const held = { author: BOT, body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\nheld — a review hold (review:human) stands on this PR' };
    const r = restamp({ comments: [clearComment(), held], ledger: [], events: [labeledAt('2026-10-09T15:00:00Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a hold re-added by hand BEFORE a later drain park is not explained by that park (unpaired label event)', () => {
    const r = restamp({ comments: [clearComment()], ledger: [dRow()], events: [labeledAt('2026-10-09T13:00:00Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a hold re-added by hand AFTER the drain park is the latest add, not the park\'s own', () => {
    const r = restamp({ comments: [clearComment()], ledger: [dRow()], events: [labeledAt('2026-10-09T14:36:50Z'), labeledAt('2026-10-09T18:00:00Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a sanctioned verdict ledgered after the drain park supersedes the clearance', () => {
    const later = dRow({ verdict: 'changes', source: 'review-set-label', actor: { declared: 'chalbert' }, reason: 'changes', at: '2026-10-09T14:40:00.000Z' });
    const r = restamp({ comments: [clearComment()], ledger: [dRow(), later] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a drain park older than the clearance does not count', () => {
    const cleared = { ...clearComment(), createdAt: '2026-10-09T15:30:00Z' };
    const r = restamp({ comments: [cleared], ledger: [dRow()], events: [labeledAt('2026-10-09T14:36:50Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('an unreadable label timeline refuses as a RETRYABLE read miss, with NO write', () => {
    const r = restamp({ comments: [clearComment()], events: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true, retryable: true });
  });

  it('an unreadable verdict ledger is a RETRYABLE read miss, not "no park ledgered"', () => {
    const r = restamp({ comments: [clearComment()], ledger: () => { throw new Error('EACCES'); } });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true, retryable: true });
  });

  it('a retry after a failed restamp is not blocked by the failed attempt\'s own `restamped` ledger row', () => {
    const own = dRow({ verdict: 'restamped', source: 'review-set-label', actor: { declared: 'review-daemon' }, at: '2026-10-09T14:40:00.000Z', reason: 'carried' });
    const r = restamp({ comments: [clearComment()], ledger: [dRow(), own] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.setLabels[0].add).toBe('review:accepted');
  });

  it('a content refusal (changed diff) is a settled decision, NOT retryable', () => {
    const r = restamp({ comments: [{ ...clearComment(), body: `${clearComment().body}\n<!-- reviewed-diff: ${OTHER_FP} -->` }] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    const printed = JSON.parse(r.out.trim().split('\n').pop());
    expect(printed.refused).toBe(true);
    expect(printed.retryable).toBeUndefined();
  });
});

describe('decideMechanicalHold — the hold-origin rule (pure)', () => {
  const T = Date.parse('2026-10-09T14:36:41.318Z');
  const iso = (ms) => new Date(T + ms).toISOString();
  const row = (over = {}) => ({ pr: 5, verdict: 'human', source: 'merge-ai-prs', actor: { declared: 'drain' }, at: iso(0), reason: 'test-gaming suspected — x', ...over });
  const ev = (ms) => ({ event: 'labeled', created_at: iso(ms), label: { name: 'review:human' } });
  const decide = (o) => decideMechanicalHold({ pr: 5, clearAt: iso(-3_600_000), rows: [row()], events: [ev(9_000)], ...o });

  it('the live #4535 pairing (label add 9 s after the ledger row) is mechanical', () => {
    expect(decide({}).mechanical).toBe(true);
  });
  it('a row from another PR / a non-drain source / a non-test-gaming reason / a non-human verdict is not proof', () => {
    for (const rows of [[row({ pr: 6 })], [row({ source: 'review-set-label' })], [row({ reason: 'held — a review hold' })],
      [row({ verdict: 'pending' })], [row({ actor: { declared: 'chalbert' } })]]) {
      expect(decide({ rows }).mechanical).toBe(false);
    }
  });
  it('an unanchored mention of the phrase in another reason is not proof (the reason must LEAD with it)', () => {
    expect(decide({ rows: [row({ reason: 'review escalation: touches test-gaming suspected — notes' })] }).mechanical).toBe(false);
  });
  it('the label add must follow the row within the window and must be the latest add', () => {
    expect(decide({ events: [ev(200_000)] }).mechanical).toBe(false);
    expect(decide({ events: [ev(-60_000)] }).mechanical).toBe(false);
    expect(decide({ events: [ev(9_000), ev(600_000)] }).mechanical).toBe(false);
    expect(decide({ events: [] }).mechanical).toBe(false);
  });
  it('an unreadable timeline (null) is retryable; no proof is not', () => {
    expect(decide({ events: null })).toMatchObject({ mechanical: false, retryable: true });
    expect(decide({ rows: [] }).retryable).toBeUndefined();
  });
});

describe('the sweep runs the restamp in the PR repo\'s own checkout and remembers only settled outcomes (PR #4631 F1/F2)', () => {
  beforeEach(() => _resetAcceptCarryMemo());
  const prs = [{ number: 217, labels: ['review:human'], headRefOid: NEW, comments: fx.comments }];
  const cand = { repo: 'plateauapp/plateau-app', num: 217, head: NEW, from: OLD };
  const spawnOf = (result) => { const calls = []; return { calls, spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; } }; };

  it('F1: a non-local repo\'s restamp child is pinned to that repo\'s checkout (cwd), and --repo names it', () => {
    const { calls, spawn } = spawnOf({ status: 0, stdout: '{"ok":true}\n' });
    expect(defaultRunRestamp(cand, { spawn, cloneDirFor: () => '/clones/plateau-app' }).ok).toBe(true);
    expect(calls[0].opts.cwd).toBe('/clones/plateau-app');
    expect(calls[0].args).toContain('--repo=plateauapp/plateau-app');
  });

  it('F1: no checkout provisioned → nothing is spawned and the outcome is retryable (not a refusal)', () => {
    const { calls, spawn } = spawnOf({ status: 0, stdout: '' });
    expect(defaultRunRestamp(cand, { spawn, cloneDirFor: () => null })).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(0);
  });

  it('F1: the clone resolver maps a constellation slug to its checkout and returns null when it is not there', () => {
    expect(defaultCloneDirFor('plateauapp/plateau-app', { profileOf: () => ({ checkoutPath: '/c/pa' }), exists: (p) => p === '/c/pa/.git' })).toBe('/c/pa');
    expect(defaultCloneDirFor('plateauapp/plateau-app', { profileOf: () => ({ checkoutPath: '/c/pa' }), exists: () => false })).toBeNull();
    expect(defaultCloneDirFor('nope/nope', { profileOf: () => null })).toBeNull();
    expect(defaultCloneDirFor(null)).toBeUndefined();
  });

  it('F2: a printed DECISION is settled; a read-miss refusal, a crash, a timeout and a signal are retryable', () => {
    const run = (result) => defaultRunRestamp(cand, { spawn: () => result, cloneDirFor: () => '/c' });
    expect(run({ status: 1, stdout: '{"error":"changed","refused":true}\n' })).toMatchObject({ ok: false, retryable: false });
    expect(run({ status: 1, stdout: '{"error":"no diff","refused":true,"retryable":true}\n' }).retryable).toBe(true);
    expect(run({ status: 1, stdout: '{"error":"gh pr view failed"}\n' }).retryable).toBe(true);
    expect(run({ status: 1, stdout: 'Error: boom\n' }).retryable).toBe(true);
    expect(run({ status: null, signal: 'SIGTERM', stdout: '' }).retryable).toBe(true);
    expect(run({ status: null, error: new Error('ETIMEDOUT'), stdout: '' }).retryable).toBe(true);
  });

  it('F2: a transient failure is retried on the next tick for the same head; a success is then remembered', () => {
    const results = [{ ok: false, retryable: true, detail: 'fetch miss' }, { ok: true, detail: 'carried' }];
    const runRestamp = () => results.shift();
    let t = 5_000_000;
    const sweep = () => sweepAcceptCarry({ prs, repo: 'plateauapp/plateau-app', setting: 'on', runRestamp, now: () => t });
    expect(sweep()).toEqual([{ num: 217, carry: 'retry', detail: 'fetch miss' }]);
    expect(sweep()).toEqual([]); // inside the backoff window
    t += TRANSIENT_BACKOFF_BASE_MS;
    expect(sweep()).toEqual([{ num: 217, carry: 'carried', detail: 'carried' }]);
    t += TRANSIENT_BACKOFF_MAX_MS;
    expect(sweep()).toEqual([]);
  });

  it('F2: a settled refusal is not retried for the same head, and a thrown runner counts as transient', () => {
    let n = 0;
    const refuse = () => { n += 1; return { ok: false, retryable: false, detail: 'changed diff' }; };
    sweepAcceptCarry({ prs, setting: 'on', runRestamp: refuse }); sweepAcceptCarry({ prs, setting: 'on', runRestamp: refuse });
    expect(n).toBe(1);
    _resetAcceptCarryMemo();
    expect(sweepAcceptCarry({ prs, setting: 'on', runRestamp: () => { throw new Error('spawn blew up'); } })[0].carry).toBe('retry');
  });

  it('F2: transient retries back off exponentially (capped) and are never given up on', () => {
    let n = 0;
    let t = 1_000_000;
    const flaky = () => { n += 1; return { ok: false, retryable: true, detail: 'x' }; };
    const tick = () => sweepAcceptCarry({ prs, setting: 'on', runRestamp: flaky, now: () => t });
    tick(); tick(); // second call is inside the backoff window
    expect(n).toBe(1);
    t += transientBackoffMs(1); tick();
    expect(n).toBe(2);
    t += transientBackoffMs(1); tick(); // window is now longer
    expect(n).toBe(2);
    expect(transientBackoffMs(1)).toBe(TRANSIENT_BACKOFF_BASE_MS);
    expect(transientBackoffMs(50)).toBe(TRANSIENT_BACKOFF_MAX_MS);
    for (let i = 0; i < 20; i += 1) { t += TRANSIENT_BACKOFF_MAX_MS; tick(); } // a long outage still retries
    expect(n).toBe(22);
  });
});

describe('setting cascade (card x5wnfcg)', () => {
  it('env > settings file > built-in off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acf-'));
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ acceptCarryForward: 'on' }));
    expect(resolveAcceptCarryForward({ env: {}, file })).toEqual({ value: 'on', source: 'settings' });
    expect(resolveAcceptCarryForward({ env: { WE_ACCEPT_CARRY_FORWARD: 'off' }, file })).toEqual({ value: 'off', source: 'env' });
    expect(resolveAcceptCarryForward({ env: {}, file: join(dir, 'missing.json') })).toEqual({ value: 'off', source: 'default' });
  });

  it('the platform preference ships on', () => {
    expect(JSON.parse(readFileSync(ACCEPT_CARRY_FORWARD_SETTINGS_FILE, 'utf8')).acceptCarryForward).toBe('on');
  });
});

describe('plateau-app #217 replay — clearance stamped with reviewed-sha only (no diff marker), refreshed 808f0deb → 4339cf57', () => {
  const OLD217 = '808f0deba4d8' + '0'.repeat(28);
  const NEW217 = '4339cf573915' + '0'.repeat(28);
  const DIFF = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const view = { headRefOid: NEW217, headRefName: 'lane/xadunn9-wip-deeplinks',
    comments: [{ author: { login: 'web-everything[bot]' }, body: `✅ review — cleared\n<!-- reviewed-sha: ${OLD217} -->\n<!-- cleared-human: chalbert -->` }] };
  const exec = (cmd) => { if (cmd === 'gh') return JSON.stringify(view); throw new Error('unexpected'); };
  const read = (texts, carrySetting = 'on') => readDrainAcceptance({ pr: 217, repo: 'plateauapp/plateau-app', cwd: '/clone', exec, carrySetting,
    netDiff: ({ rev }) => (texts[rev] == null ? { scored: false } : { scored: true, text: texts[rev] }) });

  it('identical net diff on both heads: the accept covers the refreshed head (derived from git)', () => {
    const ev = read({ [OLD217]: DIFF, 'lane/xadunn9-wip-deeplinks': DIFF });
    expect(ev.acceptedDiffDerived).toBe(true);
    expect(acceptanceCoversHead(ev).covers).toBe(true);
  });

  it('a changed net diff does not cover', () => {
    const ev = read({ [OLD217]: DIFF, 'lane/xadunn9-wip-deeplinks': DIFF.replace('+b', '+c') });
    expect(acceptanceCoversHead(ev).covers).toBe(false);
  });

  it('an unreadable accepted head leaves today\'s SHA identity (not covered)', () => {
    const ev = read({ 'lane/xadunn9-wip-deeplinks': DIFF });
    expect(ev.acceptedDiff).toBeNull();
    expect(acceptanceCoversHead(ev).covers).toBe(false);
  });

  it('setting off = today', () => {
    expect(acceptanceCoversHead(read({ [OLD217]: DIFF, 'lane/xadunn9-wip-deeplinks': DIFF }, 'off')).covers).toBe(false);
  });
});
