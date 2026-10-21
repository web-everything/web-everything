/**
 * @file review-ruling-resume.test.mjs — card xq1xbsl. A ruling on an unchanged head RESUMES the paused review.
 *
 * Live 2026-10-08. #4361: the operator ruled at 12:09Z and a fresh full review started at 12:15Z, raising two new
 * referrals, so the PR went back to `advisory:ruling-needed` and never reached the operator. #4388: a ruling was
 * followed by round 2 at 12:20Z re-raising a finding the fixer had already fixed (the card's test plan names the test at
 * line 43; the referral cited :29 "no planned regression test"). Both are replayed here. Each test is RED on the code
 * before this card: there was no resume (a ruling always started a new panel), and no round scoping for referrals.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../registry.mjs';
import { createFileRunStore, createMemoryRunStore } from '../run-store.mjs';
import { judgeOutcome } from '../cli-adapter.mjs';
import { rewindRunToStep } from '../engine.mjs';
import { REVIEW_EFFECTS, reviewPrOperation, reviewSeatOptionsForRun } from '../review-pr.mjs';
import { runReviewLoopOnce, defaultFindResumableRun, RESUME_MAX_ATTEMPTS } from '../review-loop-cli.mjs';
import {
  classifyReferralsByRound, findingIdentityTable, REFERRAL_DEMOTED_REASONS, referralFindingKey, normalizeFinding,
  mandatoryReferralReviewer, renderReferralRecord, openReferralHeads, buildOperatorRulingComment,
} from '../../lib/jury-core.mjs';
import { advance, advanceWhileRunning, startRun } from '../engine.mjs';
import { resolveOperation } from '../run.mjs';
import { advanceReviewPrToWriteUp } from '../record-verdict-io.mjs';
import { loadReviewSeatSettings } from '../../lib/review-seat-provider.mjs';
import { REARM_COMMENT_MARKER } from '../../conveyor/rearm-review.mjs';
import { decideReferralHold, enrichPrsWithReferralHolds, findResumableParkedRun, REFERRAL_RETRY_MS, reviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';

const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const CARD = 'backlog/x29vm8a-the-card.md';

// ── #4388: the finding identity table, exactly as the reduce step reads it off the PR thread ─────────────────────────
const raised = { file: CARD, line: 29, summary: 'No planned regression test for the fix', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const recordFor = (head, original, rulings = []) => {
  const key = referralFindingKey('judge', original);
  const reviewer = mandatoryReferralReviewer(`run-${head[0]}`);
  return { version: 1, repo: 'o/n', pr: 4388, head, runId: `run-${head[0]}`, reviewer, authorBody: '', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
    rulings: rulings.map((result, i) => ({ id: `r${i}`, key, reviewerId: reviewer.id, lens: reviewer.lens, result, rationale: 'x', evidence: ['e'] })) };
};
const identityOf = (...records) => findingIdentityTable(records).map(({ findingId, path, lens, normSummary, anchor, forms, heads, activeInstances, rulings }) => ({
  findingId, path, lens, normSummary, anchor, forms, heads, activeInstances, rulings: rulings.map(({ head, result }) => ({ head, result })) }));
const candidate = (original) => ({ seat: 'judge', original });

describe('classifyReferralsByRound — referrals follow the later-round scoping rule (#3999)', () => {
  it('a first sighting on a head with no referrals stays mandatory', () => {
    const out = classifyReferralsByRound([candidate(raised)], { identity: [], head: HEAD_1 });
    expect(out.kept).toHaveLength(1);
    expect(out.demoted).toHaveLength(0);
  });

  it('#4361 replay: a second panel on the SAME head cannot add referrals — new ones are card suggestions, repeats are covered', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
    const reworded = { ...raised, line: 43 };
    const brandNew = { file: 'scripts/lib/pre-pr-review.mjs', line: 9, summary: 'A guard is missing on the empty list', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const out = classifyReferralsByRound([candidate(reworded), candidate(brandNew)], { identity, head: HEAD_1, lens: 'simplicity' });
    expect(out.kept).toEqual([]);
    expect(out.covered.map((c) => c.original)).toEqual([reworded]);
    expect(out.demoted).toEqual([{ candidate: candidate(brandNew), reason: REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD }]);
  });

  it('#4388 replay: a finding ruled block, re-raised after the fixer changed the cited lines, is matched by identity and not re-referred', () => {
    // A source file: the demotion needs positive evidence the cited lines changed (a line window on a source file, as
    // #3999 uses), which a backlog card cannot give. See the next describe for the cases that stay mandatory.
    const cited = { ...raised, file: 'scripts/lib/pre-pr-review.mjs' };
    const identity = identityOf(recordFor(HEAD_1, cited, ['block']));
    const reRaised = { ...cited, line: 43 };
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { [cited.file]: [43] } };
    const out = classifyReferralsByRound([candidate(reRaised)], { identity, head: HEAD_2, latestFix, lens: 'simplicity' });
    expect(out.kept).toEqual([]);
    expect(out.demoted).toEqual([{ candidate: candidate(reRaised), reason: REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE }]);
  });

  // PR #4441 review round 2 (security, CONFIRMED + codex-correctness, CONFIRMED): an edit near the cited line shows the code
  // was touched, not that the defect is gone. A gate lens's block-ruled re-raise therefore stays mandatory after a nearby edit.
  it.each(['correctness', 'security', undefined, ''])('a %j-lens block-ruled re-raise stays mandatory after a nearby (even exact-line) edit', (lens) => {
    const cited = { ...raised, file: 'scripts/lib/pre-pr-review.mjs' };
    const identity = identityOf(recordFor(HEAD_1, cited, ['block']));
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { [cited.file]: [29] } };
    for (const line of [29, 31]) {
      const out = classifyReferralsByRound([candidate({ ...cited, line })], { identity, head: HEAD_2, latestFix, lens });
      expect(out.kept).toEqual([candidate({ ...cited, line })]);
      expect(out.demoted).toEqual([]);
    }
  });

  // PR #4441 review round 2 (correctness): the operator's block ruling (#4979) is a separate comment, folded in by the reader.
  it('an OPERATOR block ruling counts as blocked for an advisory-lens re-raise, like a reviewer block', () => {
    const cited = { ...raised, file: 'scripts/lib/pre-pr-review.mjs' };
    const unruled = identityOf(recordFor(HEAD_1, cited, ['not-real']));
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { [cited.file]: [29] } };
    const run = (identity) => classifyReferralsByRound([candidate(cited)], { identity, head: HEAD_2, latestFix, lens: 'simplicity' });
    expect(run(unruled).kept).toHaveLength(1);                       // not block-ruled: not demoted
    const operatorBlocked = unruled.map((e) => ({ ...e, operatorRulings: [{ head: HEAD_1, result: 'block' }] }));
    expect(run(operatorBlocked).demoted.map((d) => d.reason)).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
    const operatorCard = unruled.map((e) => ({ ...e, operatorRulings: [{ head: HEAD_1, result: 'card' }] }));
    expect(run(operatorCard).kept).toHaveLength(1);
  });

  it('a block-ruled finding re-raised on the SAME head is covered only: its gate lives in the thread record, not in a new referral', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    const out = classifyReferralsByRound([candidate({ ...raised, line: 43 })], { identity, head: HEAD_1 });
    expect(out.covered).toHaveLength(1);
    expect(out.kept).toEqual([]);
    expect(out.demoted).toEqual([]);
  });

  it('a block-ruled finding re-raised when the fixer did NOT touch its file stays mandatory (the ignored-ruling path needs it)', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { 'src/other.mjs': [1] } };
    const out = classifyReferralsByRound([candidate(raised)], { identity, head: HEAD_2, latestFix });
    expect(out.kept).toHaveLength(1);
  });

  it('a push brings a genuinely new finding on a new head: mandatory (new referrals come only from a new push)', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
    const fresh = { file: 'src/z.mjs', line: 2, summary: 'Unrelated crash on empty input', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const out = classifyReferralsByRound([candidate(fresh)], { identity, head: HEAD_2, latestFix: { priorHead: HEAD_1, head: HEAD_2, files: { 'src/z.mjs': [2] } } });
    expect(out.kept).toHaveLength(1);
  });

  it('degrades to the old behaviour on an unreadable fix range or an empty table', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    expect(classifyReferralsByRound([candidate(raised)], { identity, head: HEAD_2, latestFix: { error: 'x' } }).kept).toHaveLength(1);
    expect(classifyReferralsByRound([candidate(raised)]).kept).toHaveLength(1);
  });
});

// ── the engine step that makes "resume" a real thing ─────────────────────────────────────────────────────────────────
const NET_PATHS = ['scripts/operations/review-pr.mjs'];
const stubReader = () => ({ pr, repo }) => ({
  state: 'OPEN', clearerId: undefined, createdAt: '',
  detail: { pr, repo, title: 'a parked PR', url: `https://example.invalid/${pr}`, labels: ['review:human'], humanRequired: true,
    reviewClass: 'human', disposition: { mode: 'converge', autoLand: false }, escalationReason: ['gate-self'],
    advisoryComment: null, humanComment: null, diffStat: NET_PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })) },
  headRefName: 'lane/thing', body: 'the PR description',
  net: { paths: NET_PATHS, base: 'abc123', rev: HEAD_1, scored: true },
  diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
});
const setup = () => {
  // Replay the original two-seat panel, independently of the minimum for new reviews.
  const declaration = reviewPrOperation({ readPr: stubReader(), minNonClaudeSeats: 0 });
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, registry };
};
const REFERRAL_ANSWER = { summary: 'one confirmed defect', findings: [{ summary: 'the guard is inverted', file: NET_PATHS[0], line: 3,
  disposition: 'blocker', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }] };

/** Sinks that record every effect; the referral sink reports `pending` until `ruled.value` flips, as the real one does off the thread. */
function sinksWith({ seen, ruled }) {
  const sinks = Object.fromEntries(Object.values(REVIEW_EFFECTS).map((t) => [t, async (payload) => { seen.push({ type: t, payload }); return { ok: true }; }]));
  sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async (payload) => {
    seen.push({ type: REVIEW_EFFECTS.MANDATORY_REFERRALS, payload });
    return ruled.value ? { records: [], pending: [], blocked: [], pendingFindings: [] }
      : { records: [], pending: ['k1'], blocked: [], pendingFindings: [{ file: NET_PATHS[0], line: 3, seat: 'judgeAdvisory', summary: 'the guard is inverted' }] };
  };
  return sinks;
}

