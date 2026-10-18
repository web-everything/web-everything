// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { postAcceptRedTeamOwed, redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { applyRedTeamGate } from '../../operations/red-team-gate-apply.mjs';
import { redTeamGateMarker } from '../red-team-gate.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';

const head = 'a'.repeat(40), repo = 'Web-Everything/web-everything', pr = 5486;
const row = (over = {}) => ({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
  status: 'ok', recheckStatus: 'ok', confirmedMissCount: 0, findings: [], ...over });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(rows) {
  const root = mkdtempSync(join(tmpdir(), 'saved-red-team-')); dirs.push(root);
  const env = { CONVEYOR_STATE_ROOT: root };
  const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
  return { env, path };
}
const hold = (env, over = {}) => redTeamEnqueueHold({ repo, pr, head, comments: [], env,
  loopPayload: { verdict: { verdict: 'accept' } }, ...over });

describe('saved red-team admission', () => {
  it('saved clean result releases the hold without a posted comment', () => {
    expect(hold(fixture([row()]).env)).toBeNull();
  });
  it('saved result with a confirmed break still holds', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken', summary: 'break' }];
    expect(hold(fixture([row({ findings, confirmedMissCount: 1 })]).env)).toMatch(/requiring send-back/);
  });
  it('no saved result keeps the hold', () => expect(hold(fixture([]).env)).toMatch(/no recorded result/));
  it.each([{ rev: 'b'.repeat(40) }, { repo: 'other/repo' }, { pr: 999 }, { status: 'error' }, { seat: 'skeptic' }])(
    'ignores another identity or incomplete run: %j', over => {
      expect(hold(fixture([row(over)]).env)).toMatch(/no recorded result/);
    });
  it('setting off restores comment-only behavior', () => {
    expect(hold({ ...fixture([row()]).env, WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'off' })).toMatch(/no recorded result/);
  });
  it.each([{ findings: null }, { findings: [{}] }, { findings: [], confirmedMissCount: 1 }])(
    'refuses malformed saved findings: %j', over => {
      const { env } = fixture([row(over)]);
      expect(() => hold(env)).toThrow();
    });
  it('refuses corrupt shared evidence rather than releasing the hold', () => {
    const { env, path } = fixture([]); writeFileSync(path, '{truncated');
    expect(() => hold(env)).toThrow();
  });
  it.each([1, 99])('routes saved breaks through the existing gate at round %i', async round => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken', summary: 'break' }];
    const { env } = fixture([row({ findings, confirmedMissCount: 1 })]);
    const { readSavedRedTeamResult } = await import('../drain-saved-red-team.mjs');
    const result = await applyRedTeamGate({ repo, pr, dryRun: true }, {
      readPr: () => ({ headRefOid: head, comments: [], labels: ['ready-to-merge'] }),
      readSavedResult: args => readSavedRedTeamResult({ ...args, env }),
      readSetting: () => ({ value: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' } }),
      readRound: () => round,
    });
    expect(result.status).toBe('dry-run');
    expect(result.outcome).toBe(round === 1 ? 'sent-back' : 'round-cap');
  });
  it('honors a trusted operator ruling after a saved break and round cap', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken' }];
    const { env } = fixture([row({ findings, confirmedMissCount: 1, scoredAt: '2026-10-17T10:00:00Z' })]);
    const cap = { author: { login: 'web-everything' }, createdAt: '2026-10-17T10:01:00Z', body: redTeamGateMarker(pr, head, 'round-cap') };
    const cleared = { author: { login: 'web-everything' }, createdAt: '2026-10-17T10:02:00Z', body: [
      '✅ review — `review:human` cleared via the sanctioned path', '',
      'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
      buildReviewedShaMarker(head), buildClearedHumanMarker('operator'),
    ].join('\n') };
    expect(hold(env, { comments: [cap, cleared] })).toBeNull();
    expect(hold(env, { comments: [cleared, cap] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [cap, { ...cleared, author: { login: 'attacker' } }] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [{ ...cap, createdAt: undefined }, cleared] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [cap, { ...cleared, createdAt: '2026-10-17T09:00:00Z' }] })).toMatch(/requiring send-back/);
  });
});

