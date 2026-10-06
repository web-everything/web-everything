/**
 * Card 84 — agy review seats: the settings, the shadow recording + agreement report, and void-on-escape.
 * Every test here is red on the code before card 84 (none of these modules existed).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_SEAT_PLATFORM_DEFAULT, resolveReviewSeatSettings, loadReviewSeatSettings, seatProviderDirective,
} from '../../lib/review-seat-provider.mjs';
import { runSeatWithProvider } from '../review-seat-runner.mjs';
import {
  compareShadowAnswers, summarizeShadowAgreement, renderShadowReport, appendShadowRow, readShadowRows,
} from '../../lib/review-shadow-agreement.mjs';
import { runAgyReviewJuror, stateChangingToolCalls, changedCheckouts } from '../../lib/agy-review-juror.mjs';
import { judgeOutcome, unwrapJudgeOutcome } from '../cli-adapter.mjs';
import { buildAntigravityPrompt, ANTIGRAVITY_TOOL_FREE_CORRECTION, antigravityJudgeSpawn } from '../../lib/antigravity-judge-spawn.mjs';

const FINDING = { summary: 'the guard is inverted so every caller passes', file: 'scripts/x.mjs', line: 10, disposition: 'blocker' };
const OTHER = { summary: 'a log line leaks the token value', file: 'scripts/y.mjs', line: 3, disposition: 'blocker' };
const REQUEST = { mandate: 'judge correctness', input: 'the diff', shape: { type: 'object' }, lens: 'correctness', runId: 'run-1', allowedTools: ['Read'] };
const io = (extra) => ({ unwrap: unwrapJudgeOutcome, wrap: judgeOutcome, cwd: '/lanes/review-lane', ...extra });

describe('settings — review.seatProvider.<lens> extends the platform default', () => {
  it('the platform flavor is native: Claude on every seat, no agy seat', () => {
    const s = resolveReviewSeatSettings({});
    expect(s.seatProvider).toEqual({ correctness: 'claude', security: 'claude' });
    expect(s.agyCorrectnessAdvisory).toBe(false);
    expect(s.agyModel).toBe(REVIEW_SEAT_PLATFORM_DEFAULT.review.agyModel);
    expect(seatProviderDirective(s, 'correctness')).toBeNull();
  });

  it('a project layer wins per key (nearest-wins), leaving every other key on the platform value', () => {
    const s = resolveReviewSeatSettings({ extends: ['platform'], review: { seatProvider: { security: 'agy' } } });
    expect(s.seatProvider).toEqual({ correctness: 'claude', security: 'agy' });
    expect(seatProviderDirective(s, 'security')).toEqual({ mode: 'agy', model: 'claude-opus-5-5-high', onEscape: 'claude' });
  });

  it('the shipped project config: correctness and security in shadow, the advisory agy seat on', () => {
    const s = loadReviewSeatSettings();
    expect(s.seatProvider).toEqual({ correctness: 'shadow', security: 'shadow' });
    expect(s.agyCorrectnessAdvisory).toBe(true);
    expect(s.agyModel).toBe('claude-opus-5-5-high');
  });

  it('refuses an unknown provider, an unknown seat, a flag-shaped model and a non-boolean switch', () => {
    expect(() => resolveReviewSeatSettings({ review: { seatProvider: { correctness: 'gemini' } } })).toThrow(/claude\|agy\|shadow/);
    expect(() => resolveReviewSeatSettings({ review: { seatProvider: { simplicity: 'agy' } } })).toThrow(/no such seat/);
    expect(() => resolveReviewSeatSettings({ review: { agyModel: '--yolo' } })).toThrow(/plain model id/);
    expect(() => resolveReviewSeatSettings({ review: { advisorySeats: { agyCorrectness: 'yes' } } })).toThrow(/true or false/);
    expect(() => resolveReviewSeatSettings({ extends: ['elsewhere'] })).toThrow(/extends/);
  });

  it('a missing project file is the platform flavor alone', () => {
    const missing = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
    expect(loadReviewSeatSettings({ read: missing }).seatProvider).toEqual({ correctness: 'claude', security: 'claude' });
  });
});

describe('provider selection — the seat runner', () => {
  it('shadow: the Claude answer is the seat answer; the agy answer and the agreement ride beside it and are appended', async () => {
    const rows = [];
    const calls = [];
    const out = await runSeatWithProvider({ ...REQUEST, seatProvider: { mode: 'shadow', model: 'claude-opus-5-5-high', seat: 'correctness', pr: 7, repo: 'o/r' } }, io({
      claudeJudge: async (r) => { calls.push(['claude', r]); return judgeOutcome({ summary: 'c', findings: [FINDING] }, { sessionId: 'claude-s' }); },
      agyJuror: async (o) => { calls.push(['agy', o]); return { status: 'ok', sessionId: 'agy-s', value: { summary: 'a', findings: [{ ...FINDING, line: 12 }, OTHER] } }; },
      appendRow: (row) => { rows.push(row); return true; },
    }));
    const { value, telemetry } = unwrapJudgeOutcome(out);
    expect(calls.map(([who]) => who)).toEqual(['claude', 'agy']); // one after the other, Claude first
    expect(calls[0][1].seatProvider).toBeUndefined(); // the directive never reaches a provider
    expect(calls[1][1]).toMatchObject({ laneCwd: '/lanes/review-lane', model: 'claude-opus-5-5-high' });
    expect(value.findings).toEqual([FINDING]);
    expect(telemetry.sessionId).toBe('claude-s');
    expect(value.shadow).toMatchObject({ status: 'ok', sessionId: 'agy-s', claudeVerdict: 'changes', agyVerdict: 'changes', verdictAgree: true });
    expect(value.shadow.overlap).toMatchObject({ claudeCount: 1, agyCount: 2, matched: 1, agyOnly: 1, claudeOnly: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lens: 'correctness', pr: 7, provider: 'agy', status: 'ok', agySessionId: 'agy-s', claudeSessionId: 'claude-s' });
    expect(JSON.stringify(rows[0])).not.toContain('the guard is inverted'); // counts and ids, never finding text
  });

  it('shadow: an agy juror that shares the Claude session id is not an independent reviewer — voided', async () => {
    const rows = [];
    const out = await runSeatWithProvider({ ...REQUEST, seatProvider: { mode: 'shadow', model: 'm' } }, io({
      claudeJudge: async () => judgeOutcome({ summary: 'c', findings: [] }, { sessionId: 'same' }),
      agyJuror: async () => ({ status: 'ok', sessionId: 'same', value: { summary: 'a', findings: [] } }),
      appendRow: (row) => { rows.push(row); return true; },
    }));
    expect(unwrapJudgeOutcome(out).value.shadow.status).toBe('voided');
    expect(rows[0].verdictAgree).toBeNull();
  });

  it('agy: a clean agy answer IS the seat answer and the run record says agy judged', async () => {
    let claudeRan = false;
    const out = await runSeatWithProvider({ ...REQUEST, seatProvider: { mode: 'agy', model: 'm', onEscape: 'claude' } }, io({
      claudeJudge: async () => { claudeRan = true; return judgeOutcome({ summary: 'c', findings: [] }); },
      agyJuror: async () => ({ status: 'ok', sessionId: 'agy-1', wallMs: 5, value: { summary: 'a', findings: [OTHER] } }),
    }));
    const { value, telemetry } = unwrapJudgeOutcome(out);
    expect(claudeRan).toBe(false);
    expect(value.findings).toEqual([OTHER]);
    expect(value.seatProvider).toMatchObject({ provider: 'agy', sessionId: 'agy-1' });
    expect(telemetry.sessionId).toBe('agy-1');
  });
});

describe('void-on-escape — the fallback', () => {
  it('agy seat: a voided agy run falls back to Claude for that seat, and says why', async () => {
    const out = await runSeatWithProvider({ ...REQUEST, seatProvider: { mode: 'agy', model: 'm', onEscape: 'claude' } }, io({
      claudeJudge: async () => judgeOutcome({ summary: 'claude judged', findings: [FINDING] }, { sessionId: 'c' }),
      agyJuror: async () => ({ status: 'voided', reasons: ['change outside the juror lane: /lanes/review-lane'], value: { summary: 'x', findings: [] } }),
    }));
    const { value } = unwrapJudgeOutcome(out);
    expect(value.summary).toBe('claude judged');
    expect(value.findings).toEqual([FINDING]);
    expect(value.seatProvider).toEqual({ provider: 'claude', fellBackFrom: { provider: 'agy', model: 'm', status: 'voided', reasons: ['change outside the juror lane: /lanes/review-lane'] } });
  });

  it('advisory agy seat: a voided run is a recorded skip, never a Claude spend', async () => {
    let claudeRan = false;
    const out = await runSeatWithProvider({ ...REQUEST, lens: 'agy-correctness', seatProvider: { mode: 'agy', model: 'm', onEscape: 'skip' } }, io({
      claudeJudge: async () => { claudeRan = true; return judgeOutcome({ summary: 'c', findings: [] }); },
      agyJuror: async () => ({ status: 'voided', reasons: ['juror lane changed on a read-only seat: ?? pwned.txt'] }),
    }));
    const { value } = unwrapJudgeOutcome(out);
    expect(claudeRan).toBe(false);
    expect(value.findings).toEqual([]);
    expect(value.skipped).toMatchObject({ provider: 'agy' });
    expect(value.summary).toMatch(/^skipped: agy seat voided: juror lane changed/);
  });
});

/** A real git checkout to clone from, plus a fake agy that does whatever the test says. */
function fixtureLane() {
  const root = mkdtempSync(join(tmpdir(), 'card84-'));
  const lane = join(root, 'review-lane');
  const git = (...a) => execFileSync('git', a, { cwd: lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('mkdir', ['-p', lane]);
  git('init', '-q');
  writeFileSync(join(lane, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const other = join(root, 'primary');
  execFileSync('git', ['clone', '-q', lane, other]);
  return { root, lane, other, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const transcriptWith = (steps) => steps.map((s) => JSON.stringify({ event: 'step_update', step_update: s })).join('\n');

describe('void-on-escape — the agy juror\'s three escape checks (real git, fake agy)', () => {
  const run = (fx, behave) => runAgyReviewJuror({
    request: REQUEST, laneCwd: fx.lane, model: 'claude-opus-5-5-high',
    deps: {
      repoRoot: fx.other,
      spawnJudge: async ({ cwd, toolPolicy }) => {
        expect(toolPolicy).toBe('read-cwd');
        const t = join(fx.root, 'transcript.jsonl');
        writeFileSync(t, behave.transcript ?? '');
        behave.act?.(cwd);
        return { value: { summary: 's', findings: [{ summary: 'add subtracts', file: join(cwd, 'math.mjs'), line: 1 }] }, sessionId: 'agy-conv-1', transcriptFile: t };
      },
    },
  });

  it('a clean read-only run is ok, and its cited paths come back repo-relative', async () => {
    const fx = fixtureLane();
    try {
      const r = await run(fx, {});
      expect(r.status).toBe('ok');
      expect(r.sessionId).toBe('agy-conv-1');
      expect(r.value.findings[0].file).toBe('math.mjs');
    } finally { fx.cleanup(); }
  });

  it('any change inside its own lane voids a read-only seat', async () => {
    const fx = fixtureLane();
    try {
      const r = await run(fx, { act: (cwd) => writeFileSync(join(cwd, 'pwned.txt'), 'x') });
      expect(r.status).toBe('voided');
      expect(r.value).toBeUndefined();
      expect(r.reasons.join('\n')).toMatch(/juror lane changed on a read-only seat: \?\? pwned\.txt/);
    } finally { fx.cleanup(); }
  });

  it('a change outside its lane (the review lane it was cloned from, or this checkout) voids the seat', async () => {
    const fx = fixtureLane();
    try {
      const r = await run(fx, { act: () => writeFileSync(join(fx.lane, 'math.mjs'), 'tampered\n') });
      expect(r.status).toBe('voided');
      expect(r.reasons.join('\n')).toContain(`change outside the juror lane: ${fx.lane}`);
      const r2 = await run(fx, { act: () => writeFileSync(join(fx.other, 'evil.txt'), 'x') });
      expect(r2.status).toBe('voided');
      expect(r2.reasons.join('\n')).toContain(`change outside the juror lane: ${fx.other}`);
    } finally { fx.cleanup(); }
  });

  it('a completed write tool call anywhere (even an unwatched path) voids the seat; a DENIED one does not', async () => {
    const fx = fixtureLane();
    try {
      const wrote = transcriptWith([{ step_type: 'tool', state: 'DONE', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: '/Users/someone/.bashrc' } } }]);
      const r = await run(fx, { transcript: wrote });
      expect(r.status).toBe('voided');
      expect(r.reasons.join('\n')).toMatch(/completed state-changing tool call\(s\): write_to_file/);
      const denied = transcriptWith([{ step_type: 'tool', state: 'DONE', status: 'TOOL_ERROR', tool_info: { name: 'write_to_file', error: { type: 'TOOL_ERROR' } } }]);
      expect((await run(fx, { transcript: denied })).status).toBe('ok');
    } finally { fx.cleanup(); }
  });

  it('pure helpers: tool-call scan and checkout diff', () => {
    expect(stateChangingToolCalls(transcriptWith([
      { step_type: 'tool', state: 'DONE', tool_name: 'view_file' },
      { step_type: 'tool', state: 'DONE', tool_name: 'run_command' },
    ]))).toEqual(['run_command']);
    expect(changedCheckouts({ '/a': { head: 'h', status: '' }, '/b': { unreadable: 'x' } }, { '/a': { head: 'h', status: ' M f' }, '/b': { head: 'h', status: '' } })).toEqual(['/a']);
  });
});

describe('the agreement report (#76a identity, #76b sameAs through the PR table)', () => {
  it('verdict + finding overlap: an exact match, a moved line with the same claim, and a disjoint finding', () => {
    expect(compareShadowAnswers({ claude: { findings: [] }, agy: { findings: [] } })).toMatchObject({ verdictAgree: true, overlap: { jaccard: 1 } });
    const c = compareShadowAnswers({ claude: { findings: [FINDING] }, agy: { findings: [{ ...FINDING, line: 40 }] } });
    expect(c.overlap).toMatchObject({ matched: 1, jaccard: 1 });
    const d = compareShadowAnswers({ claude: { findings: [FINDING] }, agy: { findings: [OTHER] } });
    expect(d.overlap).toMatchObject({ matched: 0, claudeOnly: 1, agyOnly: 1, jaccard: 0 });
    expect(compareShadowAnswers({ claude: { findings: [FINDING] }, agy: null })).toMatchObject({ agyVerdict: null, verdictAgree: null, overlap: null });
  });

  it('two different wordings bound to one PR finding id (a declared sameAs form) count as the same finding', () => {
    const reworded = { ...FINDING, summary: 'callers bypass the check because the condition is negated' };
    expect(compareShadowAnswers({ claude: { findings: [FINDING] }, agy: { findings: [reworded] } }).overlap.matched).toBe(0);
    const prTable = [{ findingId: 'f-0123456789ab', path: 'scripts/x.mjs', lens: 'unknown', normSummary: 'x', anchor: '', heads: ['h'],
      forms: [{ normSummary: 'the guard is inverted so every caller passes', anchor: '' },
        { normSummary: 'callers bypass the check because the condition is negated', anchor: '' }] }];
    expect(compareShadowAnswers({ claude: { findings: [FINDING] }, agy: { findings: [reworded] }, prTable }).overlap.matched).toBe(1);
  });

  it('accumulates per seat: compared, voided and failed runs, verdict agreement and mean overlap', () => {
    const rows = [
      { lens: 'correctness', repo: 'o/r', pr: 1, status: 'ok', verdictAgree: true, overlap: { jaccard: 1 } },
      { lens: 'correctness', repo: 'o/r', pr: 2, status: 'ok', verdictAgree: false, overlap: { jaccard: 0.5 } },
      { lens: 'correctness', repo: 'o/r', pr: 2, status: 'voided', verdictAgree: null, overlap: null },
      { lens: 'security', repo: 'o/r', pr: 1, status: 'failed', verdictAgree: null, overlap: null },
    ];
    const summary = summarizeShadowAgreement(rows);
    expect(summary).toEqual([
      { lens: 'correctness', runs: 3, compared: 2, voided: 1, failed: 0, verdictAgreement: 0.5, meanFindingOverlap: 0.75, prs: 2 },
      { lens: 'security', runs: 1, compared: 0, voided: 0, failed: 1, verdictAgreement: null, meanFindingOverlap: null, prs: 1 },
    ]);
    expect(renderShadowReport(summary).join('\n')).toContain('correctness: 3 run(s) on 2 PR(s) — 2 compared, 1 voided');
  });

  it('appends to and reads back a JSONL store outside the tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card84-store-'));
    try {
      const path = join(dir, 'nested', 'agy-shadow-agreement.jsonl');
      expect(appendShadowRow({ lens: 'security', status: 'ok' }, { path })).toBe(true);
      expect(appendShadowRow({ lens: 'security', status: 'voided' }, { path })).toBe(true);
      expect(readShadowRows({ path }).map((r) => r.status)).toEqual(['ok', 'voided']);
      expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the agy spawn in read-cwd mode', () => {
  it('tells the juror it may read its checkout and must not run or write anything; the default stays tool-free', () => {
    const readOnly = buildAntigravityPrompt('M', 'I', { toolPolicy: 'read-cwd', readDir: '/tmp/juror' });
    expect(readOnly).toContain('You MAY read files');
    expect(readOnly).toContain('"/tmp/juror"');
    expect(readOnly).toContain('may NOT write');
    expect(readOnly).not.toContain(ANTIGRAVITY_TOOL_FREE_CORRECTION);
    expect(buildAntigravityPrompt('M', 'I')).toContain(ANTIGRAVITY_TOOL_FREE_CORRECTION);
  });

  it('refuses a read-cwd juror with no checkout of its own, and an unknown tool policy', async () => {
    await expect(antigravityJudgeSpawn({ mandate: 'm', input: 'i', shape: {}, toolPolicy: 'read-cwd' })).rejects.toThrow(/own checkout/);
    await expect(antigravityJudgeSpawn({ mandate: 'm', input: 'i', shape: {}, toolPolicy: 'write' })).rejects.toThrow(/none\|read-cwd/);
  });
});