const argv = ['--pr=4361', '--repo=o/n'];

describe('ordinary review-pr CLI resume preserves the saved roster', () => {
  it.each([
    {},
    { codexAdvisory: true },
    { correctnessAdvisory: true },
    { antigravityReview: true },
    { seatSettings: { agyCorrectnessAdvisory: true } },
  ])('reconstructs %j despite changed flags and diversity minimums', async (seats) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-roster-'));
    try {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      const historicalDefault = Object.keys(seats).length === 0;
      vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', historicalDefault || seats.codexAdvisory ? '0' : '1');
      vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', historicalDefault || seats.correctnessAdvisory ? '0' : '1');
      vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', historicalDefault || seats.antigravityReview ? '0' : '1');
      vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '0');
      const declaration = reviewPrOperation({ readPr: stubReader(), minNonClaudeSeats: 0, ...seats });
      const registry = createRegistry();
      registry.register(declaration);
      const store = createFileRunStore();
      const parked = await runReviewLoopOnce({ declaration, registry, argv, store,
        sinks: sinksWith({ seen: [], ruled: { value: true } }),
        makeJudge: () => async () => judgeOutcome({ summary: 'looked', findings: [] }, {}),
        mintRunId: () => 'historical-cli' });
      expect(parked.stopped).toBe('confirm');
      for (const minimum of ['1', '2']) {
        vi.stubEnv('WE_REVIEW_MIN_NON_CLAUDE_SEATS', minimum);
        const resumed = resolveOperation('review-pr', { resumeId: parked.run.id });
        expect(resumed.declaration.steps.map(s => s.name)).toEqual(declaration.steps.map(s => s.name));
        const answered = advance(store.read(parked.run.id), { registry: resumed.registry, resume: { value: 'abstain' } });
        expect(answered.findings.confirm).toBe('abstain');
        expect(answered.cursor).toBe(parked.run.cursor + 1);
        // The second confirmation entry point reaches its existing human-review guard,
        // rather than failing earlier because flags changed its declaration.
        await expect(advanceReviewPrToWriteUp(store.read(parked.run.id), { to: 'accepted', store }))
          .rejects.toThrow(/gate-self: review:human is human-ceremony-only/);
      }
      // Exercise the actual argv-to-registration path too. No answer means no external effects.
      vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
      // Resolve a filesystem path without Vite rewriting a relative new URL as a browser asset.
      const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
      for (const earlierFlags of [[], ['--resume=missing-earlier-run']]) {
        const cli = spawnSync(process.execPath, [cliPath,
          'review-pr', ...earlierFlags, `--resume=${parked.run.id}`, '--json'], {
          encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, WE_DAEMON_MANAGED_CLONE: '1', OPERATION_CALLS_DIR: join(dir, 'calls') },
        });
        expect(cli.error).toBeUndefined();
        expect(cli.status, cli.stdout + cli.stderr).toBe(0);
        expect(cli.stdout + cli.stderr).not.toContain('declaration changed');
        expect(JSON.parse(cli.stdout).pending.step).toBe('confirm');
      }
      // Fresh registrations still enforce the new minimum.
      const fresh = resolveOperation('review-pr');
      expect(fresh.declaration.steps.map(s => s.name)).toContain('judgeAdvisory');
      expect(fresh.declaration.steps.map(s => s.name)).toContain('judgeCorrectnessAdvisory');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([true, false])('keeps future and failed advisory seats in an unfinished panel (security=%s)', async (securitySeat) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-unfinished-'));
    try {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
      vi.stubEnv('WE_REVIEW_MIN_NON_CLAUDE_SEATS', '2');
      const readPr = input => {
        const read = stubReader()(input);
        if (!securitySeat) {
          read.net.paths = ['docs/review.md'];
          read.detail.diffStat = [{ path: 'docs/review.md', additions: 1, deletions: 0 }];
        }
        return read;
      };
      const declaration = reviewPrOperation({ readPr, securitySeat, seatSettings: loadReviewSeatSettings({ log: () => {} }) });
      const registry = createRegistry();
      registry.register(declaration);
      const store = createFileRunStore();
      let run = advanceWhileRunning(startRun({ op: declaration.name, id: 'unfinished', input: { pr: 4361, repo: 'o/n' }, registry }), { registry });
      const visited = [];
      while (run.pending?.kind === 'judge') {
        visited.push(run.pending.step);
        store.write(run);
        const resumed = resolveOperation('review-pr', { resumeId: run.id });
        expect(resumed.declaration.steps.map(s => s.name)).toEqual(declaration.steps.map(s => s.name));
        expect(await advanceReviewPrToWriteUp(run, { to: 'accepted', store })).toBe(run);
        run = advanceWhileRunning(run, { registry: resumed.registry, resume: { value: { summary: 'looked', findings: [] } } });
      }
      expect(visited).toContain('judge');
      expect(visited).toContain('judgeAdvisory');
      expect(visited).toContain('judgeCorrectnessAdvisory');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Drive one unfinished panel to confirm, resolving the registration from the saved record at every judge step.
  const driveUnfinished = async ({ declaration, registry, store, beforeResume = () => {}, strip = false }) => {
    let run = advanceWhileRunning(startRun({ op: declaration.name, id: 'mid-panel', input: { pr: 4361, repo: 'o/n' }, registry }), { registry });
    if (strip) {
      // A run saved before the roster was persisted: its `read` finding names only the security seat.
      const { seatSteps, minNonClaudeSeats, ...read } = run.findings.read;
      run = { ...run, findings: { ...run.findings, read } };
    }
    while (run.pending?.kind === 'judge') {
      store.write(run);
      beforeResume(run.pending.step);
      const resumed = resolveOperation('review-pr', { resumeId: run.id });
      expect(resumed.declaration.steps.map(s => s.name), run.pending.step).toEqual(declaration.steps.map(s => s.name));
      run = advanceWhileRunning(run, { registry: resumed.registry, resume: { value: { summary: 'looked', findings: [] } } });
    }
    return run;
  };

  it('resumes a historical two-seat panel before reduce under the default minimum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-historical-'));
    try {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
      vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '0');
      // The pre-minimum build: the live seat settings, but no Codex seat.
      const declaration = reviewPrOperation({ readPr: stubReader(), minNonClaudeSeats: 0, seatSettings: loadReviewSeatSettings({ log: () => {} }) });
      const registry = createRegistry();
      registry.register(declaration);
      const run = await driveUnfinished({ declaration, registry, store: createFileRunStore(), strip: true });
      expect(run.findings.reduce).toBeTruthy();
      expect(Object.keys(run.findings)).not.toContain('judgeAdvisory');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a historical seat a parallel batch already answered beyond the parked seat', async () => {
    vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', '0');
    vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', '0');
    vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
    try {
      const declaration = reviewPrOperation({ readPr: stubReader(), minNonClaudeSeats: 0, correctnessAdvisory: true });
      const registry = createRegistry();
      registry.register(declaration);
      let run = advanceWhileRunning(startRun({ op: declaration.name, id: 'prefilled', input: { pr: 4361, repo: 'o/n' }, registry }), { registry });
      const { seatSteps, minNonClaudeSeats, ...read } = run.findings.read;
      run = { ...run, findings: { ...run.findings, read },
        prefilledSeats: [{ step: 'judgeCorrectnessAdvisory', stepIndex: 3, value: { summary: 'looked', findings: [] } }] };
      expect(run.pending.step).toBe('judge');
      const seats = reviewSeatOptionsForRun(run, null, { codexAdvisory: false, correctnessAdvisory: false });
      expect(seats).toMatchObject({ codexAdvisory: false, correctnessAdvisory: true });
      expect(reviewPrOperation({ readPr: stubReader(), ...seats }).steps.map(s => s.name)).toEqual(declaration.steps.map(s => s.name));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['the minimum rises to 2',{ WE_REVIEW_MIN_NON_CLAUDE_SEATS: '2' }],
    ['the Codex correctness and Antigravity flags turn on',{ REVIEW_PR_CODEX_CORRECTNESS_ADVISORY: '1', REVIEW_PR_ANTIGRAVITY_REVIEW: '1' }],
  ])('keeps a new run\'s seated roster when %s mid-panel', async (_label, changed) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-changed-'));
    try {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      vi.stubEnv('REVIEW_PR_CODEX_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_CODEX_CORRECTNESS_ADVISORY', '0');
      vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
      vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '0');
      vi.stubEnv('WE_REVIEW_MIN_NON_CLAUDE_SEATS', '1');
      const declaration = reviewPrOperation({ readPr: stubReader(), seatSettings: loadReviewSeatSettings({ log: () => {} }) });
      const registry = createRegistry();
      registry.register(declaration);
      const run = await driveUnfinished({ declaration, registry, store: createFileRunStore(),
        beforeResume: () => { for (const [k, v] of Object.entries(changed)) vi.stubEnv(k, v); } });
      expect(run.findings.reduce).toBeTruthy();
      expect(Object.keys(run.findings)).toContain('judgeAdvisory');
      expect(Object.keys(run.findings)).not.toContain('judgeCorrectnessAdvisory');
      expect(Object.keys(run.findings)).not.toContain('judgeAntigravityReview');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bad run id or torn record reaches the adapter refusal, not the root-usage exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-bad-resume-'));
    try {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      writeFileSync(join(dir, 'torn.json'), '{"id":"torn","op":"review-pr",');
      const live = resolveOperation('review-pr').declaration.steps.map(s => s.name);
      const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
      for (const [id, refusal] of [['../x', 'invalid run id "../x"'], ['torn', 'not parseable JSON'], ['missing-run', 'no run record for "missing-run"']]) {
        // The builder falls back to the live roster instead of throwing out of resolveOperation.
        expect(resolveOperation('review-pr', { resumeId: id }).declaration.steps.map(s => s.name)).toEqual(live);
        const cli = spawnSync(process.execPath, [cliPath, 'review-pr', `--resume=${id}`], {
          encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, WE_DAEMON_MANAGED_CLONE: '1', OPERATION_CALLS_DIR: join(dir, 'calls') },
        });
        expect(cli.error).toBeUndefined();
        expect(cli.stdout + cli.stderr).toContain(refusal);
        expect(cli.stdout + cli.stderr).not.toContain('usage: run.mjs <operation>');
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('rewindRunToStep', () => {
  it('keeps every finding before the step and drops the step and everything after it', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const seen = [];
    const parked = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-1' });
    expect(parked.stopped).toBe('confirm');
    const run = store.read('r-1');
    const back = rewindRunToStep(run, { registry, step: 'mandatoryReferrals', at: '2026-10-08T12:10:00.000Z' });
    expect(back.pending).toBeNull();
    expect(back.findings.reduce).toEqual(run.findings.reduce);
    expect(back.findings.mandatoryReferrals).toBeUndefined();
    expect(back.findings.referralVerdict).toBeUndefined();
    expect(back.effects.every((e) => e.step !== 'mandatoryReferrals')).toBe(true);
    const stepAt = declaration.steps.find((x) => x.name === 'mandatoryReferrals').index;
    // The earlier steps' records survive the rewind (a drop-everything filter would also pass the lines above).
    expect(back.effects).toEqual(run.effects.filter((e) => e.step !== 'mandatoryReferrals' && e.stepIndex < stepAt));
    expect(back.stepTimings.some((t) => t.step === 'read')).toBe(true);
    expect(back.stepTimings.every((t) => t.stepIndex < stepAt)).toBe(true);
    expect(() => rewindRunToStep({ ...run, cursor: 0, pending: null }, { registry, step: 'mandatoryReferrals' })).toThrow(/has not reached/);
    expect(back.resumedAt).toBe('2026-10-08T12:10:00.000Z');
    expect(() => rewindRunToStep(run, { registry, step: 'nope' })).toThrow(/no step/);
  });
});

describe('runReviewLoopOnce — a ruling on an unchanged head resumes the paused review (replay of #4361)', () => {
  it('reuses the parked panel: no juror runs, same run id, the referral step re-reads the thread, and the verdict is the ruled one', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const seen = [];
    const ruled = { value: false };
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };

    // 12:00Z - the first review parks on its mandatory referral.
    const first = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }), makeJudge, mintRunId: () => 'r-1' });
    expect(first.run.verdict.pendingReferrals).toEqual(['k1']);
    const judgedByFirstReview = judged;
    expect(judgedByFirstReview).toBeGreaterThan(0);

    // 12:09Z - the operator rules. 12:15Z - the daemon starts the review again; the hold says run r-1 is the one to resume.
    ruled.value = true;
    const second = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }),
      makeJudge, mintRunId: () => 'r-2-must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-08T12:15:00.000Z' });

    expect(judged).toBe(judgedByFirstReview);                 // no fresh panel
    expect(second.run.id).toBe('r-1');                        // the same run, resumed
    expect(store.read('r-2-must-not-be-minted')).toBeFalsy();
    expect(second.run.resumedAt).toBe('2026-10-08T12:15:00.000Z');
    expect(second.run.verdict.pendingReferrals).toEqual([]);  // the ruling is reflected: nothing is owed any more
    expect(seen.filter((e) => e.type === REVIEW_EFFECTS.MANDATORY_REFERRALS)).toHaveLength(2);
  });

  // PR #4441 review round 2 (correctness): the rewound record replaces the parked one before the resumed pass finishes. If
  // that pass fails, the run must still read as the parked run it was, so the next tick resumes it instead of starting the
  // fresh panel (and the new referrals) this card exists to stop.
  it('a resume whose referral step fails part-way leaves a run that is still parked and resumable, and the next pass finishes it', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const seen = [];
    const ruled = { value: false };
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }), makeJudge, mintRunId: () => 'r-1' });
    const judgedByFirstReview = judged;
    const before = reviewRunEvidence(store.read('r-1'));
    expect(before).toMatchObject({ parked: true, attempted: false });

    // The ruling arrives; the resumed pass dies in the referral sink (a gh failure, a crash).
    const failing = sinksWith({ seen, ruled });
    failing[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => { throw new Error('gh: 502'); };
    const failed = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: failing, makeJudge,
      mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-08T12:15:00.000Z' });
    expect(failed.run.id).toBe('r-1');
    expect(failed.run.verdict).toBeFalsy();                        // the resumed pass produced no verdict of its own
    const after = reviewRunEvidence(store.read('r-1'));
    expect(after).toMatchObject({ id: 'r-1', parked: true, pending: before.pending, attempted: before.attempted });
    expect(after.startedAt).toBe(before.startedAt);                // still wakeable by the ruling that started the resume

    // The next tick resumes the same run again, and this time it completes on the ruled thread.
    ruled.value = true;
    const again = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }), makeJudge,
      mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-08T12:30:00.000Z' });
    expect(again.run.id).toBe('r-1');
    expect(judged).toBe(judgedByFirstReview);                      // never a fresh panel
    expect(again.run.verdict.pendingReferrals).toEqual([]);
    expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ parked: false });
  });

  // Review of the round-2 repair: a resume that keeps failing is bounded, and a re-parked resume is captured afresh.
  it('a resume that keeps failing is retried RESUME_MAX_ATTEMPTS times in all, then the round falls back to a fresh review', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge, mintRunId: () => 'r-1' });
    const failing = sinksWith({ seen: [], ruled: { value: false } });
    failing[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => { throw new Error('gh: 502'); };
    for (let n = 1; n <= RESUME_MAX_ATTEMPTS; n++) {
      const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: failing, makeJudge, mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1' });
      expect(out.run.id).toBe('r-1');
      expect(store.read('r-1').resumeOf.attempts).toBe(n);
    }
    const fresh = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge, mintRunId: () => 'r-fresh', findResumableRun: () => 'r-1' });
    expect(fresh.run.id).toBe('r-fresh');
  });

  it('a resume that finished and re-parked, then failed on the NEXT ruling, keeps the LATEST parked pass (not the first)', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge, mintRunId: () => 'r-1' });
    // Resume 1 finishes and parks again (the referral is still owed).
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge,
      mintRunId: () => 'x', findResumableRun: () => 'r-1', now: () => '2026-10-08T12:15:00.000Z' });
    const reparked = store.read('r-1');
    const secondAdvise = reparked.stepTimings.find((t) => t.step === 'advise').finishedAt;
    expect(reparked.pending?.kind).toBe('confirm');
    // Resume 2 fails: its `resumeOf` must describe the pass that was just parked, not the first one.
    const failing = sinksWith({ seen: [], ruled: { value: false } });
    failing[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => { throw new Error('gh: 502'); };
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: failing, makeJudge, mintRunId: () => 'x', findResumableRun: () => 'r-1' });
    expect(store.read('r-1').resumeOf).toMatchObject({ adviseFinishedAt: secondAdvise, attempts: 1 });
  });

  // Live 2026-10-20, #5752: the referral ledger push lost five races in a row, so the run parked as
  // `referral-persistence-failed`, and the retry started a whole new panel that failed the same way. A persist retry
  // resumes the parked run at the referral step, and each such resume spends one slot of the hold's retry budget.
  it('a referral persist that failed is retried by resuming the parked run, counting each retry, never a new panel', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };
    const persistFails = sinksWith({ seen: [], ruled: { value: false } });
    persistFails[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => ({ records: [], pending: ['referral-persistence-failed'],
      blocked: [], malformed: false, reason: 'mandatory ruling ledger-write-miss: push lost the race' });
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: persistFails, makeJudge, mintRunId: () => 'r-1' });
    const judgedByFirstReview = judged;
    expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ persistenceFailed: true, persistRetries: 0 });
    // Retry 1 fails again: same run, one retry counted.
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: persistFails, makeJudge,
      mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-20T15:40:00.000Z' });
    expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ id: 'r-1', persistenceFailed: true, persistRetries: 1 });
    // Retry 2 persists: the run is no longer held on persistence, and no juror ever ran again.
    const ok = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: true } }),
      makeJudge, mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-20T16:10:00.000Z' });
    expect(ok.run.id).toBe('r-1');
    expect(judged).toBe(judgedByFirstReview);
    expect(store.read('must-not-be-minted')).toBeFalsy();
    expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ persistenceFailed: false, parked: false, persistRetries: 2 });
  });

  // Codex audit of the fix above: resumes that die part-way must spend the budget too, or three of them reach the
  // RESUME_MAX_ATTEMPTS fresh-panel fallback with the budget unspent and the retries never run out.
  it('a persist retry that dies part-way still spends a slot, so the hold is exhausted before the fresh-panel fallback', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    const persistFails = sinksWith({ seen: [], ruled: { value: false } });
    persistFails[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => ({ records: [], pending: ['referral-persistence-failed'],
      blocked: [], malformed: false, reason: 'ledger-write-miss' });
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: persistFails, makeJudge, mintRunId: () => 'r-1' });
    const dies = sinksWith({ seen: [], ruled: { value: false } });
    dies[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => { throw new Error('gh: 502'); };
    for (let n = 1; n <= REFERRAL_RETRY_MS.length; n++) {
      await runReviewLoopOnce({ declaration, registry, argv, store, sinks: dies, makeJudge, mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1' });
      expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ id: 'r-1', persistenceFailed: true, persistRetries: n });
    }
    const p = { number: 4361, headRefOid: reviewRunEvidence(store.read('r-1')).head, comments: [], labels: [] };
    expect(decideReferralHold(p, [reviewRunEvidence(store.read('r-1'))], { repo: 'o/n', now: Date.now() + 86_400_000 }))
      .toMatchObject({ exhausted: true, retryAt: null });
    // Spent: even if a review is dispatched anyway, it never falls back to a fresh panel; the round refuses.
    const refused = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: dies, makeJudge,
      mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1' });
    expect(refused).toMatchObject({ code: 2, stopped: 'refused' });
    expect(refused.lines.join('\n')).toMatch(/persist retries are spent/);
    expect(store.read('must-not-be-minted')).toBeFalsy();
  });

  it.each([
    { cleared: true, interrupted: false, failurePoint: REVIEW_EFFECTS.ADVISORY_NOTE, notApplied: true },
    { cleared: false, interrupted: false, failurePoint: REVIEW_EFFECTS.ADVISORY_NOTE, notApplied: true },
    { cleared: true, interrupted: true, failurePoint: REVIEW_EFFECTS.ADVISORY_NOTE, notApplied: true },
    { cleared: true, interrupted: false, failurePoint: REVIEW_EFFECTS.ADVISORY_LABEL, notApplied: true },
    { cleared: false, interrupted: true, failurePoint: REVIEW_EFFECTS.ADVISORY_LABEL, notApplied: true },
    { cleared: true, interrupted: false, failurePoint: REVIEW_EFFECTS.ADVISORY_NOTE, notApplied: false },
    { cleared: true, interrupted: false, failurePoint: REVIEW_EFFECTS.ADVISORY_LABEL, notApplied: false },
    { cleared: false, interrupted: true, failurePoint: REVIEW_EFFECTS.ADVISORY_LABEL, notApplied: false },
  ])('a successful final persist retry survives a later advisory failure (%j)', async ({ cleared, interrupted, failurePoint, notApplied }) => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const judge = vi.fn(async () => judgeOutcome(REFERRAL_ANSWER, {}));
    const makeJudge = () => judge;
    const persistFails = sinksWith({ seen: [], ruled: { value: false } });
    persistFails[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => ({ records: [], pending: ['referral-persistence-failed'],
      blocked: [], malformed: false, reason: 'ledger-write-miss' });
    const args = { declaration, registry, argv, store, makeJudge, mintRunId: () => 'must-not-be-minted' };
    await runReviewLoopOnce({ ...args, sinks: persistFails, mintRunId: () => 'r-1' });
    const judged = judge.mock.calls.length;
    if (interrupted) persistFails[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => { throw new Error('persist interrupted'); };
    for (let n = 1; n < REFERRAL_RETRY_MS.length; n++) {
      await runReviewLoopOnce({ ...args, sinks: persistFails, findResumableRun: () => 'r-1' });
    }
    const seen = [];
    const recovered = sinksWith({ seen, ruled: { value: cleared } });
    const persist = recovered[REVIEW_EFFECTS.MANDATORY_REFERRALS];
    // Pending referrals alone deliberately produce no advisory label. Include a separate block ruling so
    // label-failure cases exercise an actually declared label while preserving the pending referral.
    recovered[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async payload => ({ ...await persist(payload),
      ...(!cleared && failurePoint === REVIEW_EFFECTS.ADVISORY_LABEL ? { blocked: ['blocked-k2'] } : {}),
      records: [{ repo: 'o/n', pr: 4361, head: HEAD_1, attempted: true, referrals: [{ key: 'k1' }], rulings: [] }] });
    let advisoryFailures = 0;
    const advisoryFails = { ...recovered, [failurePoint]: async () => {
      advisoryFailures += 1;
      throw Object.assign(new Error('advisory service unavailable'), { notApplied });
    } };
    const failed = await runReviewLoopOnce({ ...args, sinks: advisoryFails, findResumableRun: () => 'r-1' });
    expect(failed).toMatchObject({ code: 1, stopped: 'effect-halted' });
    expect(advisoryFailures).toBe(1);
    const run = store.read('r-1');
    expect(run.findings.referralVerdict.pendingReferrals).toEqual(cleared ? [] : ['k1']);
    expect(run.stepTimings.find(t => t.step === 'advise')?.finishedAt).toBeFalsy();
    const evidence = reviewRunEvidence(run);
    expect(evidence).toMatchObject({ persistenceFailed: false, persistRetries: 3, attempted: !cleared, pending: cleared ? [] : ['k1'] });
    const pr = { number: 4361, headRefOid: evidence.head, comments: [], labels: [] };
    expect(decideReferralHold(pr, [evidence], { repo: 'o/n' })).toBeNull();
    expect(enrichPrsWithReferralHolds([pr], { repo: 'o/n', readRuns: () => [evidence],
      env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '1' } })[0].referralHold).toBeNull();
    const findResumableRun = () => findResumableParkedRun(pr, [reviewRunEvidence(store.read('r-1'))], { repo: 'o/n' })?.id;
    expect(findResumableRun()).toBe('r-1');
    const rearm = { body: REARM_COMMENT_MARKER, createdAt: new Date(evidence.startedAt + 1).toISOString(), author: { login: 'web-everything' } };
    expect(findResumableParkedRun({ ...pr, comments: [rearm] }, [evidence], { repo: 'o/n' })?.id).toBe('r-1');
    expect(findResumableParkedRun({ ...pr, comments: [{ ...rearm, author: { login: 'chalbert' } }] }, [evidence], { repo: 'o/n' })).toBeNull();
    expect(findResumableParkedRun({ ...pr, headRefOid: HEAD_2 }, [evidence], { repo: 'o/n' })).toBeNull();
    // Another advisory outage must preserve the successful persist and all partial advisory effects.
    const retried = await runReviewLoopOnce({ ...args, sinks: advisoryFails, findResumableRun });
    expect(retried).toMatchObject({ code: 1, stopped: 'effect-halted' });
    expect(reviewRunEvidence(store.read('r-1'))).toMatchObject({ persistenceFailed: false, persistRetries: 3 });
    const done = await runReviewLoopOnce({ ...args, sinks: recovered, findResumableRun });
    if (!notApplied) {
      expect(done.stopped).toBe('effect-halted');
      let capped;
      for (let n = 0; n <= RESUME_MAX_ATTEMPTS; n++) {
        capped = await runReviewLoopOnce({ ...args, sinks: recovered, findResumableRun });
      }
      expect(capped).toMatchObject({ code: 2, stopped: 'refused' });
      expect(capped.lines.join('\n')).toContain('unresolved advisory effect');
      expect(advisoryFailures).toBe(1); // Unknown non-idempotent outcomes are never automatically replayed.
      expect(done.lines.join('\n')).toContain('UNKNOWN outcome');
      expect(seen.filter(e => e.type === failurePoint)).toHaveLength(0);
      expect(seen.filter(e => e.type === REVIEW_EFFECTS.ADVISORY_NOTE))
        .toHaveLength(failurePoint === REVIEW_EFFECTS.ADVISORY_LABEL ? 1 : 0);
      expect(store.read('must-not-be-minted')).toBeFalsy();
      expect(judge).toHaveBeenCalledTimes(judged);
      return;
    }
    expect(done.stopped).toBe('confirm');
    expect(done.run.id).toBe('r-1');
    expect(done.run.verdict.pendingReferrals).toEqual(cleared ? [] : ['k1']);
    expect(seen.filter(e => e.type === REVIEW_EFFECTS.MANDATORY_REFERRALS)).toHaveLength(1);
    expect(seen.filter(e => e.type === REVIEW_EFFECTS.ADVISORY_NOTE)).toHaveLength(1);
    expect(judge).toHaveBeenCalledTimes(judged);
    expect(store.read('must-not-be-minted')).toBeFalsy();
  });

  it.each([REVIEW_EFFECTS.MANDATORY_REFERRALS, REVIEW_EFFECTS.ADVISORY_NOTE])(
    'an interrupted persist retry at %s starts its next backoff at the latest resume, even after a long outage', async (failurePoint) => {
      const { declaration, registry } = setup();
      const store = createMemoryRunStore();
      // The adapter factory runs on every invocation; only calling the judge executes a juror.
      const judge = vi.fn(async () => judgeOutcome(REFERRAL_ANSWER, {}));
      const makeJudge = () => judge;
      const persistFails = sinksWith({ seen: [], ruled: { value: false } });
      persistFails[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => ({ records: [], pending: ['referral-persistence-failed'],
        blocked: [], malformed: false, reason: 'ledger-write-miss' });
      await runReviewLoopOnce({ declaration, registry, argv, store, sinks: persistFails, makeJudge, mintRunId: () => 'r-1' });
      const original = reviewRunEvidence(store.read('r-1'));
      const p = { number: 4361, headRefOid: original.head, comments: [], labels: [] };
      const judged = judge.mock.calls.length;
      expect(judged).toBeGreaterThan(0);
      const dies = { ...persistFails, [failurePoint]: async () => { throw new Error('gh: 502'); } };
      let resumedAt = original.completedAt + 2 * 3600_000;
      for (let n = 1; n <= REFERRAL_RETRY_MS.length; n++) {
        expect(decideReferralHold(p, [reviewRunEvidence(store.read('r-1'))], { repo: 'o/n', now: resumedAt })).toBeNull();
        await runReviewLoopOnce({ declaration, registry, argv, store, sinks: dies, makeJudge,
          mintRunId: () => 'must-not-be-minted', findResumableRun: () => 'r-1', now: () => new Date(resumedAt).toISOString() });
        const current = reviewRunEvidence(store.read('r-1'));
        expect(current).toMatchObject({ id: 'r-1', parked: true, persistenceFailed: true, persistRetries: n });
        expect(judge).toHaveBeenCalledTimes(judged);
        if (n < REFERRAL_RETRY_MS.length) {
          const retryAt = resumedAt + REFERRAL_RETRY_MS[n];
          for (const tick of [resumedAt + 60_000, retryAt - 1]) {
            expect(decideReferralHold(p, [current], { repo: 'o/n', now: tick }))
              .toMatchObject({ exhausted: false, retryAt });
          }
          expect(decideReferralHold(p, [current], { repo: 'o/n', now: retryAt })).toBeNull();
          resumedAt = retryAt;
        } else {
          expect(decideReferralHold(p, [current], { repo: 'o/n', now: resumedAt + 60_000 }))
            .toMatchObject({ exhausted: true, retryAt: null });
        }
      }
      expect(store.read('must-not-be-minted')).toBeFalsy();
    });

  it('without a resumable run it starts a fresh review exactly as before (new push, re-arm, send-back)', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };
    const ids = ['r-1', 'r-2'];
    const args = { declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge, mintRunId: () => ids.shift() };
    await runReviewLoopOnce(args);
    const after = judged;
    const again = await runReviewLoopOnce({ ...args, findResumableRun: () => null });
    expect(again.run.id).toBe('r-2');
    expect(judged).toBe(after * 2);
  });

  it('a resume id that no longer names a parked run falls back to a fresh review', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-fresh', findResumableRun: () => 'gone' });
    expect(out.run.id).toBe('r-fresh');
  });

  it('a store read that throws falls back to a fresh review', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const broken = { ...store, read: (id) => { if (id === 'r-1') throw new Error('corrupt'); return store.read(id); } };
    const out = await runReviewLoopOnce({ declaration, registry, argv, store: broken, sinks: sinksWith({ seen: [], ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-fresh', findResumableRun: () => 'r-1' });
    expect(out.run.id).toBe('r-fresh');
  });

  it('WE_REVIEW_RESUME_PARKED=0 starts a fresh review even when a parked run is resumable', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const sinks = () => sinksWith({ seen: [], ruled: { value: false } });
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-1' });
    const prior = process.env.WE_REVIEW_RESUME_PARKED;
    process.env.WE_REVIEW_RESUME_PARKED = '0';
    try {
      const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-2', findResumableRun: () => 'r-1' });
      expect(out.run.id).toBe('r-2');
    } finally {
      if (prior === undefined) delete process.env.WE_REVIEW_RESUME_PARKED; else process.env.WE_REVIEW_RESUME_PARKED = prior;
    }
  });

  it('only a run parked on a confirm step of THIS operation is resumed', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const sinks = () => sinksWith({ seen: [], ruled: { value: false } });
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-1' });
    const parked = store.read('r-1');
    store.write({ ...parked, id: 'r-other-op', op: 'some-other-op' });
    store.write({ ...parked, id: 'r-not-confirm', pending: { ...parked.pending, kind: 'judge' } });
    for (const [id, fresh] of [['r-other-op', 'f-1'], ['r-not-confirm', 'f-2']]) {
      const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => fresh, findResumableRun: () => id });
      expect(out.run.id).toBe(fresh);
    }
  });
});

