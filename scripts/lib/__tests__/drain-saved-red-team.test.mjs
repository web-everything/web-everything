// @vitest-environment node
import { beforeEach as beforeTimingFixture, afterEach as afterTimingFixture, vi as timingFixture } from 'vitest';
beforeTimingFixture(() => timingFixture.stubEnv('WE_RED_TEAM_TIMING', 'post-accept'));
afterTimingFixture(() => timingFixture.unstubAllEnvs());
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { postAcceptRedTeamOwed, redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { applyRedTeamGate } from '../../operations/red-team-gate-apply.mjs';
import { redTeamGateMarker, redTeamResultId } from '../red-team-gate.mjs';
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
  const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
  saveProvenanceFixtures(env);
  return { env, path };
}
const hold = (env, over = {}) => redTeamEnqueueHold({ repo, pr, head, comments: [], env, scheduled: true,
  loopPayload: { verdict: { verdict: 'accept' } }, ...over });

describe('saved red-team admission', () => {
  it('panel-seat timing honors the saved-result reader off switch', async () => {
    const { readSavedRedTeamResult } = await import('../drain-saved-red-team.mjs');
    const env = { ...fixture([row()]).env, WE_RED_TEAM_TIMING: 'panel-seat', WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'false' };
    expect(readSavedRedTeamResult({ repo, pr, head, env, log: () => {} })).toBeNull();
  });

  it('saved clean result releases the hold without a posted comment', () => {
    expect(hold(fixture([row()]).env)).toBeNull();
  });
  it('saved result with a confirmed break still holds', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken', summary: 'break' }];
    expect(hold(fixture([row({ findings, confirmedMissCount: 1 })]).env)).toMatch(/requiring send-back/);
  });
  it('no saved result keeps the hold', () => expect(hold(fixture([]).env)).toMatch(/no recorded result/));
  it.each(['pending', 'error', undefined])('incomplete saved re-check refuses admission: %s', recheckStatus => {
    for (const findings of [[], [{ confirmedByRecheck: false, summary: 'unverified' }]]) {
      const { env } = fixture([row({ recheckStatus, findings })]);
      expect(hold(env)).toMatch(/saved red-team re-check incomplete/);
    }
  });
  it('incomplete saved re-check with a confirmed break still refuses admission', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken' }, { confirmedByRecheck: false }];
    expect(hold(fixture([row({ recheckStatus: 'pending', findings, confirmedMissCount: 1 })]).env)).toMatch(/requiring send-back/);
  });
  it.each(['pending', 'error', undefined])('incomplete saved re-check holds every confirmed impact class: %s', recheckStatus => {
    for (const impactIfUnfixed of ['broken', 'degraded', 'unconfirmed', undefined]) {
      const findings = [{ confirmedByRecheck: true, impactIfUnfixed }, { confirmedByRecheck: false }];
      const { env } = fixture([row({ recheckStatus, findings, confirmedMissCount: 1 })]);
      expect(hold(env)).toMatch(/requiring send-back|saved red-team re-check incomplete/);
      expect(hold(env, { confirmedBreaks: { broken: 'card', degraded: 'card', unconfirmed: 'advisory' } }))
        .toMatch(/saved red-team re-check incomplete/);
    }
  });
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
    const scrub = text => scrubPublish(text.replaceAll(` result=${resultId} -->`, ' -->'));
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
    expect(hold(env, { comments: [cap, cleared] })).toBeNull();
    expect(hold(env, { comments: [cleared, cap] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [cap, { ...cleared, author: { login: 'attacker' } }] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [{ ...cap, createdAt: undefined }, cleared] })).toMatch(/requiring send-back/);
    expect(hold(env, { comments: [cap, { ...cleared, createdAt: '2026-10-17T09:00:00Z' }] })).toMatch(/requiring send-back/);
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
    expect(hold(env, { comments, confirmedBreaks: { broken: 'send-back' } })).toBeNull();
    writeFileSync(resolveScorecardStorePath(env), JSON.stringify({ version: 1,
      records: [row({ findings: [{ ...findings[0], summary: 'a newer break' }], confirmedMissCount: 1 })] }));
    saveProvenanceFixtures(env);
    expect(hold(env, { comments, confirmedBreaks: { broken: 'send-back' } })).toMatch(/requiring send-back/);
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


