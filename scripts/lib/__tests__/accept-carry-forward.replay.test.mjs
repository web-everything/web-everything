/**
 * Card xu7kxtt (#5472, ruling P4) — replay fixtures for the accept carry-forward rule and its two consumers:
 * the restamp decision (review-set-label) and the review daemon's carry sweep. Live case: PR #4535, 2026-10-09.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  decideAcceptCarryForward, latestAcceptRecord, resolveAcceptCarryForward, ACCEPT_CARRY_FORWARD_SETTINGS_FILE,
} from '../accept-carry-forward.mjs';
import { decideSetLabel } from '../../review-set-label.mjs';
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