// ── the reduce step reads the PR's own referral records, so a second panel on the same head cannot add referrals ──────
describe('review-pr reduce — a later panel on an unchanged head adds no mandatory referral (replay of #4361)', () => {
  const firstFinding = { file: NET_PATHS[0], line: 3, summary: 'the guard is inverted', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const newFinding = { file: NET_PATHS[0], line: 8, summary: 'a second, different defect', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const thread = [{ body: renderReferralRecord(recordFor(HEAD_1, firstFinding, ['not-real'])), createdAt: '2026-10-08T12:00:00Z', author: { login: 'web-everything' } }];
  const reduceWith = async (answerFindings, { comments = thread, rev = HEAD_1, latestFix, correctnessAdvisory = false } = {}) => {
    const base = stubReader();
    // These replays distinguish gate-only panels from panels with an explicit correctness advisory seat.
    const declaration = reviewPrOperation({ correctnessAdvisory, minNonClaudeSeats: 0,
      readPr: (a) => ({ ...base(a), comments, ...(latestFix ? { latestFix } : {}), net: { ...base(a).net, rev } }) });
    const registry = createRegistry();
    registry.register(declaration);
    let run = advanceWhileRunning(startRun({ op: 'review-pr', id: 'r-reduce', input: { repo: 'o/n', pr: 4361 }, registry }), { registry });
    while (run.pending?.kind === 'judge') {
      run = advanceWhileRunning(run, { registry, resume: { value: { summary: 'looked', findings: answerFindings } } });
    }
    return run.findings.reduce;
  };

  it('the repeated finding is covered by identity (even reworded to another line) and leaves the verdict basis', async () => {
    const reduce = await reduceWith([{ ...firstFinding, line: 40, disposition: 'blocker' }]);
    expect(reduce.referrals).toEqual([]);
    expect(reduce.verdict).not.toBe('changes');
  });

  const demotedSame = (reduce) => reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD && f.summary === newFinding.summary);

  // PR #4441 review round 1: the gate's own lenses are never silenced by the round rule (the existing #3999 rule keeps
  // them in every round too); only an advisory seat's later-round finding becomes a card suggestion.
  it('a finding first raised in this later round: an advisory seat sets it aside as a card suggestion, a mandatory seat still refers it', async () => {
    const reduce = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { correctnessAdvisory: true });
    expect(reduce.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeSecurity']);
    expect(demotedSame(reduce).map((f) => f.category.split('/')[0])).toEqual(['codex-correctness']);
  });

  // PR #4441 review round 1 (correctness, partial persistence): a head whose referral round never finished is not "settled".
  it('a head whose earlier referral record was never attempted is not a settled round: the advisory seat keeps its finding as a referral', async () => {
    const unattempted = [{ ...thread[0], body: renderReferralRecord({ ...recordFor(HEAD_1, firstFinding), attempted: false }) }];
    const open = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { comments: unattempted, correctnessAdvisory: true });
    expect(open.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeCorrectnessAdvisory', 'judgeSecurity']);
    expect(demotedSame(open)).toEqual([]);
    const attempted = [{ ...thread[0], body: renderReferralRecord({ ...recordFor(HEAD_1, firstFinding), attempted: true }) }];
    const settled = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { comments: attempted, correctnessAdvisory: true });
    expect(demotedSame(settled)).toHaveLength(1);
  });

  // PR #4441 review round 1 (correctness + security): "the fixer touched the cited file" is not "the fixer fixed it".
  describe('a block-ruled finding re-raised after a fix push', () => {
    const blocked = [{ ...thread[0], body: renderReferralRecord(recordFor(HEAD_1, firstFinding, ['block'])) }];
    const latestFix = (lines) => ({ priorHead: HEAD_1, head: HEAD_2, files: { [NET_PATHS[0]]: lines } });
    const reRaised = [{ ...firstFinding, disposition: 'blocker' }];
    it('stays mandatory when the push touched the cited file far from the cited line (the ignored-ruling path needs the referral)', async () => {
      const reduce = await reduceWith(reRaised, { comments: blocked, rev: HEAD_2, latestFix: latestFix([200]) });
      expect(reduce.referrals).toHaveLength(2);
      expect(reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toEqual([]);
    });
    // PR #4441 review round 2: only an ADVISORY seat's re-raise is set aside on a nearby edit; the gate seats keep theirs.
    it('after a nearby edit the gate seats stay mandatory and only the advisory seat is set aside as a card suggestion', async () => {
      const reduce = await reduceWith(reRaised, { comments: blocked, rev: HEAD_2, latestFix: latestFix([3]), correctnessAdvisory: true });
      expect(reduce.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeSecurity']);
      const setAside = reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE);
      expect(setAside.map((f) => f.category.split('/')[0])).toEqual(['codex-correctness']);
    });
    it('with no advisory seat seated, a nearby edit sets nothing aside', async () => {
      const reduce = await reduceWith(reRaised, { comments: blocked, rev: HEAD_2, latestFix: latestFix([3]) });
      expect(reduce.referrals).toHaveLength(2);
      expect(reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toEqual([]);
    });
    // PR #4441 review round 2 (correctness): a block ruled by the OPERATOR lives in its own comment, not on the record.
    it('an operator block ruling in the thread is read: the advisory seat is set aside, the gate seats stay mandatory', async () => {
      const record = recordFor(HEAD_1, firstFinding, []);
      const operatorBlock = buildOperatorRulingComment({ version: 1, repo: 'o/n', pr: 4361, head: HEAD_1,
        rulings: [{ runId: record.runId, key: record.referrals[0].key, result: 'block' }],
        actor: 'chalbert', channel: 'claude-code-chat', reason: 'Fix it', at: '2026-10-08T12:09:00Z', clearerId: 'session-1' });
      const comments = [{ ...thread[0], body: renderReferralRecord(record) },
        { body: operatorBlock, createdAt: '2026-10-08T12:09:00Z', author: { login: 'chalbert' } }];
      const reduce = await reduceWith(reRaised, { comments, rev: HEAD_2, latestFix: latestFix([3]), correctnessAdvisory: true });
      expect(reduce.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeSecurity']);
      expect(reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toHaveLength(1);
      // ...and with no operator comment the same re-raise is not block-ruled, so nothing is set aside.
      const without = await reduceWith(reRaised, { comments: [comments[0]], rev: HEAD_2, latestFix: latestFix([3]), correctnessAdvisory: true });
      expect(without.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toEqual([]);
    });
  });
});

// ── PR #4441 review round 1: ONE shared "did the fixer address this finding" predicate, with the same care as #3999 ──
describe('classifyReferralsByRound — a block-ruled re-raise is demoted only on positive evidence the cited lines were fixed', () => {
  const SRC = 'scripts/lib/thing.mjs';
  const finding = (file, line = 100) => ({ file, line, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' });
  const run = (file, latestFix, line = 100, lens = 'simplicity') => classifyReferralsByRound([candidate(finding(file, line))],
    { identity: identityOf(recordFor(HEAD_1, finding(file), ['block'])), head: HEAD_2, latestFix, lens });
  const fix = (files, extra = {}) => ({ priorHead: HEAD_1, head: HEAD_2, files, ...extra });
  const demoted = (out) => out.demoted.map((d) => d.reason);

  it('demotes an advisory seat when a source file changed within LATER_ROUND_CHANGE_WINDOW of the cited line (edges included)', () => {
    for (const changed of [100, 97, 103]) expect(demoted(run(SRC, fix({ [SRC]: [changed] })))).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
    for (const changed of [96, 104]) expect(run(SRC, fix({ [SRC]: [changed] })).kept).toHaveLength(1);
  });
  // Every mandatory lens, at every position of the window, with the exact shapes that demote an advisory seat.
  it.each(['correctness', 'security'])('never demotes a %s-lens re-raise, whatever the edit near the cited line', (lens) => {
    for (const changed of [100, 97, 103]) {
      const out = run(SRC, fix({ [SRC]: [changed] }), 100, lens);
      expect(out.demoted).toEqual([]);
      expect(out.kept).toHaveLength(1);
    }
    const alias = classifyReferralsByRound([candidate(finding('thing.mjs'))],
      { identity: identityOf(recordFor(HEAD_1, finding('thing.mjs'), ['block'])), head: HEAD_2, latestFix: fix({ [SRC]: [101] }), lens });
    expect(alias.demoted).toEqual([]);
  });
  it.each([
    ['an edit far from the cited line', SRC, fix({ [SRC]: [5] })],
    ['a non-source file (no line meaning to scope on)', 'backlog/x29vm8a-the-card.md', fix({ 'backlog/x29vm8a-the-card.md': [100] })],
    ['an unknown changed-line set (null)', SRC, fix({ [SRC]: null })],
    ['an empty changed-line set', SRC, fix({ [SRC]: [] })],
    ['a fix range with no prior head', SRC, fix({ [SRC]: [100] }, { priorHead: null })],
    ['a malformed fix range (negative line)', SRC, fix({ [SRC]: [-1, 100] })],
    ['a malformed fix range (files is an array)', SRC, fix([SRC])],
    ['an unreadable fix range', SRC, fix({ [SRC]: [100] }, { error: 'git failed' })],
  ])('stays mandatory for %s', (_name, file, latestFix) => {
    const out = run(file, latestFix);
    expect(out.demoted).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
  it('stays mandatory when the re-raise cites no line at all', () => {
    const out = classifyReferralsByRound([candidate({ ...finding(SRC), line: undefined })],
      { identity: identityOf(recordFor(HEAD_1, finding(SRC), ['block'])), head: HEAD_2, latestFix: fix({ [SRC]: [100] }) });
    expect(out.kept).toHaveLength(1);
  });
  // PR #4441 review round 3 (codex-correctness, CONFIRMED): the test above names no lens, so the gate-lens default keeps the
  // finding whatever the missing-line guard does. An ADVISORY seat is the only path that reaches the guard, and a changed
  // line of 1 sits inside the window if a missing line were ever coerced to 0 — so this reddens on removing the guard.
  it.each([undefined, null, 0, '', 'x'])('an advisory seat re-raising with no usable cited line (%j) stays mandatory, with a cited-line positive control', (line) => {
    const identity = identityOf(recordFor(HEAD_1, finding(SRC), ['block']));
    const noLine = classifyReferralsByRound([candidate({ ...finding(SRC), line })],
      { identity, head: HEAD_2, lens: 'simplicity', latestFix: fix({ [SRC]: [1] }) });
    expect(noLine.demoted).toEqual([]);
    expect(noLine.kept).toHaveLength(1);
    const cited = classifyReferralsByRound([candidate({ ...finding(SRC), line: 2 })],
      { identity, head: HEAD_2, lens: 'simplicity', latestFix: fix({ [SRC]: [1] }) });
    expect(demoted(cited)).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
  });
  it('resolves an aliased citation (basename / repo prefix) to the touched path like #3999 does', () => {
    const out = classifyReferralsByRound([candidate({ ...finding('thing.mjs') })],
      { identity: identityOf(recordFor(HEAD_1, finding('thing.mjs'), ['block'])), head: HEAD_2, latestFix: fix({ [SRC]: [101] }), lens: 'simplicity' });
    expect(demoted(out)).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
  });
});

describe('classifyReferralsByRound — the same-head round rule never silences a gate lens, and never fires on an unsettled head', () => {
  const brandNew = { file: 'scripts/lib/pre-pr-review.mjs', line: 9, summary: 'A guard is missing on the empty list', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
  const run = (o) => classifyReferralsByRound([candidate(brandNew)], { identity, head: HEAD_1, ...o });

  it.each(['correctness', 'security'])('keeps a %s-lens finding first raised in a later round as a referral', (lens) => {
    const out = run({ lens });
    expect(out.kept).toEqual([candidate(brandNew)]);
    expect(out.demoted).toEqual([]);
  });
  it.each(['simplicity', 'codex-correctness'])('sets aside a %s-lens finding first raised in a later round', (lens) => {
    expect(run({ lens }).demoted.map((d) => d.reason)).toEqual([REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD]);
  });
  it.each([undefined, '', 42])('treats a caller that names no usable lens (%j) as a gate lens: nothing is silenced', (lens) => {
    expect(run({ lens }).kept).toHaveLength(1);
  });
  it('keeps the advisory finding as a referral while the head still has a referral round that never finished', () => {
    expect(run({ lens: 'simplicity', openHeads: [HEAD_1] }).kept).toHaveLength(1);
    expect(run({ lens: 'simplicity', openHeads: [HEAD_2] }).demoted).toHaveLength(1);
  });
  it('a finding already referred on the head is covered whatever the lens or round state', () => {
    for (const o of [{ lens: 'security' }, { lens: 'simplicity', openHeads: [HEAD_1] }]) {
      const out = classifyReferralsByRound([candidate({ ...raised, line: 40 })], { identity, head: HEAD_1, ...o });
      expect(out.covered).toHaveLength(1);
      expect(out.kept).toEqual([]);
    }
  });
});

describe('classifyReferralsByRound — "covered" means an ACTIVE referral holds the finding (PR #4441 self-review)', () => {
  const seat = 'judgeAntigravityReview';
  const finding = { file: 'scripts/lib/thing.mjs', line: 11, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const record = (dropped) => {
    const base = recordFor(HEAD_1, finding);
    const key = referralFindingKey(seat, finding);
    return { ...base, attempted: false, referrals: [{ key, seat, original: finding, finding: normalizeFinding(finding) }],
      ...(dropped ? { dropped: [{ key, reason: 'dropped: seat disabled by operator config' }] } : {}) };
  };
  it('a re-raise of a finding whose only referral was retired as dropped is kept, never lost to "covered"', () => {
    const identity = findingIdentityTable([record(true)]);
    const out = classifyReferralsByRound([candidate(finding)], { identity, head: HEAD_1, lens: 'correctness' });
    expect(out.covered).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
  it('the same finding with a live referral is covered', () => {
    const out = classifyReferralsByRound([candidate(finding)], { identity: findingIdentityTable([record(false)]), head: HEAD_1, lens: 'correctness' });
    expect(out.covered).toHaveLength(1);
  });
});

// PR #4441 review round 3 (security, PLAUSIBLE): `covered` takes a finding out of the referrals AND the verdict basis, so
// it must hold only for the SAME defect already referred on this head. The #76a identity also binds on a shared quote
// anchor, which cannot tell a re-wording from a different defect quoting the same line (the carry code says so).
describe('classifyReferralsByRound — "covered" needs the same claim, not just a shared quote anchor (PR #4441 review round 3)', () => {
  const quote = 'if (items.length === 0) return null;';
  const first = { file: 'scripts/lib/thing.mjs', line: 11, category: 'security/security', summary: 'The guard on an empty list is missing',
    quote, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const other = { ...first, line: 12, category: 'correctness/logic', summary: 'The null return is dereferenced by the caller and crashes',
    failure_scenario: 'a caller passes []' };
  const identity = identityOf(recordFor(HEAD_1, first));
  it.each(['correctness', 'security', 'simplicity', undefined])('a DIFFERENT defect on the same path and quote anchor is not covered (%j lens)', (lens) => {
    const out = classifyReferralsByRound([candidate(other)], { identity, head: HEAD_1, lens });
    expect(out.covered).toEqual([]);
    // the fix target: it is never silently dropped — a gate lens keeps it as a referral
    if (lens !== 'simplicity') expect(out.kept).toEqual([candidate(other)]);
    // an advisory seat's look-alike is a new finding in a later round: a card suggestion, like any other
    else expect(out.demoted.map((d) => d.reason)).toEqual([REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD]);
  });
  it('a templated claim differing only in its :line reference is a DIFFERENT defect: not covered', () => {
    const templated = { ...first, line: 10, summary: 'Unescaped user value reaches exec at a.mjs:10' };
    const out = classifyReferralsByRound([candidate({ ...templated, line: 200, summary: 'Unescaped user value reaches exec at a.mjs:200' })],
      { identity: identityOf(recordFor(HEAD_1, templated)), head: HEAD_1, lens: 'security' });
    expect(out.covered).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
  it('the SAME claim re-worded only in case, quoting, whitespace or punctuation, at a drifted line, is still covered', () => {
    for (const summary of ['the guard on an empty list is missing.', 'The guard  on an empty\nlist is `missing`', 'The guard on an empty list is missing']) {
      const out = classifyReferralsByRound([candidate({ ...first, line: 40, summary })], { identity, head: HEAD_1, lens: 'security' });
      expect(out.covered).toHaveLength(1);
      expect(out.kept).toEqual([]);
    }
  });
  it('finds the exact claim on a LATER entry when an earlier same-anchor entry (another lens) holds a different claim', () => {
    // the table keeps different lenses apart, so both bind through the lens-blind match: the first must not shadow the second
    const both = identityOf(recordFor(HEAD_1, first), recordFor(HEAD_1, other));
    expect(both).toHaveLength(2);
    const out = classifyReferralsByRound([candidate(other)], { identity: both, head: HEAD_1, lens: 'correctness' });
    expect(out.covered).toEqual([candidate(other)]);
    expect(out.kept).toEqual([]);
  });
  it('an exact-claim match on ANOTHER head does not cover this one', () => {
    const out = classifyReferralsByRound([candidate(first)], { identity: identityOf(recordFor(HEAD_1, first), recordFor(HEAD_2, { ...other, category: first.category })), head: HEAD_2, lens: 'security' });
    expect(out.covered).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
});

describe('classifyReferralsByRound — an alias that fits two changed files is no evidence of a fix (PR #4441 self-review)', () => {
  const cited = { file: 'index.mjs', line: 900, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const identity = identityOf(recordFor(HEAD_1, cited, ['block']));
  const run = (files) => classifyReferralsByRound([candidate(cited)], { identity, head: HEAD_2, lens: 'simplicity', latestFix: { priorHead: HEAD_1, head: HEAD_2, files } });
  it('keeps the referral when a basename citation matches two changed files', () => {
    expect(run({ 'a/index.mjs': [900], 'b/index.mjs': [5] }).kept).toHaveLength(1);
  });
  it('demotes when the alias names exactly one changed file and its lines are near', () => {
    expect(run({ 'a/index.mjs': [900], 'b/other.mjs': [5] }).demoted).toHaveLength(1);
  });
});

describe('openReferralHeads — heads whose referral round never finished (a partial persistence, a crash before the attempt)', () => {
  const at = (body) => ({ body, createdAt: '2026-10-08T12:00:00Z', author: { login: 'web-everything' } });
  it('names a head that carries a record nobody has attempted, and not one whose record was attempted', () => {
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: false }))])).toEqual([HEAD_1]);
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: true }))])).toEqual([]);
    // the persisted chunk is no less unfinished for being ruled: it is the chunk that never posted that is still owed
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised, ['block']), attempted: false }))])).toEqual([HEAD_1]);
    expect(openReferralHeads([])).toEqual([]);
    expect(openReferralHeads(undefined)).toEqual([]);
  });
  it('ignores prose that merely mentions the marker and records from an untrusted author', () => {
    const forged = { ...at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: false })), author: { login: 'someone-else' } };
    expect(openReferralHeads([forged, at('no record here')])).toEqual([]);
  });
});

