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
  decideAcceptCarryForward, latestAcceptRecord, resolveAcceptCarryForward, ACCEPT_CARRY_FORWARD_SETTINGS_FILE,
} from '../accept-carry-forward.mjs';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment } from '../../review-set-label.mjs';
import { parseLatestHumanClearedSha, parseOperatorClearance } from '../review-escalation.mjs';
import { readDrainAcceptance } from '../../merge-ai-prs.mjs';
import { acceptanceCoversHead } from '../review-escalation.mjs';
import { planAcceptCarry, sweepAcceptCarry, _resetAcceptCarryMemo } from '../../conveyor/accept-carry-sweep.mjs';

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

  /** Drives the real CLI with a recording provider; returns what was written. */
  const restamp = ({ comments, labels = ['review:human'] }) => {
    const writes = { setLabels: [], postComment: [] };
    const provider = {
      name: 'stub', currentRepo: () => 'o/n',
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
        argv: ['9', '--repo=o/n', '--to=restamp', '--actor=review-daemon', '--channel=accept-carry-forward', '--reason=head moved by a mechanical pass'],
        buildComment: ({ to, actor, headSha, reason, reviewedDiff, clearerId, independence, humanClearance }) => buildVerdictComment({
          to, actor, headSha, reason, reviewedDiff, clearerId, independence, channel: 'accept-carry-forward', humanClearance,
        }),
        successResult: (o) => ({ ok: true, ...o }),
        refusalResult: ({ decision }) => ({ error: decision.reason }),
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
