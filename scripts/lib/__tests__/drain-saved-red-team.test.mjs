// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { readSavedRedTeamResult } from '../drain-saved-red-team.mjs';
import { applyRedTeamGate } from '../../operations/red-team-gate-apply.mjs';
import { readRedTeamDisposition, redTeamGateMarker, redTeamResultId } from '../red-team-gate.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';
import { saveProvenanceFixtures } from './fixtures/saved-red-team-provenance.mjs';
import { scrubPublish } from '../secret-scrub.mjs';

const head = 'a'.repeat(40), repo = 'Web-Everything/web-everything', pr = 5486;
const row = (over = {}) => ({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
  status: 'ok', recheckStatus: 'ok', confirmedMissCount: 0, findings: [], ...over });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(rows) {
  const root = mkdtempSync(join(tmpdir(), 'saved-red-team-')); dirs.push(root);
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
  saveProvenanceFixtures(env);
  return { env, path };
}
describe('saved red-team reader and gate', () => {
  const read = env => readSavedRedTeamResult({ repo, pr, head, env, log: () => {} });
  it('reads a clean saved result without a posted comment', () => {
    expect(read(fixture([row()]).env)).toMatchObject({ pr, rev: head, findings: [], recheckIncomplete: false });
  });
  it.each(['pending', 'error', undefined])('marks an incomplete re-check: %s', recheckStatus => {
    expect(read(fixture([row({ recheckStatus })]).env).recheckIncomplete).toBe(true);
  });
  it.each([{ rev: 'b'.repeat(40) }, { repo: 'other/repo' }, { pr: 999 }, { status: 'error' }, { seat: 'skeptic' }])(
    'ignores another identity or incomplete run: %j', over => {
      expect(read(fixture([row(over)]).env)).toBeNull();
    });
  it('setting off restores comment-only behavior', () => {
    expect(read({ ...fixture([row()]).env, WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'off' })).toBeNull();
  });
  it.each([{ findings: null }, { findings: [{}] }, { findings: [], confirmedMissCount: 1 }])(
    'refuses malformed saved findings: %j', over => {
      expect(() => read(fixture([row(over)]).env)).toThrow(/findings incomplete/);
    });
  it('refuses corrupt shared evidence', () => {
    const { env, path } = fixture([]); writeFileSync(path, '{truncated');
    expect(() => read(env)).toThrow(/malformed/);
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
  async function publishSaved(findings, round = 1) {
    const { env } = fixture([row({ findings, confirmedMissCount: findings.length })]);
    const { readSavedRedTeamResult } = await import('../drain-saved-red-team.mjs');
    const resultId = redTeamResultId(readSavedRedTeamResult({ repo, pr, head, env }));
    const writes = [];
    const result = await applyRedTeamGate({ repo, pr }, {
      readPr: () => ({ headRefOid: head, comments: [], labels: [] }),
      readHead: () => head,
      readSavedResult: args => readSavedRedTeamResult({ ...args, env }),
      readSetting: () => ({ value: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' } }),
      readRound: () => round,
      sendBack: input => { writes.push(input); return { ok: true }; },
      appendSendBackEvent: () => {}, dequeueSentBack: () => {},
      fileCard: input => { writes.push(input); return { ok: true }; },
      postComment: input => writes.push(input), log: () => {},
    });
    // Main adds a generated digest to gate markers. `result=<hex>` can trip the opaque-token heuristic;
    // remove only this exact computed metadata field, while checking every finding and composed output.
    // The marker may also carry the send-back step's grant snapshot (`grants=`), which is the same kind of metadata.
    const scrub = text => scrubPublish(text.replace(new RegExp(` result=${resultId}( grants=(none|[0-9a-f,]+))? -->`, 'g'), ' -->'));
    return { result, writes, scrub };
  }
  const publishableFinding = impactIfUnfixed => ({ confirmedByRecheck: true, impactIfUnfixed,
    category: 'edge-case', file: 'scripts/example.mjs', line: 12,
    summary: 'two writers race', failure_scenario: 'both writers enter', recheckReason: 'demonstrated break' });
  it('publishes saved findings that pass the posted-comment secret scrub to comments and cards', async () => {
    const { result, writes } = await publishSaved(['broken', 'degraded'].map(publishableFinding));
    expect(result.status).toBe('applied');
    for (const text of [writes.find(w => w.body?.includes('sent back to the fixer.**')).body, writes.find(w => w.digest).digest]) {
      expect(text).toContain('two writers race');
      expect(text).toContain('both writers enter');
      expect(text).toContain('demonstrated break');
      expect(scrubPublish(text)).toEqual([]);
    }
  });
  it('scrubs saved finding text after NFKC normalization composes a secret in publication output', async () => {
    const token = ['ghp_', 'Ab3dEf4hIj5lMn6pQr7tUv8xYz9bCd0fGh1j'].join('');
    const summary = [...token].map(c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    expect(scrubPublish(summary)).toEqual([]);
    expect(scrubPublish(summary.normalize('NFKC')).length).toBeGreaterThan(0);
    const { result, writes, scrub } = await publishSaved(['broken', 'degraded'].map(publishableFinding).map(f => ({ ...f, summary })));
    expect(result.status).toBe('applied');
    for (const write of writes) {
      for (const text of Object.values(write).filter(v => typeof v === 'string')) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(summary);
        expect(text).not.toContain('scripts/example.mjs');
        expect(scrub(text)).toEqual([]);
      }
    }
  });
  it.each(['summary', 'failure_scenario', 'recheckReason', 'file', 'category', 'line', 'impactIfUnfixed'])(
    'withholds all saved finding text when the secret scrub refuses %s, preserving verdict, count and class', async field => {
      const secret = ['ghp_', 'Ab3dEf4hIj5lMn6pQr7tUv8xYz9bCd0fGh1j'].join('');
      expect(scrubPublish(secret).length).toBeGreaterThan(0);
      for (const [round, taintedIndex] of [[1, 0], [1, 1], [99, 0], [99, 1]]) {
        const findings = ['broken', 'degraded'].map((impact, i) => ({ ...publishableFinding(impact), ...(i === taintedIndex ? { [field]: secret } : {}) }));
        const { result, writes, scrub } = await publishSaved(findings, round);
        expect(result.status).toBe('applied');
        expect(writes.length).toBeGreaterThan(0);
        const published = JSON.stringify(writes);
        expect(published).not.toContain(secret);
        for (const text of ['two writers race', 'both writers enter', 'demonstrated break', 'scripts/example.mjs', 'edge-case']) {
          expect(published).not.toContain(text);
        }
        expect(scrub(published)).toEqual([]);
        const bothBroken = field === 'impactIfUnfixed' && taintedIndex === 1;
        expect(result.plan.sendBack.length).toBe(bothBroken ? 2 : 1);
        expect(published).toContain('confirmed break(s)');
        // An unknown impact remains broken (fail closed), even when its text is withheld.
        if (round === 1) expect(writes.find(w => w.body?.includes('sent back to the fixer.**')).body).toContain('broken');
        const card = writes.find(w => w.digest);
        if (!bothBroken) {
          expect(card.digest).toContain('degraded');
          expect(card.scope).toBe('');
        }
      }
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
    const held = comments => {
      const disposition = readRedTeamDisposition({ comments, pr, head, savedResult: read(env) });
      return [...disposition.held, ...disposition.sendBack];
    };
    expect(held([cap, cleared])).toEqual([]);
    expect(held([cleared, cap])).toHaveLength(1);
    expect(held([cap, { ...cleared, author: { login: 'attacker' } }])).toHaveLength(1);
    expect(held([{ ...cap, createdAt: undefined }, cleared])).toHaveLength(1);
    expect(held([cap, { ...cleared, createdAt: '2026-10-17T09:00:00Z' }])).toHaveLength(1);
  });
  it('binds gate dedup and recorded actions to the saved result, including when its text is scrubbed', async () => {
    const secret = ['ghp_', 'Ab3dEf4hIj5lMn6pQr7tUv8xYz9bCd0fGh1j'].join('');
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken', summary: secret }];
    const { env } = fixture([row({ findings, confirmedMissCount: 1 })]);
    const { readSavedRedTeamResult } = await import('../drain-saved-red-team.mjs');
    const saved = readSavedRedTeamResult({ repo, pr, head, env });
    const comments = [];
    const io = {
      readPr: () => ({ headRefOid: head, comments, labels: [] }), readHead: () => head,
      readSavedResult: () => saved, readSetting: () => ({ value: { broken: 'card' } }),
      fileCard: () => ({ ok: true }),
      postComment: ({ body }) => comments.push({ author: { login: 'web-everything' }, body }), log: () => {},
    };
    expect((await applyRedTeamGate({ repo, pr }, io)).status).toBe('applied');
    expect(comments[0].body).toContain(`result=${redTeamResultId(saved)}`);
    expect(comments[0].body).not.toContain(secret);
    expect((await applyRedTeamGate({ repo, pr }, io)).status).toBe('already-acted');
    // Main's recorded per-finding action wins over today's send-back policy for saved evidence too.
    expect(readRedTeamDisposition({ comments, pr, head, savedResult: saved, setting: { broken: 'send-back' } }).sendBack).toEqual([]);
    writeFileSync(resolveScorecardStorePath(env), JSON.stringify({ version: 1,
      records: [row({ findings: [{ ...findings[0], summary: 'a newer break' }], confirmedMissCount: 1 })] }));
    saveProvenanceFixtures(env);
    expect(readRedTeamDisposition({ comments, pr, head, savedResult: read(env), setting: { broken: 'send-back' } }).sendBack).toHaveLength(1);
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
    expect(read({ platform: { drainReadsSavedResult: false } })).toMatchObject({ value: { drainReadsSavedResult: false }, sources: { drainReadsSavedResult: 'platform' } });
    expect(read({ platform: { drainReadsSavedResult: true }, tool: { drainReadsSavedResult: false } })).toMatchObject({ value: { drainReadsSavedResult: false }, sources: { drainReadsSavedResult: 'tool' } });
    expect(read({ platform: { drainReadsSavedResult: false }, tool: { drainReadsSavedResult: true } })).toMatchObject({ value: { drainReadsSavedResult: true }, sources: { drainReadsSavedResult: 'tool' } });
    const r = read({ tool: { drainReadsSavedResult: true }, env: { WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'off' } });
    expect(r.value.drainReadsSavedResult).toBe(false); expect(r.sources.drainReadsSavedResult).toBe('env');
    expect(read({ tool: { drainReadsSavedResult: 'false' } }).value.drainReadsSavedResult).toBe(true);
  });
});