describe('defaultFindResumableRun — never throws; an unreadable PR or store means a fresh review', () => {
  const target = { repo: 'o/n', pr: 4361 };
  it('answers null when the PR read throws, has no head, or the run store read throws', () => {
    expect(defaultFindResumableRun(target, { readPr: () => { throw new Error('gh down'); }, readRuns: () => [] })).toBeNull();
    expect(defaultFindResumableRun(target, { readPr: () => ({}), readRuns: () => [] })).toBeNull();
    expect(defaultFindResumableRun(target, { readPr: () => ({ headRefOid: HEAD_1, comments: [] }), readRuns: () => { throw new Error('disk'); } })).toBeNull();
  });
  it('answers null when there is no run for the PR', () => {
    expect(defaultFindResumableRun(target, { readPr: () => ({ headRefOid: HEAD_1, comments: [] }), readRuns: () => [] })).toBeNull();
  });
});

describe('defaultFindResumableRun — the wiring from the PR thread to the hold rule (the happy path)', () => {
  const target = { repo: 'o/n', pr: 4388 };
  const t0 = Date.parse('2026-10-08T12:00:00Z');
  const parked = { id: 'review-pr-parked', repo: 'o/n', pr: 4388, head: HEAD_1, startedAt: t0, completedAt: t0 + 1000,
    parked: true, attempted: true, persistenceFailed: false, pending: ['k'], rulings: [] };
  const ruling = (at) => ({ body: renderReferralRecord(recordFor(HEAD_1, raised, ['not-real'])), createdAt: new Date(at).toISOString(), author: { login: 'web-everything' } });
  const find = (view, runs = [parked]) => defaultFindResumableRun(target, { readPr: () => view, readRuns: () => runs });

  it('answers the parked run id when the only thing since it began is a ruling on its head', () => {
    expect(find({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000)] })).toBe('review-pr-parked');
  });
  it('coerces the PR number the way the gh read supplies it (a string) and still finds the run', () => {
    expect(defaultFindResumableRun({ repo: 'o/n', pr: '4388' }, { readPr: () => ({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000)] }), readRuns: () => [parked] })).toBe('review-pr-parked');
  });
  it('answers null when no ruling has arrived, the head moved, or a re-arm came after the ruling', () => {
    expect(find({ headRefOid: HEAD_1, comments: [] })).toBeNull();
    expect(find({ headRefOid: HEAD_2, comments: [ruling(t0 + 60_000)] })).toBeNull();
    const rearm = { body: '🔁 review — changes requested', createdAt: new Date(t0 + 90_000).toISOString(), author: { login: 'web-everything' } };
    expect(find({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000), rearm] })).toBeNull();
  });
});
