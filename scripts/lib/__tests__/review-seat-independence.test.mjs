import { describe, it, expect, vi } from 'vitest';
import { independentReviewRequest, isIndependentReviewSeat } from '../review-seat-independence.mjs';
import { shadowSeatStatus, vendorOfModel } from '../review-seat-provider.mjs';
import { resolvePostAcceptAdvisorySettings } from '../post-accept-advisory-settings.mjs';
import { buildReviewAgyCorrectnessJudgeRequest, buildReviewAntigravityJudgeRequest } from '../../operations/review-pr.mjs';
import { seatAttempt, buildSeatSuccessReport, appendSeatAttempt, readSeatAttempts } from '../review-seat-ledger.mjs';
import { createDefaultJudge, judgeOutcome, unwrapJudgeOutcome } from '../../operations/cli-adapter.mjs';
import { buildDelegationMarker } from '../delegation-marker.mjs';
import { main } from '../agy-shadow-trial-report.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const carbon = { lens: 'correctness', model: 'claude-sonnet-5-5', seatProvider: { mode: 'agy', promoted: true, model: 'gemini-4-carbon-high' } };
const clean = { summary: 'Inspected', findings: [] };
const context = { repo: 'o/r', pr: 7, head: 'a'.repeat(40) };
describe('per-seat cross-vendor assignments', () => {
  it.each(['codex', 'claude', 'agy-gemini'].flatMap(builder => ['correctness', 'security', 'red-team'].map(seat => [builder, seat])))(
    '%s builder: %s has an independent deciding provider', (builder, seat) => {
      const request = seat === 'correctness' ? carbon : { lens: seat, providerName: seat === 'red-team' ? 'codex' : 'claude' };
      const assigned = independentReviewRequest(request, builder);
      const reviewer = assigned.seatProvider?.model ?? assigned.providerName;
      expect(isIndependentReviewSeat(seat, reviewer, builder)).toBe(true);
      if (builder === 'agy-gemini' && seat === 'correctness') expect(assigned.seatProvider).toBeUndefined();
    });
  it.each(['correctness', 'security', 'red-team'])('%s waits when only the builder vendor is available', lens => {
    expect(() => independentReviewRequest({ lens }, 'claude', ['claude', 'agy-claude'])).toThrow(/WAIT/);
    expect(() => independentReviewRequest({ lens }, 'unknown')).toThrow(/WAIT/);
  });
  it.each(['simplicity', 'standards-conformance', 'claim-accuracy'])('%s permits the builder vendor', lens => {
    const request = { lens, providerName: 'claude' };
    expect(independentReviewRequest(request, 'claude')).toBe(request);
  });
  it('runtime fallback after a Carbon failure cannot invoke Claude for a Claude builder', async () => {
    const providers = [], rows = [];
    const judge = createDefaultJudge({ appendSeat: r => { rows.push(r); return true; },
      resolveProvider: name => async () => { providers.push(name); return { value: clean, servedModel: 'gpt-6.1-sol' }; },
      seatRunner: async (request, io) => io.claudeJudge({ ...request, seatProvider: undefined }), checkProviderHold: async () => null,
    });
    const out = await judge({ ...carbon, mandate: 'Review', input: 'diff', shape: { type: 'object' },
      reviewContext: { ...context, body: buildDelegationMarker({ provider: 'claude', model: 'claude-sonnet-5-5', taskType: 'bugfix' }) } });
    expect(providers).toEqual(['codex']);
    expect(unwrapJudgeOutcome(out).value).toEqual(clean);
    expect(rows[0]).toMatchObject({ lens: 'correctness', provider: 'codex', status: 'ok' });
  });
});

