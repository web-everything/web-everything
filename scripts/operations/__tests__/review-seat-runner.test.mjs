/**
 * Card 84 — agy review seats: the settings, the shadow recording + agreement report, and void-on-escape.
 * Every test here is red on the code before card 84 (none of these modules existed).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_SEAT_PLATFORM_DEFAULT, settingsFromRoutingPolicy, loadReviewSeatSettings, seatProviderDirective,
} from '../../lib/review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from '../../lib/dispatch-routing-policy.mjs';
import { runSeatWithProvider } from '../review-seat-runner.mjs';
import {
  compareShadowAnswers, summarizeShadowAgreement, renderShadowReport, appendShadowRow, readShadowRows,
} from '../../lib/review-shadow-agreement.mjs';
import { runAgyReviewJuror, stateChangingToolCalls, changedCheckouts, escapingSymlinks } from '../../lib/agy-review-juror.mjs';
import { judgeOutcome, unwrapJudgeOutcome, createDefaultJudge } from '../cli-adapter.mjs';
import { existsSync } from 'node:fs';
import { buildAntigravityPrompt, ANTIGRAVITY_TOOL_FREE_CORRECTION, antigravityJudgeSpawn } from '../../lib/antigravity-judge-spawn.mjs';

const FINDING = { summary: 'the guard is inverted so every caller passes', file: 'scripts/x.mjs', line: 10, disposition: 'blocker' };
const OTHER = { summary: 'a log line leaks the token value', file: 'scripts/y.mjs', line: 3, disposition: 'blocker' };
const REQUEST = { mandate: 'judge correctness', input: 'the diff', shape: { type: 'object' }, lens: 'correctness', runId: 'run-1', allowedTools: ['Read'] };
const io = (extra) => ({ unwrap: unwrapJudgeOutcome, wrap: judgeOutcome, cwd: '/lanes/review-lane', ...extra });

describe('settings — review.seatProvider.<lens> comes from the routing policy (one source)', () => {
  const withEntries = (entries) => validateRoutingPolicy({ ...structuredClone(DEFAULT_ROUTING_POLICY), operations: { ...structuredClone(DEFAULT_ROUTING_POLICY.operations), ...entries } });
  const strip = () => {
    const ops = structuredClone(DEFAULT_ROUTING_POLICY.operations);
    for (const k of Object.keys(ops)) if (k.startsWith('review-seat:mandatory:') || k.startsWith('review-seat:advisory:')) delete ops[k];
    return validateRoutingPolicy({ ...structuredClone(DEFAULT_ROUTING_POLICY), operations: ops });
  };
  const agy = (extra = {}) => ({ provider: 'agy-claude', model: 'opus-5-5', effort: { 'agy-claude': 'high', claude: 'high' }, fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }], ...extra });

  it('no review-seat entries is the platform flavor: Claude on every seat, no agy seat', () => {
    const s = settingsFromRoutingPolicy(strip());
    expect(s).toEqual({ ...REVIEW_SEAT_PLATFORM_DEFAULT, seatProvider: { correctness: 'claude', security: 'claude' }, seatModel: {} });
    expect(seatProviderDirective(s, 'correctness')).toBeNull();
  });

  it('an agy entry is agy, an agy entry with mode shadow is shadow, a claude entry is claude', () => {
    const s = settingsFromRoutingPolicy(withEntries({
      'review-seat:mandatory:correctness': agy({ mode: 'shadow' }),
      'review-seat:mandatory:security': agy(),
    }));
    expect(s.seatProvider).toEqual({ correctness: 'shadow', security: 'agy' });
    expect(seatProviderDirective(s, 'security')).toEqual({ mode: 'agy', model: 'claude-opus-5-5-high', onEscape: 'claude' });
    const c = settingsFromRoutingPolicy(withEntries({ 'review-seat:mandatory:correctness': { provider: 'claude', model: 'sonnet', fallback: [] } }));
    expect(c.seatProvider.correctness).toBe('claude');
  });

  it('the shipped routing policy: correctness and security in shadow on claude-opus-5-5-high, the advisory agy seat on', () => {
    const s = loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY });
    expect(s.seatProvider).toEqual({ correctness: 'shadow', security: 'shadow' });
    expect(s.seatModel).toEqual({ correctness: 'claude-opus-5-5-high', security: 'claude-opus-5-5-high' });
    expect(s.agyCorrectnessAdvisory).toBe(true);
    expect(s.agyModel).toBe('claude-opus-5-5-high');
  });

  it('the policy refuses a shadow with no Claude route to count, and an unknown mode', () => {
    expect(() => withEntries({ 'review-seat:mandatory:correctness': agy({ mode: 'shadow', fallback: [] }) })).toThrow(/claude route in fallback/);
    expect(() => withEntries({ 'review-seat:mandatory:correctness': agy({ mode: 'replace' }) })).toThrow(/mode must be "shadow"/);
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
      expect(r.reasons.join('\n')).toContain('change outside the juror lane: the review lane');
      expect(r.reasons.join('\n')).not.toContain(fx.root); // no local paths in a reason that can reach the PR
      const r2 = await run(fx, { act: () => writeFileSync(join(fx.other, 'math.mjs'), 'tampered too\n') });
      expect(r2.status).toBe('voided');
      expect(r2.reasons.join('\n')).toContain('change outside the juror lane: this checkout');
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
    expect(changedCheckouts({ '/a': { head: 'h', status: '' }, '/b': { unreadable: 'x' } }, { '/a': { head: 'h', status: ' M f' }, '/b': { head: 'h', status: '' } })).toEqual(['/a', '/b']); // unreadable before = check could not run = void
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
      { lens: 'correctness', runs: 3, compared: 2, voided: 1, failed: 0, held: 0, verdictAgreement: 0.5, meanFindingOverlap: 0.75, prs: 2 },
      { lens: 'security', runs: 1, compared: 0, voided: 0, failed: 1, held: 0, verdictAgreement: null, meanFindingOverlap: null, prs: 1 },
    ]);
    expect(renderShadowReport(summary).join('\n')).toContain('correctness: 3 run(s) on 2 PR(s) — 2 compared, 1 voided');
  });

  it('counts an agy quota hold or exhaustion as held, not failed; other failures and voids stay as they are', () => {
    const hold = { status: 'failed', reasons: ['antigravity: skip-quota-hold; requested m; reported unknown; quota reset X'] };
    const spent = { status: 'failed', reasons: ['antigravity: skip-quota-exhausted; requested m; reported m; quota reset X'] };
    const [s] = summarizeShadowAgreement([hold, spent, { status: 'failed', reasons: ['tool use'] }, { status: 'voided', reasons: ['antigravity: skip-quota-hold'] }]
      .map((r) => ({ lens: 'security', pr: 1, repo: 'o/r', ...r })));
    expect(s).toMatchObject({ runs: 4, held: 2, failed: 1, voided: 1, compared: 0 });
    expect(renderShadowReport([s]).join('\n')).toContain('1 failed, 2 held (agy quota)');
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
    expect(readOnly).toContain('use ONLY these tools');
    expect(readOnly).toContain('"/tmp/juror"');
    expect(readOnly).toContain('Never write');
    expect(readOnly).not.toContain(ANTIGRAVITY_TOOL_FREE_CORRECTION);
    expect(buildAntigravityPrompt('M', 'I')).toContain(ANTIGRAVITY_TOOL_FREE_CORRECTION);
  });

  it('refuses a read-cwd juror with no checkout of its own, and an unknown tool policy', async () => {
    await expect(antigravityJudgeSpawn({ mandate: 'm', input: 'i', shape: {}, toolPolicy: 'read-cwd' })).rejects.toThrow(/own checkout/);
    await expect(antigravityJudgeSpawn({ mandate: 'm', input: 'i', shape: {}, toolPolicy: 'write' })).rejects.toThrow(/none\|read-cwd/);
  });
});

describe('PR #4131 review fixes', () => {
  it('createDefaultJudge routes a seatProvider request to the seat runner with the lane cwd; a plain request never reaches it', async () => {
    const providerCalls = [];
    const agyCalls = [];
    const provider = async (r) => { providerCalls.push(r); return { value: { summary: 'claude', findings: [] }, sessionId: 'claude-s' }; };
    const seatRunner = (request, ioArg) => runSeatWithProvider(request, {
      ...ioArg, agyJuror: async (o) => { agyCalls.push(o); return { status: 'voided', reasons: ['x'] }; }, appendRow: () => true,
    });
    const judge = createDefaultJudge({ provider, cwd: '/lanes/review-lane', seatRunner });
    // advisory agy seat: voided → skipped; Claude provider never called
    const skipped = unwrapJudgeOutcome(await judge({ ...REQUEST, allowedTools: undefined, lens: 'agy-correctness', seatProvider: { mode: 'agy', model: 'm', onEscape: 'skip' } }));
    expect(skipped.value.skipped).toMatchObject({ provider: 'agy' });
    expect(providerCalls).toHaveLength(0);
    expect(agyCalls[0].laneCwd).toBe('/lanes/review-lane');
    // shadow: Claude provider called once, without the directive
    const shadow = unwrapJudgeOutcome(await judge({ ...REQUEST, seatProvider: { mode: 'shadow', model: 'm' } }));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].seatProvider).toBeUndefined();
    expect(shadow.value.shadow.status).toBe('voided');
    // plain request: straight to the provider, no agy
    await judge(REQUEST);
    expect(providerCalls).toHaveLength(2);
    expect(agyCalls).toHaveLength(2);
  });

  it('a real finish call (a tool step re-reported as a `finish` step with no name) is NOT a state-changing call', () => {
    // Shape from a live agy 1.3.0 transcript: ACTIVE tool step, then the same index as a DONE `finish` step.
    expect(stateChangingToolCalls(transcriptWith([
      { step_index: 0, step_type: 'user_input', state: 'DONE' },
      { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'finish', tool_info: { name: 'finish', parameters: { Result: '{}' } } },
      { step_index: 2, step_type: 'finish', state: 'DONE' },
    ]))).toEqual([]);
    // an unlisted tool that changes step_type mid-step is still caught
    expect(stateChangingToolCalls(transcriptWith([
      { step_index: 4, step_type: 'tool', state: 'ACTIVE', tool_name: 'send_command_input' },
      { step_index: 4, step_type: 'command', state: 'DONE' },
    ]))).toEqual(['send_command_input']);
  });

  it('a completed read outside the juror lane voids; a read inside it (or a relative one) does not', () => {
    const call = (p) => transcriptWith([{ step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: p } } }]);
    const roots = { allowedRoots: ['/var/folders/x/we-agy-juror-abc'] };
    expect(stateChangingToolCalls(call('/var/folders/x/we-agy-juror-abc/scripts/a.mjs'), roots)).toEqual([]);
    expect(stateChangingToolCalls(call('scripts/a.mjs'), roots)).toEqual([]);
    expect(stateChangingToolCalls(call('/Users/someone/.ssh/id_ed25519'), roots)).toEqual(['view_file (read outside the juror lane)']);
    expect(stateChangingToolCalls(call('/var/folders/x/we-agy-juror-abc/../../secret'), roots)).toEqual(['view_file (read outside the juror lane)']);
    expect(stateChangingToolCalls(call('/var/folders/x/we-agy-juror-abcd/a'), roots)).toEqual(['view_file (read outside the juror lane)']);
  });

  describe('the read-path guard canonicalizes every path-like parameter against the juror lane (PR #4131 round 3)', () => {
    // A real lane with a committed-looking symlink that leaves it, one that stays inside, and a secret outside.
    const withLane = (fn) => {
      const base = mkdtempSync(join(tmpdir(), 'we-guard-'));
      try {
        const lane = join(base, 'lane');
        const outside = join(base, 'outside');
        mkdirSync(join(lane, 'scripts'), { recursive: true });
        mkdirSync(outside);
        writeFileSync(join(lane, 'scripts', 'a.mjs'), 'x\n');
        writeFileSync(join(outside, 'secret'), 'top secret\n');
        symlinkSync(outside, join(lane, 'link-out'));
        symlinkSync(join(lane, 'scripts'), join(lane, 'link-in'));
        fn({ lane, roots: { allowedRoots: [lane, realpathSync(lane)] } });
      } finally { rmSync(base, { recursive: true, force: true }); }
    };
    const read = (params, tool = 'view_file') => transcriptWith([{ step_index: 1, step_type: 'tool', state: 'DONE', tool_name: tool, tool_info: { parameters: params } }]);
    const OUT = (tool = 'view_file') => [`${tool} (read outside the juror lane)`];

    it('a relative path is resolved against the juror lane, so `..` traversal voids and a plain relative path does not', () => {
      withLane(({ roots }) => {
        expect(stateChangingToolCalls(read({ AbsolutePath: 'scripts/a.mjs' }), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ AbsolutePath: './scripts/a.mjs' }), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ DirectoryPath: '.' }), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ AbsolutePath: '../../.ssh/id_ed25519' }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: '../outside/secret' }), roots)).toEqual(OUT());
        // a `..` segment is never trusted, even one that lexically stays inside (`link-out/..` is NOT the lane)
        expect(stateChangingToolCalls(read({ AbsolutePath: 'scripts/../scripts/a.mjs' }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: 'link-out/../scripts/a.mjs' }), roots)).toEqual(OUT());
      });
    });

    it('a `~` path, a file:// URI and any other URI scheme void', () => {
      withLane(({ roots }) => {
        for (const p of ['~/.ssh/id_ed25519', '~', '~root/x', 'file:///Users/someone/.ssh/id_ed25519', 'https://example.com/a']) {
          expect(stateChangingToolCalls(read({ AbsolutePath: p }), roots), p).toEqual(OUT());
        }
      });
    });

    it('a file:// URI INSIDE the lane is judged as that path', () => {
      withLane(({ lane, roots }) => {
        expect(stateChangingToolCalls(read({ Uri: `file://${join(lane, 'scripts', 'a.mjs')}` }), roots)).toEqual([]);
      });
    });

    it('an array or nested value is checked element by element: ONE outside element voids', () => {
      withLane(({ lane, roots }) => {
        const inside = join(lane, 'scripts', 'a.mjs');
        expect(stateChangingToolCalls(read({ TargetDirectories: [inside, 'scripts'] }, 'codebase_search'), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ TargetDirectories: [inside, '/Users/someone/.ssh'] }, 'codebase_search'), roots)).toEqual(OUT('codebase_search'));
        expect(stateChangingToolCalls(read({ SearchPaths: ['scripts', '../../x'] }, 'grep_search'), roots)).toEqual(OUT('grep_search'));
        expect(stateChangingToolCalls(read({ Target: { FilePath: '/Users/someone/.ssh' } }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: ['~/x'] }), roots)).toEqual(OUT());
      });
    });

    it('a symlink that leaves the lane voids — absolute or relative, existing target or not; one that stays inside does not', () => {
      withLane(({ lane, roots }) => {
        expect(stateChangingToolCalls(read({ AbsolutePath: join(lane, 'link-out', 'secret') }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: 'link-out/secret' }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ DirectoryPath: 'link-out' }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: 'link-out/not-there-yet' }), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(read({ AbsolutePath: 'link-in/a.mjs' }), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ AbsolutePath: 'scripts/not-there-yet.mjs' }), roots)).toEqual([]);
      });
    });

    it('parameters that arrive as a JSON string or an array root are judged too; an unparseable or scalar form voids', () => {
      withLane(({ roots }) => {
        const raw = (parameters) => transcriptWith([{ step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'view_file', tool_info: { parameters } }]);
        expect(stateChangingToolCalls(raw('{"AbsolutePath":"/Users/someone/.ssh/id_ed25519"}'), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(raw('{"AbsolutePath":"scripts/a.mjs"}'), roots)).toEqual([]);
        expect(stateChangingToolCalls(raw(['/Users/someone/.ssh/id_ed25519']), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(raw('not json'), roots)).toEqual(OUT());
        expect(stateChangingToolCalls(raw('"/etc/passwd"'), roots)).toEqual(OUT());
      });
    });

    it('a path under a key the guard does not know is still judged when it can only be a path', () => {
      withLane(({ roots }) => {
        for (const params of [{ Where: '/etc' }, { Base: '~/x' }, { Name: '../../etc/passwd' }, { Url: 'file:///etc/passwd' }, { Includes: ['../../**'] }]) {
          expect(stateChangingToolCalls(read(params, 'find_by_name'), roots), JSON.stringify(params)).toEqual(OUT('find_by_name'));
        }
        // a search query that merely looks absolute but names nothing on disk is not a read of anything
        expect(stateChangingToolCalls(read({ Query: '/api/users/not-a-real-dir-xyz', SearchPath: 'scripts' }, 'grep_search'), roots)).toEqual([]);
        expect(stateChangingToolCalls(read({ Query: 'TODO', Pattern: '*.mjs' }, 'find_by_name'), roots)).toEqual([]);
      });
    });

    it('escapingSymlinks lists committed links that leave the lane — and only those', () => {
      withLane(({ lane }) => {
        mkdirSync(join(lane, '.git'));
        symlinkSync('/etc', join(lane, '.git', 'ignored-link'));
        symlinkSync('/nonexistent-target-xyz', join(lane, 'dangling'));
        mkdirSync(join(lane, 'docs'));
        symlinkSync('/etc/hosts', join(lane, 'docs', 'hosts'));
        expect(escapingSymlinks(lane).sort()).toEqual(['docs/hosts', 'link-out']);
        rmSync(join(lane, 'link-out'));
        rmSync(join(lane, 'docs', 'hosts'));
        expect(escapingSymlinks(lane)).toEqual([]);
      });
    });

    it('a juror lane that holds an escaping symlink voids before any juror runs', async () => {
      const fx = fixtureLane();
      try {
        const git = (...a) => execFileSync('git', a, { cwd: fx.lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        mkdirSync(join(fx.lane, 'docs'));
        symlinkSync('/etc', join(fx.lane, 'docs', 'sys'));
        git('add', '.');
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add a link that leaves the repo');
        let spawned = 0;
        const r = await runAgyReviewJuror({
          request: REQUEST, laneCwd: fx.lane, model: 'claude-opus-5-5-high',
          deps: { repoRoot: fx.other, spawnJudge: async () => { spawned += 1; return { value: { summary: 's', findings: [] } }; } },
        });
        expect(spawned).toBe(0);
        expect(r.status).toBe('voided');
        expect(r.reasons.join('\n')).toContain('docs/sys');
        expect(r.reasons.join('\n')).not.toContain(fx.root);
      } finally { fx.cleanup(); }
    });

    it('a NUL byte in a path, or no allowed root to resolve against, fails closed / is skipped as before', () => {
      withLane(({ roots }) => {
        expect(stateChangingToolCalls(read({ AbsolutePath: 'scripts/a.mjs\0../../x' }), roots)).toEqual(OUT());
      });
      // no roots given (the legacy call shape) leaves the path check off, exactly as before
      expect(stateChangingToolCalls(read({ AbsolutePath: '../../x' }))).toEqual([]);
    });
  });

  it('a further edit to an already-dirty file with a non-ASCII name still voids the seat (status -z, no octal quoting)', async () => {
    const fx = fixtureLane();
    try {
      writeFileSync(join(fx.lane, 'résumé.txt'), 'dirty before the run\n');
      expect((await runWith(fx, null)).status).toBe('ok');
      const r = await runWith(fx, () => writeFileSync(join(fx.lane, 'résumé.txt'), 'edited again\n'));
      expect(r.status).toBe('voided');
    } finally { fx.cleanup(); }
  });

  it('an agy juror that THROWS never leaks a local path into the published skip summary', async () => {
    const out = await runSeatWithProvider({ ...REQUEST, lens: 'agy-correctness', seatProvider: { mode: 'agy', model: 'm', onEscape: 'skip' } }, io({
      claudeJudge: async () => { throw new Error('advisory seat must not spend Claude'); },
      agyJuror: async () => { throw new Error('spawn failed in /lanes/review-lane/.git: ENOENT'); },
    }));
    const { value } = unwrapJudgeOutcome(out);
    expect(value.skipped).toMatchObject({ provider: 'agy' });
    expect(value.summary).toContain('agy seat failed');
    expect(value.summary).not.toContain('/lanes/review-lane');
    expect(value.summary).toContain('<local>');
  });

  it('two agy wordings of one Claude finding count one match, not a perfect overlap', () => {
    const c = compareShadowAnswers({ claude: { findings: [FINDING] }, agy: { findings: [FINDING, { ...FINDING, line: 11 }] } });
    expect(c.overlap).toMatchObject({ matched: 1, agyOnly: 1, claudeOnly: 0, jaccard: 0.5 });
  });

  const runWith = (fx, act, transcript = '') => runAgyReviewJuror({
    request: REQUEST, laneCwd: fx.lane, model: 'm',
    deps: { repoRoot: fx.other, spawnJudge: async ({ cwd }) => {
      const t = join(fx.root, 'transcript.jsonl'); writeFileSync(t, transcript); act?.(cwd);
      return { value: { summary: 's', findings: [] }, sessionId: 'agy-1', transcriptFile: t };
    } },
  });

  it('a further edit to an already-dirty file outside the lane still voids the seat', async () => {
    const fx = fixtureLane();
    try {
      writeFileSync(join(fx.lane, 'math.mjs'), 'dirty before the run\n');
      expect((await runWith(fx, null)).status).toBe('ok');
      const r = await runWith(fx, () => writeFileSync(join(fx.lane, 'math.mjs'), 'edited again\n'));
      expect(r.status).toBe('voided');
      expect(r.reasons.join('\n')).toContain('change outside the juror lane: the review lane');
    } finally { fx.cleanup(); }
  });

  it('a planted core.fsmonitor in a watched checkout voids the seat and is never executed by the check', async () => {
    const fx = fixtureLane();
    try {
      const marker = join(fx.root, 'fsmonitor-ran');
      const r = await runWith(fx, (cwd) => {
        for (const dir of [cwd, fx.lane]) {
          execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', `touch ${marker}`]);
        }
      });
      expect(r.status).toBe('voided');
      expect(r.reasons.join('\n')).toContain('juror lane git config, hooks or attributes changed');
      expect(r.reasons.join('\n')).toContain('git config, hooks or attributes changed outside the juror lane: the review lane');
      expect(existsSync(marker)).toBe(false);
    } finally { fx.cleanup(); }
  });

  it('the transcript check is an allowlist: a network fetch or an unnamed tool voids; reads do not', () => {
    expect(stateChangingToolCalls(transcriptWith([
      { step_type: 'tool', state: 'DONE', tool_name: 'view_file' },
      { step_type: 'tool', state: 'DONE', tool_name: 'list_dir' },
    ]))).toEqual([]);
    expect(stateChangingToolCalls(transcriptWith([{ step_type: 'tool', state: 'DONE', tool_name: 'read_url_content' }]))).toEqual(['read_url_content']);
    expect(stateChangingToolCalls(transcriptWith([{ step_type: 'tool', state: 'DONE' }]))).toEqual(['<unnamed tool>']);
    // a denied call is judged on its LAST update
    expect(stateChangingToolCalls(transcriptWith([
      { step_type: 'tool', step_index: 3, state: 'ACTIVE', tool_name: 'write_to_file' },
      { step_type: 'tool', step_index: 3, state: 'DONE', status: 'TOOL_ERROR', tool_name: 'write_to_file' },
    ]))).toEqual([]);
  });
});

describe('first live shadow run (PR #4133) — the shared checkout\'s own churn is not an escape', () => {
  it('untracked and ignored files appearing in the shared checkout during the run do not void the seat', async () => {
    const fx = fixtureLane();
    try {
      writeFileSync(join(fx.other, '.gitignore'), '.conveyor/\n');
      execFileSync('git', ['-C', fx.other, 'add', '.gitignore']);
      execFileSync('git', ['-C', fx.other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore']);
      const r = await runAgyReviewJuror({
        request: REQUEST, laneCwd: fx.lane, model: 'm',
        deps: { repoRoot: fx.other, spawnJudge: async () => {
          const t = join(fx.root, 't.jsonl'); writeFileSync(t, '');
          execFileSync('mkdir', ['-p', join(fx.other, '.conveyor')]);
          writeFileSync(join(fx.other, '.conveyor', 'daemon.log'), 'a concurrent run logged');
          writeFileSync(join(fx.other, 'backlog-card.md'), 'a concurrent run filed a card');
          return { value: { summary: 's', findings: [] }, sessionId: 'agy-1', transcriptFile: t };
        } },
      });
      expect(r.status).toBe('ok');
    } finally { fx.cleanup(); }
  });

  it('a juror that tried a shell command is voided, and the row keeps why it gave no answer', async () => {
    const fx = fixtureLane();
    try {
      const r = await runAgyReviewJuror({
        request: REQUEST, laneCwd: fx.lane, model: 'm',
        deps: { repoRoot: fx.other, spawnJudge: async () => {
          const t = join(fx.root, 't.jsonl');
          writeFileSync(t, transcriptWith([{ step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } }]));
          const e = new Error('antigravity-judge-spawn: tool denied, no structured_output'); e.telemetry = { transcriptFile: t }; throw e;
        } },
      });
      expect(r.status).toBe('voided');
      expect(r.reasons[0]).toMatch(/run_command/);
      expect(r.reasons.at(-1)).toMatch(/^and the juror gave no answer: .*tool denied/);
    } finally { fx.cleanup(); }
  });

  it('the read-only correction leads and closes the prompt and names the allowed tools', () => {
    const prompt = buildAntigravityPrompt('PANEL MANDATE: run the gate', 'I', { toolPolicy: 'read-cwd', readDir: '/tmp/j' });
    expect(prompt.indexOf('NEVER use run_command')).toBeLessThan(prompt.indexOf('PANEL MANDATE'));
    expect(prompt.lastIndexOf('NEVER use run_command')).toBeGreaterThan(prompt.indexOf('PANEL MANDATE'));
    expect(prompt).toContain('list_dir, view_file, grep_search');
  });
});