describe('redTeam.drainReadsSavedResult cascade', () => {
  it('defaults on and logs its source', async () => {
    const { readSavedRedTeamSetting } = await import('../drain-saved-red-team.mjs');
    const lines = [];
    const r = readSavedRedTeamSetting({ env: {}, tool: {}, platform: {}, log: l => lines.push(l) });
    expect(r.value.drainReadsSavedResult).toBe(true);
    expect(lines.join('\n')).toContain('drainReadsSavedResult=true (standard)');
  });
  it('resolves platform, tool, environment and rejects invalid values', async () => {
    const { readSavedRedTeamSetting } = await import('../drain-saved-red-team.mjs');
    const read = over => readSavedRedTeamSetting({ env: {}, tool: {}, platform: {}, ...over });
    expect(read({ platform: { drainReadsSavedResult: false } }).sources.drainReadsSavedResult).toBe('platform');
    expect(read({ platform: { drainReadsSavedResult: false }, tool: { drainReadsSavedResult: true } }).sources.drainReadsSavedResult).toBe('tool');
    const r = read({ tool: { drainReadsSavedResult: true }, env: { WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'off' } });
    expect(r.value.drainReadsSavedResult).toBe(false); expect(r.sources.drainReadsSavedResult).toBe('env');
    expect(read({ tool: { drainReadsSavedResult: 'false' } }).value.drainReadsSavedResult).toBe(true);
  });
});


describe('usable live-head scheduler evidence', () => {
  const payload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } };
  function evidence(rows, result = 'ran') {
    const { env } = fixture(rows);
    env.WE_SHARED_RUNS_DIR = join(dirs.at(-1), 'runs');
    recordRedTeamStatus({ repo, pr, loopPayload: payload, status: 'finished', result }, { env });
    return { env, read: () => readDrainRedTeamEvidence({ repo, pr, head, env, readScorecards: () => rows }) };
  }
  it.each(['unparseable', 'error', 'not-posted'])('does not record an unusable %s pass merely because it ran', status => {
    const f = evidence([row({ status, seatVerdict: null })]);
    expect(f.read()).toMatchObject({ recorded: false, inFlight: false });
    expect(hold(f.env)).toMatch(/no recorded result/);
  });
  it('does not record ran without a posted or saved parsed result', () => {
    expect(evidence([]).read().recorded).toBe(false);
  });
  it.each(['accept', 'changes'])('records a saved parsed %s verdict despite a failed comment', seatVerdict => {
    const findings = seatVerdict === 'changes' ? [{ confirmedByRecheck: true, impactIfUnfixed: 'broken' }] : [];
    const f = evidence([row({ seatVerdict, findings, confirmedMissCount: findings.length })]);
    expect(f.read().recorded).toBe(true);
    if (findings.length) expect(hold(f.env)).toMatch(/requiring send-back/);
    else expect(hold(f.env)).toBeNull();
  });
  it('records a posted result even if its saved row is unavailable', () => {
    expect(evidence([], { status: 'ran', comment: 'posted' }).read().recorded).toBe(true);
  });
  it('does not record saved rows without a parsed verdict or from another head', () => {
    expect(evidence([row()]).read().recorded).toBe(false);
    expect(evidence([row({ seatVerdict: 'accept', rev: 'b'.repeat(40) })]).read().recorded).toBe(false);
  });
});

describe('card-only red-team obligation', () => {
  const payload = read => ({ verdict: { verdict: 'accept' }, findings: { read } });
  const card = { netChangedFiles: ['backlog/6206-card.md'] };
  it('owes no pass for card-only with skipCardOnly on', () => {
    expect(postAcceptRedTeamOwed(payload(card), { WE_RED_TEAM_SKIP_CARD_ONLY: 'on' })).toBe(false);
  });
  it('still owes a pass with skipCardOnly off', () => {
    expect(postAcceptRedTeamOwed(payload(card), { WE_RED_TEAM_SKIP_CARD_ONLY: 'off' })).toBe(true);
  });
  it.each([
    { netChangedFiles: ['scripts/code.mjs'] },
    { ...card, netRenameSources: ['scripts/code.mjs'] },
    { ...card, netRenameSources: 'unknown' },
    { netChangedFiles: [] }, {},
  ])('still owes a pass for code or unknown files: %j', read => {
    expect(postAcceptRedTeamOwed(payload(read), { WE_RED_TEAM_SKIP_CARD_ONLY: 'on' })).toBe(true);
  });
  it('card-only exemption cannot waive a saved confirmed break', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken' }];
    const { env } = fixture([row({ findings, confirmedMissCount: 1 })]);
    expect(hold({ ...env, WE_RED_TEAM_SKIP_CARD_ONLY: 'on' }, { loopPayload: payload(card) })).toMatch(/requiring send-back/);
  });
});
