// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { readSavedRedTeamResult } from '../drain-saved-red-team.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { saveProvenanceFixtures } from './fixtures/saved-red-team-provenance.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';

const REPO = 'web-everything/web-everything', HEAD = 'a'.repeat(40), PR = 6212;
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const row = (over = {}) => ({ dispatchKind: 'review-seat', seat: 'red-team', repo: REPO, pr: PR, rev: HEAD,
  status: 'ok', recheckStatus: 'ok', confirmedMissCount: 0, findings: [], ...over });
function fixture({ rows = [], verdict = 'changes', timing = 'panel-seat' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-seat-')); roots.push(root);
  const runsDir = join(root, 'runs');
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: runsDir, WE_RED_TEAM_TIMING: timing,
    WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'true', WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'true' };
  const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
  const loopPayload = { verdict: { verdict, lenses: ['correctness', 'security', 'red-team'],
    lensVerdicts: { correctness: verdict, security: 'accept' } }, findings: { read: {
    netBasis: { base: 'b'.repeat(40), rev: HEAD }, netChangedFiles: ['x.mjs'],
  } } };
  writeRun({ ...newRunRecord({ id: 'review-pr-6212', op: 'review-pr', input: { repo: REPO, pr: PR } }), ...loopPayload }, runsDir);
  saveProvenanceFixtures(env);
  const input = { repo: REPO, pr: PR, head: HEAD, env, runsDir, readScorecards: () => rows,
    isAlive: () => false, readPidStart: () => null };
  return { input, loopPayload, evidence: () => readDrainRedTeamEvidence(input),
    hold: (extra = {}) => redTeamEnqueueHold({ ...input, ...readDrainRedTeamEvidence(input), comments: [], ...extra }) };
}

describe('drain consumes live-head panel-seat evidence', () => {
  it('MISSING seat is owed even on a non-accepting reviewed head, with no scheduler artifact', () => {
    const f = fixture();
    expect(f.evidence()).toMatchObject({ scheduled: true, recorded: false, inFlight: false });
    expect(f.hold()).toEqual(expect.any(String));
  });

  it.each(['not-owed', 'skipped', 'disabled'])('UNRUN seat (%s) cannot use the never-scheduled escape', result => {
    const f = fixture();
    recordRedTeamStatus({ ...f.input, loopPayload: f.loopPayload, status: 'finished', result },
      { env: f.input.env, readPidStart: () => null, host: 'test', namespace: 'test' });
    // An explicit unrun status must never turn an owed seat into permission to enqueue.
    expect(f.hold({ requestPending: false })).toEqual(expect.any(String));
    expect(f.evidence().scheduled || f.evidence().attempted).toBe(true);
  });

  it.each([{ rev: 'b'.repeat(40) }, { repo: 'other/repo' }, { pr: 999 }, { status: 'error' }])(
    'another identity or an unsuccessful result cannot release the live-head seat: %j', over => {
      const f = fixture({ rows: [row(over)] });
      expect(f.hold()).toEqual(expect.any(String));
    });

  it('a clean saved seat result admits without a comment or another request', () => {
    const f = fixture({ rows: [row()] });
    expect(readSavedRedTeamResult(f.input)).toMatchObject({ pr: PR, rev: HEAD, findings: [], recheckIncomplete: false });
    expect(f.hold({ requestPending: false })).toBeNull();
  });

  it('human clearance after a seat-included review needs no new request or cooldown', () => {
    const f = fixture({ rows: [row()], verdict: 'needs-human' });
    const comments = [{ author: { login: 'web-everything' },
      body: `${buildReviewedShaMarker(HEAD)}\n${buildClearedHumanMarker('operator')}` }];
    expect(f.hold({ comments, labels: ['review:accepted', 'ready-to-merge'], requestPending: false })).toBeNull();
    // Clearance is not a substitute for the seat's evidence.
    const missing = fixture({ verdict: 'needs-human' });
    expect(missing.hold({ comments, labels: ['review:accepted', 'ready-to-merge'], requestPending: false }))
      .toEqual(expect.any(String));
  });

  it('confirmed BROKEN saved findings still hold; DEGRADED and unconfirmed only report', () => {
    for (const [impactIfUnfixed, confirmedByRecheck, blocks] of [['broken', true, true], ['degraded', true, false], ['broken', false, false]]) {
      const f = fixture({ rows: [row({ confirmedMissCount: Number(confirmedByRecheck),
        findings: [{ summary: 'input breaks claim', impactIfUnfixed, confirmedByRecheck }] })] });
      const held = f.hold({ confirmedBreaks: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' } });
      if (blocks) expect(held).toMatch(/requiring send-back/);
      else expect(held).toBeNull();
    }
  });

  it('post-accept rollback keeps old non-accept hold behavior and accepts saved clean evidence', () => {
    const old = fixture({ timing: 'post-accept' });
    expect(old.evidence().scheduled).toBe(false);
    expect(old.hold()).toBeNull();
    const accepted = fixture({ timing: 'post-accept', verdict: 'accept' });
    expect(accepted.hold()).toMatch(/no recorded result/);
    expect(fixture({ timing: 'post-accept', verdict: 'accept', rows: [row()] }).hold()).toBeNull();
  });
});