describe('card-only red-team obligation', () => {
  const payload = read => ({ verdict: { verdict: 'accept' }, findings: { read } });
  const card = { netChangedFiles: ['backlog/6206-card.md'] };
  it('owes no pass for card-only with skipCardOnly on', () => {
    expect(postAcceptRedTeamOwed(payload(card), { WE_RED_TEAM_SKIP_CARD_ONLY: 'on' }, { scheduled: true })).toBe(false);
  });
  it('still owes a pass with skipCardOnly off', () => {
    expect(postAcceptRedTeamOwed(payload(card), { WE_RED_TEAM_SKIP_CARD_ONLY: 'off' }, { scheduled: true })).toBe(true);
  });
  it.each([
    { netChangedFiles: ['scripts/code.mjs'] },
    { ...card, netRenameSources: ['scripts/code.mjs'] },
    { ...card, netRenameSources: 'unknown' },
    { netChangedFiles: [] }, {},
  ])('still owes a pass for code or unknown files: %j', read => {
    expect(postAcceptRedTeamOwed(payload(read), { WE_RED_TEAM_SKIP_CARD_ONLY: 'on' }, { scheduled: true })).toBe(true);
  });
  it('card-only exemption cannot waive a saved confirmed break', () => {
    const findings = [{ confirmedByRecheck: true, impactIfUnfixed: 'broken' }];
    const { env } = fixture([row({ findings, confirmedMissCount: 1 })]);
    expect(hold({ ...env, WE_RED_TEAM_SKIP_CARD_ONLY: 'on' }, { loopPayload: payload(card) })).toMatch(/requiring send-back/);
  });
});