describe('watch-only deterministic sampling', () => {
  it('postAcceptAdvisory defaults to 0.1 with provenance and permits layered overrides', () => {
    const opts = { env: {}, platform: {}, readFile: () => '{}', log: () => {} };
    expect(resolvePostAcceptAdvisorySettings(opts)).toMatchObject({ value: { sampleRate: 0.1 }, sources: { sampleRate: 'standard' } });
    expect(resolvePostAcceptAdvisorySettings({ ...opts, platform: { sampleRate: 0.2 } })).toMatchObject({ value: { sampleRate: 0.2 }, sources: { sampleRate: 'platform' } });
    expect(resolvePostAcceptAdvisorySettings({ ...opts, env: { WE_REVIEW_POST_ACCEPT_ADVISORY_SAMPLE_RATE: '1' } }).value.sampleRate).toBe(0.1);
  });
  it('agy advisory uses the same PR sampling as the existing Carbon shadow mechanism', () => {
    const settings = { shadowPolicy: { shadowEnabled: true, scope: 'sampled', sampleRate: 0.1 } };
    let sampled = 0;
    for (let pr = 1; pr <= 200; pr++) {
      const read = { ...context, pr, title: 'Change', netChangedFiles: [], diffText: '', body: '' };
      const request = buildReviewAgyCorrectnessJudgeRequest({ read, model: 'claude-sonnet-5-5-high' });
      const expected = shadowSeatStatus(settings, read) === 'sampled';
      expect(!request.skipSpawn).toBe(expected);
      expect(!buildReviewAntigravityJudgeRequest({ read }).skipSpawn).toBe(expected);
      if (expected) sampled++;
    }
    expect(sampled).toBeGreaterThan(5);
    expect(sampled).toBeLessThan(35);
  });
});

describe('seat and provider success ledger', () => {
  it('records real answers, failures and timeouts and exposes one offline read command', () => {
    const root = mkdtempSync(join(tmpdir(), 'seat-success-'));
    try {
      const path = join(root, 'ledger.jsonl');
      const request = { ...carbon, reviewContext: context, runId: 'run' };
      const expired = new Error('review exceeded its deadline');
      expired.name = 'JudgeTimeoutError';
      expect(seatAttempt(request, null, expired).timeout).toBe(true);
      const answer = { ...clean, seatProvider: { provider: 'agy', model: 'gemini-4-carbon-high' } };
      const row = seatAttempt(request, { value: answer });
      expect(appendSeatAttempt(row, { path })).toBe(true);
      appendSeatAttempt(seatAttempt(request, null, new Error('timeout')), { path });
      const rows = readSeatAttempts({ path });
      const runRecords = new Map([['run', { verdict: { verdict: 'accept' } }]]);
      const report = buildSeatSuccessReport({ rows, runRecords, scorecards: [
        { dispatchKind: 'review-seat', lens: 'red-team', provider: 'codex', status: 'ok', seatVerdict: 'changes', claudeVerdict: 'accept', findings: [{ confirmedByRecheck: true }, { recheckOutcome: 'not-real' }] },
      ] });
      expect(report.bySeat.correctness).toMatchObject({ countedVerdicts: 1, timeouts: 1, agreement: { compared: 1, agree: 1 } });
      expect(report.byProvider.codex).toMatchObject({ countedVerdicts: 1, confirmedFindings: 1, falsePositives: 1 });
      expect(report.bySeatAndProvider['correctness/agy-gemini'].reviews).toBe(2);
      let text = '';
      main(['--seats', '--no-gh'], { readSeats: () => rows, readRows: () => [], readPromotion: () => [], readScorecards: () => ({ records: [] }), evidenceIO: { resolveDirs: () => [] }, write: s => { text += s; } });
      expect(JSON.parse(text).byProvider['agy-gemini'].countedVerdicts).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('a deciding-seat ledger write failure holds the answer instead of accepting', async () => {
    const judge = createDefaultJudge({ appendSeat: () => false,
      seatRunner: async () => judgeOutcome(clean, { model: 'gemini-4-carbon-high' }),
    });
    const request = { ...carbon, reviewContext: { ...context,
      body: buildDelegationMarker({ provider: 'claude', model: 'claude-sonnet-5-5', taskType: 'bugfix' }) } };
    await expect(judge(request)).rejects.toThrow(/WAIT: review seat ledger unavailable/);
  });
  it('does not infer a false positive from missing later evidence', () => {
    const row = { ...context, lens: 'security', provider: 'claude', status: 'ok', deciding: true, agyVerdict: 'changes', agyFindings: [{ path: 'x.mjs', normSummary: 'bad' }] };
    expect(buildSeatSuccessReport({ rows: [row] }).bySeat.security).toMatchObject({ falsePositives: 0, pendingFindings: 1 });
  });
});