describe('saved round-cap break: RULING NEEDED and the clear-human ruling (PR #5551 red team)', () => {
  const setting = { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' };
  const broken = { confirmedByRecheck: true, impactIfUnfixed: 'broken', category: 'edge-case',
    file: 'scripts/example.mjs', line: 3, summary: 'two writers race' };
  const cleared = at => ({ author: { login: 'web-everything' }, createdAt: at, body: [
    '✅ review — `review:human` cleared via the sanctioned path', '',
    'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
    buildReviewedShaMarker(head), buildClearedHumanMarker('operator'),
  ].join('\n') });
  async function roundCapped(findings = [broken]) {
    const { env } = fixture([row({ findings, confirmedMissCount: findings.length, scoredAt: '2026-10-17T10:00:00Z' })]);
    const { readSavedRedTeamResult } = await import('../drain-saved-red-team.mjs');
    const comments = [];
    const result = await applyRedTeamGate({ repo, pr }, {
      readPr: () => ({ headRefOid: head, comments, labels: ['review:accepted'] }), readHead: () => head,
      readSavedResult: args => readSavedRedTeamResult({ ...args, env }), readSetting: () => ({ value: setting }),
      readRound: () => 99, log: () => {},
      postComment: ({ body }) => comments.push({ author: { login: 'web-everything' }, createdAt: '2026-10-17T10:01:00Z', body }),
    });
    expect(result.outcome).toBe('round-cap');
    const subject = { number: pr, title: 't', headRefOid: head, labels: ['review:accepted'], comments };
    return { env, comments, subject, readSaved: () => readSavedRedTeamResult({ repo, pr, head, env }) };
  }
  it('lists the saved held break as RULING NEEDED and lets clear-human record the not-real ruling', async () => {
    const { env, comments, subject, readSaved } = await roundCapped();
    const { redTeamRulingRow } = await import('../../operations/operator-queue.mjs');
    const { decideSetLabel } = await import('../../review-set-label.mjs');
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    const ruling = redTeamRulingRow(repo, subject, setting, { readSaved });
    expect(ruling?.findings).toEqual([{ file: 'scripts/example.mjs', line: 3, summary: 'two writers race', reason: 'red-team-round-cap' }]);
    expect(ruling.commands.notReal).toContain('--to=clear-human');
    expect(decideSetLabel({ to: 'clear-human', currentLabels: ['review:accepted'], redTeamRulingHold: ruling !== null }))
      .toMatchObject({ allowed: true });
    comments.push(cleared('2026-10-17T10:02:00Z'));
    expect(redTeamRulingNeeded(subject, setting, { readSaved })).toBeNull();
    expect(hold(env, { comments, confirmedBreaks: setting })).toBeNull();
  });
  it('posting an already-ruled saved result with an identical result id does not reinstate the operator hold', async () => {
    const { env, comments, subject, readSaved } = await roundCapped();
    const { redTeamRulingNeeded, redTeamMarker, parseRedTeamComment } = await import('../red-team-gate.mjs');
    const posted = summary => ({ author: { login: 'web-everything' }, createdAt: '2026-10-17T10:05:00Z', body: [
      redTeamMarker(pr, head), '', `1. [**confirmed**] (edge-case, broken) \`scripts/example.mjs:3\` — ${summary}`,
    ].join('\n') });
    expect(redTeamResultId(parseRedTeamComment(posted('two writers race').body))).toBe(redTeamResultId(readSaved()));
    comments.push(cleared('2026-10-17T10:02:00Z'));
    for (const shape of [c => c, c => ({ user: { login: c.author.login }, created_at: c.createdAt, body: c.body })]) {
      const thread = [...comments, posted('two writers race')].map(shape);
      expect(redTeamRulingNeeded({ ...subject, comments: thread }, setting, { readSaved })).toBeNull();
      expect(hold(env, { comments: thread, confirmedBreaks: setting })).toBeNull();
      // A different result posted after the ruling is a new decision: it is not covered by the ruling.
      const other = [...comments, posted('a different break')].map(shape);
      expect(hold(env, { comments: other, confirmedBreaks: setting })).toMatch(/requiring send-back/);
    }
  });
  it('releases on the drain\'s REST thread shape (user.login, created_at) exactly as on the GraphQL shape', async () => {
    const { env, comments, subject, readSaved } = await roundCapped();
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    const rest = c => ({ user: { login: c.author.login }, created_at: c.createdAt, body: c.body });
    const restSubject = { ...subject, comments: comments.map(rest) };
    expect(redTeamRulingNeeded(restSubject, setting, { readSaved })?.since).toBe('2026-10-17T10:01:00Z');
    expect(hold(env, { comments: restSubject.comments, confirmedBreaks: setting })).toMatch(/requiring send-back/);
    const thread = [...comments, cleared('2026-10-17T10:02:00Z')].map(rest);
    expect(redTeamRulingNeeded({ ...subject, comments: thread }, setting, { readSaved })).toBeNull();
    expect(hold(env, { comments: thread, confirmedBreaks: setting })).toBeNull();
    // An early ruling still does not release it in REST shape.
    const early = [...comments, cleared('2026-10-17T09:00:00Z')].map(rest);
    expect(hold(env, { comments: early, confirmedBreaks: setting })).toMatch(/requiring send-back/);
  });
  it('reads no saved evidence for a thread with no gate record on the live head', async () => {
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    const readSaved = vi.fn(() => { throw new Error('must not be read'); });
    expect(redTeamRulingNeeded({ number: pr, headRefOid: head, labels: ['review:accepted'], comments: [] }, setting, { readSaved })).toBeNull();
    expect(readSaved).not.toHaveBeenCalled();
  });
  it('shares one fallback across callers, matching the repo slug case-insensitively', async () => {
    const { env, subject } = await roundCapped();
    const { savedRedTeamFallback } = await import('../drain-saved-red-team.mjs');
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    for (const slug of [repo, repo.toLowerCase(), repo.toUpperCase()]) {
      const readSaved = savedRedTeamFallback({ repo: slug, pr, head: head.toUpperCase(), env });
      expect(redTeamRulingNeeded(subject, setting, { readSaved })?.findings).toHaveLength(1);
    }
    expect(redTeamRulingNeeded(subject, setting, { readSaved: savedRedTeamFallback({ repo: 'other/repo', pr, head, env }) })).toBeNull();
    // Comment-only callers keep their old behaviour.
    expect(redTeamRulingNeeded(subject, setting)).toBeNull();
  });
  it('keeps the saved hold against an untrusted, early or mistimed clearance, and while the fixer owns it', async () => {
    const { env, comments, subject, readSaved } = await roundCapped();
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    for (const bad of [{ ...cleared('2026-10-17T10:02:00Z'), author: { login: 'attacker' } }, cleared('2026-10-17T09:00:00Z')]) {
      const thread = [...comments, bad];
      expect(redTeamRulingNeeded({ ...subject, comments: thread }, setting, { readSaved })?.findings).toHaveLength(1);
      expect(hold(env, { comments: thread, confirmedBreaks: setting })).toMatch(/requiring send-back/);
    }
    expect(redTeamRulingNeeded({ ...subject, labels: ['review:changes'] }, setting, { readSaved })).toBeNull();
  });
  it('withholds saved held finding text that fails the secret scrub from the RULING NEEDED row', async () => {
    const secret = ['ghp_', 'Ab3dEf4hIj5lMn6pQr7tUv8xYz9bCd0fGh1j'].join('');
    const wide = [...secret].map(c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    for (const tainted of [{ summary: secret }, { file: secret }, { failure_scenario: secret }, { summary: wide }]) {
      const { subject, readSaved } = await roundCapped([{ ...broken, ...tainted }]);
      const { redTeamRulingRow } = await import('../../operations/operator-queue.mjs');
      const ruling = redTeamRulingRow(repo, subject, setting, { readSaved });
      expect(ruling.findings).toEqual([{ file: null, line: null, summary: '[finding text withheld: failed the secret scrub]', reason: 'red-team-round-cap' }]);
      expect(JSON.stringify(ruling)).not.toContain(secret);
      expect(JSON.stringify(ruling)).not.toContain(wide);
    }
  });
  it('surfaces unreadable saved evidence to the caller instead of reporting no ruling', async () => {
    const { subject, env } = await roundCapped();
    writeFileSync(resolveScorecardStorePath(env), '{truncated');
    const { savedRedTeamFallback } = await import('../drain-saved-red-team.mjs');
    const { redTeamRulingNeeded } = await import('../red-team-gate.mjs');
    expect(() => redTeamRulingNeeded(subject, setting, { readSaved: savedRedTeamFallback({ repo, pr, head, env }) })).toThrow(/malformed/);
  });
});
