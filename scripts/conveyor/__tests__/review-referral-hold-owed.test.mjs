import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { claimReviewDispatch, decideSameHeadHold, enrichPrsWithReferralHolds } from '../review-referral-hold.mjs';
import { defaultReadNotesForRepo } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { dispatchReviewByMode, runReviewJob } from '../../operations/review-job.mjs';
import { reviewJobResult } from '../../operations/review-job-envelope.mjs';
import { runRedTeam, resumeSavedRedTeam, speculateRedTeam } from '../../operations/review-extra-seats.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { repoKeyForSlug } from '../../lib/constellation-repos.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import * as reviewDispatchCli from '../../operations/review-dispatch.mjs';
import { makeCliMechanicalPasses, MECHANICAL_PASS_NAMES } from '../../../skills-src/conveyor/runner.mjs';

// x9jlvy0: replay the saved-result/missing-comment boundary from PR #5461.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const repo = 'web-everything/web-everything';
const identityChangeTypes = [
  { kind: 'source', file: 'src/example.mjs' },
  { kind: 'documentation', file: 'docs/example.md' },
  { kind: 'configuration', file: 'scripts/settings/example.json' },
  { kind: 'data', file: 'src/_data/example.json' },
];
const identityTestName = 'applies owed-comment identity checks across file types';
const head = '3373a3326ef2b649303f7b26b69efabfdfe179a6';
const number = 5461;
const pr = (over = {}) => ({ number, headRefOid: head, comments: [], labels: ['review:accepted'], ...over });
const row = (over = {}) => ({ repo, pr: number, rev: head, dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', ...over });
const run = (over = {}) => ({ repo, pr: number, head, startedAt: 1, completedAt: 2,
  parked: false, persistenceFailed: false, rulings: [], ...over });
let dir, opts;
const save = records => writeFileSync(opts.redTeam.storePath, JSON.stringify({ version: 1, records }));
const settings = value => writeFileSync(opts.redTeam.settingsPath, JSON.stringify({ redTeam: value }));
const decide = (p = pr(), runs = [run()], extra = {}) => decideSameHeadHold(p, runs, { ...opts, ...extra });
const claim = (extra = {}) => claimReviewDispatch(pr(), { ...opts, ...extra });
const reservationPath = () => join(opts.redTeam.stateDir,
  createHash('sha256').update(JSON.stringify([repo, number, head])).digest('hex'));
const dispatch = (extra = {}) => dispatchReviewByMode({
  mode: 'job', repo, pr: number, root: '/daemon', dir: join(dir, 'jobs'),
  env: {}, checkoutExists: () => true, checkStaleness: () => ({ fresh: true, behind: 0 }),
  stackCheck: () => ({ base: null }), readCompletion: () => null,
  resolveSettingsEnv: () => ({}), ciGate: () => ({ allowed: true, headSha: head }),
  beforeSpawn: () => claim(), spawnJob: () => 4242, ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redteam-owed-'));
  const platform = join(dir, 'platform.json');
  writeFileSync(platform, '{}');
  opts = { repo, env: { WE_PLATFORM_PREFERENCES_FILE: platform, WE_POLICY_CASCADE_LOG: '1' },
    redTeam: { storePath: join(dir, 'scorecards.json'), stateDir: join(dir, 'lifts'),
      settingsPath: join(dir, 'settings.json'), log: vi.fn() } };
  resetCascadeLogForTest();
  settings({});
  save([row()]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('same-head hold when the post-accept red-team comment is owed', () => {
  it.each(['job', 'session'])('the runner refuses tokenless owed-head CLI reviews on every tick (%s)', async mode => {
    const [p] = enrichPrsWithReferralHolds([pr({ labels: [{ name: 'review:accepted' }],
      headRefName: 'lane/redteam-comment-retry', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN',
      statusCheckRollup: ['test', 'standards', 'test-shard (1)']
        .map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    })], { ...opts, now: 3, readRuns: () => [run()] });
    const plan = planReconcile({ repo: repoKeyForSlug(repo), prs: [p], agents: [], requiredChecks: ['test'], now: 3 });
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', owedRedTeamReview: { repo, pr: number, head } }));
    const spawnJob = vi.fn(() => 4242), spawnAgent = vi.fn();
    const skips = [];
    const pass = makeCliMechanicalPasses({ scriptsDir: '/daemon/scripts', repo,
      skipPasses: new Set(MECHANICAL_PASS_NAMES.filter(name => name !== 'reconcile-pass')),
      fetchOpenPrs: () => [p], exec: (_file, argv) => {
        if (argv[0].endsWith('/reconcile-pass.mjs')) return JSON.stringify(plan);
        if (argv[0].endsWith('/review-dispatch.mjs')) {
          // Consume exactly the runner's CLI arguments: it forwards neither token nor callback.
          expect(argv).toEqual(['/daemon/scripts/operations/review-dispatch.mjs', `--pr=${number}`, `--repo=${repo}`]);
          const result = reviewDispatchCli.dispatchCliReview(dispatch, {
            mode, repo: argv[2].slice(7), pr: argv[1].slice(5),
            spawnJob, spawnAgent, wrapReview: false, readBrief: () => 'Review {{PR}}',
            mintSessionId: () => 'runner-owed', ensureSessionCwd: p => p,
            sessionCwdFor: () => join(dir, 'session'), isolateSession: () => ({ worktreeSettings: {} }),
          }, { ...opts, readPr: () => pr(), readRuns: () => [run()] });
          skips.push(result.skipped);
        }
        return '';
      } });
    for (let tick = 0; tick < 3; tick++) await pass();
    expect(skips).toEqual(['same-head-hold', 'same-head-hold', 'same-head-hold']);
    expect(spawnJob).not.toHaveBeenCalled();
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
    const source = readFileSync(join(TEST_DIR, '../../operations/review-dispatch.mjs'), 'utf8');
    const cli = source.slice(source.indexOf('if (IS_CLI)'));
    expect(cli).toContain('dispatchCliReview(dispatchReviewJob,');
    expect(cli).toContain('dispatchCliReview(dispatchReview,');
  });
  it.each(['read-pr', 'read-runs', 'wrong-pr', 'wrong-head', 'missing-labels', 'missing-comments'])
  ('the plain CLI refuses unreadable or mismatched spawn authorization (%s)', variant => {
    const snapshot = pr();
    if (variant === 'wrong-pr') snapshot.number++;
    if (variant === 'wrong-head') snapshot.headRefOid = 'b'.repeat(40);
    if (variant === 'missing-labels') delete snapshot.labels;
    if (variant === 'missing-comments') delete snapshot.comments;
    expect(reviewDispatchCli.claimCliReviewDispatch({ headSha: head }, { repo, pr: number,
      readPr: () => { if (variant === 'read-pr') throw new Error('unreadable PR'); return snapshot; },
      readRuns: () => { if (variant === 'read-runs') throw new Error('unreadable runs'); return []; },
    })).toBe(false);
  });
  it('the plain CLI preserves ordinary new-head reviews and explicit trusted re-arms', () => {
    const authorize = (p, runs) => reviewDispatchCli.claimCliReviewDispatch({ headSha: head }, {
      repo, pr: number, readPr: () => p, readRuns: () => runs, now: 10,
    });
    expect(authorize(pr(), [])).toBe(true);
    const rearm = { author: { login: 'chalbert' }, createdAt: new Date(5).toISOString(),
      body: '🔁 review — changes requested' };
    expect(authorize(pr({ comments: [rearm] }), [run()])).toBe(true);
    expect(authorize(pr({ comments: [{ ...rearm, author: { login: 'stranger' } }] }), [run()])).toBe(false);
  });
  it.each(['repo', 'pr', 'head', 'ci-head', 'malformed-head'])
  ('rejects owed-red-team dispatch identity independently of the claim guard (%s)', field => {
    const token = { repo, pr: number, head };
    if (field === 'repo') token.repo = 'other/repo';
    if (field === 'pr') token.pr++;
    if (field === 'head') token.head = 'b'.repeat(40);
    if (field === 'malformed-head') token.head = 'bad';
    const spawnJob = vi.fn(), beforeSpawn = vi.fn(() => true);
    expect(dispatch({ owedRedTeamReview: token, beforeSpawn, spawnJob,
      ciGate: () => ({ allowed: true, headSha: field === 'ci-head' ? 'c'.repeat(40) : head }),
    }).skipped).toBe('owed-red-team-identity');
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(spawnJob).not.toHaveBeenCalled();
  });
  it('keeps the A3 acceptance-to-test manifest aligned with its named cases and required variants', () => {
    const card = readFileSync(join(TEST_DIR, '../../../backlog/6273-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md'), 'utf8');
    const manifest = JSON.parse(card.match(/```acceptance-tests\n([\s\S]*?)\n```/)[1]);
    expect(manifest.A3).toEqual({ test: identityTestName, variants: identityChangeTypes });
    expect(identityChangeTypes.map(c => c.kind)).toEqual(['source', 'documentation', 'configuration', 'data']);
  });
  it.each(identityChangeTypes)
  (`${identityTestName} ($kind)`, ({ file }) => {
    for (const variant of ['owed', 'posted', 'untrusted-author', 'wrong-repo', 'wrong-pr', 'wrong-head', 'marker-pr', 'marker-head']) {
      save([row({ netChangedFiles: [file], ...(variant === 'wrong-repo' ? { repo: 'other/repo' } : {}),
        ...(variant === 'wrong-pr' ? { pr: number + 1 } : {}), ...(variant === 'wrong-head' ? { rev: 'b'.repeat(40) } : {}) })]);
      const p = pr({ files: [{ path: file }], comments: ['posted', 'untrusted-author', 'marker-pr', 'marker-head'].includes(variant)
        ? [{ author: { login: variant === 'untrusted-author' ? 'stranger' : 'chalbert' },
          body: redTeamMarker(variant === 'marker-pr' ? number + 1 : number, variant === 'marker-head' ? 'b'.repeat(40) : head) }] : [] });
      const eligible = ['owed', 'untrusted-author', 'marker-pr', 'marker-head'].includes(variant);
      const [enriched] = enrichPrsWithReferralHolds([p], { ...opts, readRuns: () => [run()] });
      expect(enriched.owedRedTeamReview, variant).toEqual(eligible ? { repo, pr: number, head } : undefined);
      expect(claimReviewDispatch(p, opts), variant).toBe(eligible);
      rmSync(opts.redTeam.stateDir, { recursive: true, force: true });
    }
  });
  it('retains the hold when capped-thread expansion reveals the posted marker', () => {
    const snapshot = Array.from({ length: 100 }, () => ({ body: 'old comment' }));
    const readComments = vi.fn(() => [...snapshot, { author: { login: 'chalbert' }, body: redTeamMarker(number, head) }]);
    const p = pr({ comments: snapshot });
    const [enriched] = enrichPrsWithReferralHolds([p], { ...opts, readRuns: () => [run()], readComments });
    expect(enriched.referralHold).toMatchObject({ kind: 'same-head' });
    expect(enriched.owedRedTeamReview).toBeUndefined();
    expect(claimReviewDispatch(p, { ...opts, readComments })).toBe(false);
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('does not spend the release during non-review reconcile planning or ledger decisions', () => {
    const enrich = () => enrichPrsWithReferralHolds([pr()], { ...opts, readRuns: () => [run()] })[0];
    expect(enrich().referralHold).toBeNull();
    expect(enrich().referralHold).toBeNull();
    expect(decide()).toBeNull();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('does not spend the release through the fix daemon defaultReadNotesForRepo path', () => {
    const reconcile = ({ readPrs }) => {
      const [p] = enrichPrsWithReferralHolds(readPrs(), { ...opts, readRuns: () => [run()] });
      expect(p.referralHold).toBeNull();
      return { notes: [] };
    };
    for (let tick = 0; tick < 2; tick++) defaultReadNotesForRepo({ repo, reconcile, readPrs: () => [pr()] });
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
    expect(claim()).toBe(true);
  });
  it('keeps ledger sameHeadToday decisions without a redTeam option read-only and fail-closed', () => {
    expect(decideSameHeadHold(pr(), [run()], { repo, env: opts.env })).toMatchObject({ kind: 'same-head' });
    expect(decideSameHeadHold(pr({ comments: undefined }), [run()], { repo, env: opts.env }))
      .toMatchObject({ kind: 'same-head' });
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it.each(['review:pending', 'review:accepted'].flatMap(label =>
    [false, true].flatMap(marker => [null, 'standards', 'test-shard (1)'].map(missing => ({ label, marker, missing })))))
  ('carries the owed-comment exception through the real reconcile planner ($label, marker=$marker, missing=$missing)', ({ label, marker, missing }) => {
    const [p] = enrichPrsWithReferralHolds([pr({ labels: [{ name: label }],
      comments: marker ? [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${head} -->` }] : [],
      headRefName: 'lane/redteam-comment-retry', state: 'OPEN', isDraft: false,
      // The default WE review policy waits for these fast checks as well as refusing required CI failures.
      mergeStateStatus: 'CLEAN', statusCheckRollup: ['test', 'standards', 'test-shard (1)']
        .filter(name => name !== missing).map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    })], { ...opts, now: 3, readRuns: () => [run()] });
    expect(p.owedRedTeamReview).toEqual({ repo, pr: number, head });
    // Match reconcile-pass: evidence uses the GitHub slug; the pure planner uses the internal key.
    const plan = planReconcile({ repo: repoKeyForSlug(repo), prs: [p], agents: [], requiredChecks: ['test'], now: 3 });
    if (missing) {
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci',
        ci: expect.objectContaining({ affected: [{ name: missing, reason: 'missing' }] }) }));
    } else {
      expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: number,
        owedRedTeamReview: p.owedRedTeamReview, labels: [label] }));
      expect(plan.dispatch).toHaveLength(1);
    }
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it.each(['missing', 'spent', 'posted', 'wrong-repo', 'wrong-pr', 'wrong-head', 'held', 'draft'])
  ('does not dispatch an accepted PR with an unavailable owed-comment exception (%s)', variant => {
    if (variant === 'missing') save([]);
    if (variant === 'spent') expect(claim()).toBe(true);
    const [p] = enrichPrsWithReferralHolds([pr({ labels: [{ name: 'review:accepted' }],
      headRefName: 'lane/redteam-comment-retry', state: 'OPEN', isDraft: variant === 'draft',
      mergeStateStatus: 'CLEAN', statusCheckRollup: ['test', 'standards', 'test-shard (1)']
        .map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
      ...(variant === 'posted' ? { comments: [{ author: { login: 'chalbert' }, body: redTeamMarker(number, head) }] } : {}),
    })], { ...opts, now: 3, readRuns: () => [run()] });
    if (variant === 'wrong-repo') p.owedRedTeamReview.repo = 'frontier-ui/frontierui';
    if (variant === 'wrong-pr') p.owedRedTeamReview.pr++;
    if (variant === 'wrong-head') p.owedRedTeamReview.head = 'b'.repeat(40);
    if (variant === 'held') p.referralHold = { kind: 'same-head', why: 'held' };
    const plan = planReconcile({ repo: repoKeyForSlug(repo), prs: [p], agents: [], requiredChecks: ['test'], now: 3 });
    expect(plan.dispatch.filter(d => d.kind === 'review')).toEqual([]);
    expect(existsSync(opts.redTeam.stateDir)).toBe(variant === 'spent');
  });
  it('releases on the first decision in a real Node process without asynchronous reader warmup', () => {
    const source = `
      import { claimReviewDispatch, decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      const pr = ${JSON.stringify(pr())}, runs = ${JSON.stringify([run()])}, opts = ${JSON.stringify(opts)};
      delete opts.redTeam.log;
      opts.redTeam.log = () => {};
      const first = decideSameHeadHold(pr, runs, opts);
      const second = decideSameHeadHold(pr, runs, opts);
      const claimed = claimReviewDispatch(pr, { ...opts, readRuns: () => runs });
      console.log(JSON.stringify([first, second, claimed, decideSameHeadHold(pr, runs, opts)?.kind]));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 30_000 }))).toEqual([null, null, true, 'same-head']);
  });
  it('lifts an owed head using the saved scorecard row', () => {
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (standard)'));
  });
  it('keeps the hold when a trusted comment is already present', () => {
    expect(decide(pr({ comments: [{ body: redTeamMarker(number, head), author: { login: 'chalbert' } }] })))
      .toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold on a different reviewed head', () => {
    const other = 'b'.repeat(40);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toMatchObject({ kind: 'same-head' });
  });
  it.each([
    ['no evidence', []], ['different repo', [row({ repo: 'other/repo' })]],
    ['different PR', [row({ pr: number + 1 })]], ['failed probe', [row({ status: 'error' })]],
    ['miss row only', [row({ dispatchKind: 'red-team-miss' })]],
  ])('keeps the hold with %s', (_, records) => {
    save(records);
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('lifts once, then holds again with the same durable state after a restart', () => {
    expect(decide()).toBeNull();
    expect(claim()).toBe(true);
    const [reservation] = readdirSync(opts.redTeam.stateDir);
    expect(JSON.parse(readFileSync(join(opts.redTeam.stateDir, reservation, 'receipt.json'), 'utf8')))
      .toMatchObject({ repo, pr: number, head });
    const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      console.log(JSON.stringify(decideSameHeadHold(${JSON.stringify(pr())}, ${JSON.stringify([run()])}, ${JSON.stringify(opts)})));
    `], { encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(restarted)).toMatchObject({ kind: 'same-head' });
    // A second head has its own allowance; the first remains spent.
    const other = 'c'.repeat(40);
    save([row(), row({ rev: other })]);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toBeNull();
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold when the tool setting is off and logs its source', () => {
    settings({ reArmOnMissingComment: false });
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (tool)'));
  });
  it.each(['WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])('keeps the allowance unspent while %s is disabled', key => {
    opts.env[key] = '0';
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(claim()).toBe(false);
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
    delete opts.env[key];
    expect(decide()).toBeNull();
  });
  it('honors the platform setting and the environment override', () => {
    writeFileSync(opts.env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ redTeam: { reArmOnMissingComment: false } }));
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (platform)'));
    opts.env.WE_RED_TEAM_REARM_ON_MISSING_COMMENT = 'on';
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (env)'));
  });
  it.each(['store', 'settings', 'platform', 'state'])('keeps the hold on a %s read error', kind => {
    if (kind === 'state') writeFileSync(opts.redTeam.stateDir, 'not a directory');
    else writeFileSync(kind === 'store' ? opts.redTeam.storePath : kind === 'settings'
      ? opts.redTeam.settingsPath : opts.env.WE_PLATFORM_PREFERENCES_FILE, '{unreadable JSON');
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it.each(['store', 'settings', 'platform'])('keeps the hold when the %s file cannot be read', kind => {
    // Reading a directory as UTF-8 raises EISDIR on the host; this exercises actual IO failure, not just parsing.
    if (kind === 'store') opts.redTeam.storePath = dir;
    else if (kind === 'settings') opts.redTeam.settingsPath = dir;
    else opts.env.WE_PLATFORM_PREFERENCES_FILE = dir;
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('does not count an untrusted marker or a marker for another head as posted', () => {
    expect(decide(pr({ comments: [
      { body: redTeamMarker(number, head), author: { login: 'stranger' } },
      { body: redTeamMarker(number, 'b'.repeat(40)), author: { login: 'chalbert' } },
    ] }))).toBeNull();
  });
  it('keeps the hold when the comment snapshot is unavailable', () => {
    expect(decide(pr({ comments: undefined }))).toMatchObject({ kind: 'same-head' });
  });
  it('releases through the production enricher until dispatch claims the allowance', () => {
    const enrich = () => enrichPrsWithReferralHolds([pr()], { ...opts, readRuns: () => [run()] })[0];
    expect(enrich().referralHold).toBeNull();
    expect(enrich().referralHold).toBeNull();
    expect(claim()).toBe(true);
    expect(enrich().referralHold).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold when a prior reservation exists with no receipt', () => {
    mkdirSync(reservationPath(), { recursive: true });
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(claim()).toBe(false);
    expect(decide()).toMatchObject({ kind: 'same-head' });
    const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      console.log(decideSameHeadHold(${JSON.stringify(pr())}, ${JSON.stringify([run()])}, ${JSON.stringify(opts)}).kind);
    `], { encoding: 'utf8', timeout: 30_000 });
    expect(restarted.trim()).toBe('same-head');
  });
  it.each(['writeReceipt', 'renameReceipt'])('keeps the hold after %s fails inside the reservation', effect => {
    const fail = () => { throw new Error('injected receipt failure'); };
    expect(claim({ redTeam: { ...opts.redTeam, [effect]: fail } })).toBe(false);
    expect(existsSync(reservationPath())).toBe(true);
    expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(false);
    expect(claim()).toBe(false);
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('writes a temporary receipt before atomically renaming it at dispatch', () => {
    const writes = [];
    const writeReceipt = (file, body) => {
      expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(false);
      writes.push(file);
      writeFileSync(file, body);
    };
    const renameReceipt = (from, to) => {
      expect(writes).toEqual([from]);
      expect(from).toMatch(/receipt\.json\.\d+\.tmp$/);
      expect(to).toBe(join(reservationPath(), 'receipt.json'));
      // Keep the production rename, including its atomic replacement semantics.
      renameSync(from, to);
    };
    expect(claim({ redTeam: { ...opts.redTeam, writeReceipt, renameReceipt } })).toBe(true);
  });
  it.each(['ci', 'stack', 'cooloff', 'live-job'])('does not spend the release when dispatch is skipped by %s', gate => {
    if (gate === 'live-job') {
      dispatch({ beforeSpawn: () => true }); // Seed only a live-job record, never a rearm receipt.
    }
    const spawnJob = vi.fn(() => 4243);
    const extras = gate === 'ci' ? { ciGate: () => ({ allowed: false, reason: 'unreadable-ci' }) }
      : gate === 'stack' ? { stackCheck: () => ({ skipped: 'stack-held' }) }
      : gate === 'cooloff' ? { readCompletion: () => ({ status: 'done', outcome: 'blocked-on-infra',
        label: 'lane-deferrals:5', updatedAt: new Date().toISOString() }) }
      : { isAlive: () => true };
    expect(dispatch({ ...extras, spawnJob }).skipped).toBeTruthy();
    expect(spawnJob).not.toHaveBeenCalled();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('allows only one competing dispatch and keeps a failed spawn spent', () => {
    const spawnJob = vi.fn(() => { throw new Error('spawn failed'); });
    expect(() => dispatch({ spawnJob })).toThrow('spawn failed');
    expect(dispatch({ spawnJob }).skipped).toBe('same-head-hold');
    expect(spawnJob).toHaveBeenCalledTimes(1);
  });
  it('grants exactly one release to concurrent dispatcher processes', async () => {
    const source = `
      import { claimReviewDispatch } from './scripts/conveyor/review-referral-hold.mjs';
      const opts = ${JSON.stringify(opts)};
      opts.redTeam.log = () => {};
      console.log(JSON.stringify(claimReviewDispatch(${JSON.stringify(pr())}, {
        ...opts, readRuns: () => ${JSON.stringify([run()])},
      })));
    `;
    const results = await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000 })));
    expect(results.map(r => JSON.parse(r.stdout)).sort()).toEqual([false, true]);
  });
  it.each([false, true])('claims immediately before the session spawn (wrapped=%s)', wrapReview => {
    const spawn = vi.fn(() => {
      expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(true);
      return wrapReview ? { handle: 'worker' } : 'backgrounded · worker · review';
    });
    const extras = { mode: 'session', wrapReview, spawnAgent: spawn, launchWrapped: spawn,
      readBrief: () => 'Review {{PR}}', mintSessionId: () => 'owed-test',
      ensureSessionCwd: p => p, sessionCwdFor: () => join(dir, 'session'),
      isolateSession: () => ({ worktreeSettings: {} }) };
    expect(dispatch(extras).skipped).toBeUndefined();
    expect(dispatch(extras).skipped).toBe('same-head-hold');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('wires the daemon claim after lane deferral and pins it to the CI head', () => {
    const claimReview = vi.fn(p => claimReviewDispatch(p, { ...opts, readRuns: () => [run()] }));
    const tick = (lanes, ciHead = head) => runReviewTick({ repo,
      readPrs: () => [pr()], readAgents: () => [], holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number,
        owedRedTeamReview: { repo, pr: number, head } }], refusals: [] }),
      tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      acquirableLanes: () => lanes, claimReview,
      dispatch: o => dispatch({ ...o, ciGate: () => ({ allowed: true, headSha: ciHead }) }),
    });
    expect(tick(0).dispatched).toEqual([]);
    expect(tick(1, 'b'.repeat(40)).dispatched).toEqual([]);
    expect(claimReview).not.toHaveBeenCalled();
    expect(tick(1).dispatched).toHaveLength(1);
    expect(claimReview).toHaveBeenCalledTimes(1);
    expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(true);
  });
  it('preserves ledger-authorized releases that do not request an owed-comment exception', () => {
    const claimReview = vi.fn(() => { throw new Error('must not override the ledger'); });
    const out = runReviewTick({ repo, readPrs: () => [pr()], readAgents: () => [], holdReconcile: () => [],
      // A configured ledger source already authorized this review. There is no owed-comment token.
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number }], refusals: [] }),
      claimReview, acquirableLanes: () => 1, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      dispatch: o => dispatch({ ...o, beforeSpawn: o.beforeSpawn ?? (() => true) }),
    });
    expect(out.dispatched).toHaveLength(1);
    expect(claimReview).not.toHaveBeenCalled();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('claims a standalone daemon tick by fetching comments when shared readers are absent', () => {
    const readComments = vi.fn(() => []);
    const out = runReviewTick({ repo, holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number,
        owedRedTeamReview: { repo, pr: number, head } }], refusals: [] }),
      claimReview: p => claimReviewDispatch(p, { ...opts, readComments }),
      acquirableLanes: () => 1, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      dispatch: o => dispatch(o),
    });
    expect(out.dispatched).toHaveLength(1);
    expect(readComments).toHaveBeenCalledWith({ repo, number });
  });
  it('keeps the hold when dispatch cannot expand the capped comment thread', () => {
    expect(claimReviewDispatch(pr({ comments: Array.from({ length: 100 }, () => ({ body: 'old' })) }), {
      ...opts, readComments: () => { throw new Error('thread read failed'); },
    })).toBe(false);
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it.each([['x.mjs'], ['backlog/1-test.md']])('reposts saved red-team evidence after hold release without invoking the model (%s)', async (file) => {
    expect(decide()).toBeNull();
    let replayInput;
    const loopPayload = { verdict: { verdict: 'accept', loop: { outcome: 'converged' } },
      runId: 'saved-review', stopped: 'complete', findings: { read: {
        title: 'saved red-team pass', diffText: 'diff --git a/x.mjs b/x.mjs\n+fixed',
        netChangedFiles: [file], netBasis: { rev: head },
      } } };
    const spawnJob = vi.fn(() => {
      runReviewJob({ pr: number, repo, pid: 1 }, {
        root: '/daemon', now: () => Date.now(), newActorId: () => 'review-actor',
        readPrevCompletion: () => null, report: () => {}, claim: () => ({ ok: true }),
        updateRecord: () => {}, unclaim: () => {}, acquireLane: () => ({ lanePath: '/lane' }),
        runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
        releaseLane: () => {}, log: () => {},
        // Production runs the asynchronous seat in a synchronous child. Capture that child's input here.
        runRedTeam: input => { replayInput = input; return { status: 'resumed', comment: { status: 'posted' } }; },
        runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }),
      });
      return 4242;
    });
    expect(dispatch({ spawnJob }).jobPid).toBe(4242);
    expect(replayInput?.loopPayload?.findings?.read?.netBasis?.rev).toBe(head);
    const postComment = vi.fn();
    const runSeat = vi.fn(() => { throw new Error('must not call the model'); });
    const runRecheck = vi.fn(() => { throw new Error('must not recheck'); });
    const result = await runRedTeam({ ...replayInput, env: {}, record: false,
    }, { now: () => Date.now(), readRecords: () => [row({ findings: [], provider: 'codex', model: 'saved', callId: 'saved-call' })],
      log: () => {}, listComments: () => [], postComment, runSeat, runRecheck });
    expect(result).toMatchObject({ status: 'resumed', rev: head, comment: { status: 'posted' } });
    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ pr: number, repo,
      body: expect.stringContaining(redTeamMarker(number, head)) }));
    expect(runSeat).not.toHaveBeenCalled();
    expect(runRecheck).not.toHaveBeenCalled();
    expect(spawnJob).toHaveBeenCalledTimes(1);
  });
  it('defers saved card-only effects until acceptance during speculation', async () => {
    const postComment = vi.fn();
    const runSeat = vi.fn(() => { throw new Error('must not call the model'); });
    const result = await speculateRedTeam({ pr: number, repo, env: {}, resume: false,
      read: { diffText: '+card', netChangedFiles: ['backlog/1-test.md'], netBasis: { rev: head } },
    }, { now: () => 1, readRecords: () => [row()], log: () => {}, postComment, runSeat });
    expect(result.status).toBe('prior-row');
    expect(postComment).not.toHaveBeenCalled();
    expect(runSeat).not.toHaveBeenCalled();
  });
  it.each(['job', 'session'].flatMap(mode => ['posted', 'deduped'].map(status => ({ mode, status }))))
  ('dispatches saved-result completion without running a review panel (mode=$mode, comment=$status)', async ({ mode, status }) => {
    let replayInput;
    const forbidden = vi.fn(() => { throw new Error('must not run another review'); });
    const spawnJob = vi.fn(({ argv }) => {
      const rev = argv.find(a => a.startsWith('--owed-red-team-head='))?.split('=')[1];
      expect(rev).toBe(head);
      const out = runReviewJob({ pr: number, repo, owedRedTeamHead: rev, pid: 1 }, {
        root: '/daemon', now: () => 3, readPrevCompletion: () => null, report: () => {},
        claim: () => ({ ok: true }), unclaim: () => {}, log: () => {},
        acquireLane: forbidden, runLoop: forbidden, runExtraSeats: forbidden, runRedTeamGate: forbidden,
        resumeSavedRedTeam: input => { replayInput = input; return { status: 'resumed', comment: { status } }; },
      });
      expect(out).toMatchObject({ outcome: 'carried', verdict: null, lanePath: null });
      expect(reviewJobResult(out, { pr: number, repo })).toMatchObject({ outcome: 'done', blocker: null });
      return 4242;
    });
    const out = dispatch({ mode, owedRedTeamReview: { repo, pr: number, head }, spawnJob, spawnAgent: forbidden });
    expect(out.jobPid).toBe(4242);
    const postComment = vi.fn();
    const result = await resumeSavedRedTeam({ ...replayInput, env: {}, record: false }, {
      readRecords: () => [row({ provider: 'codex', model: 'saved', callId: 'saved', findings: [] }),
        row({ repo: 'other/repo', callId: 'foreign', findings: [] })],
      readRetryPr: () => ({ headRefOid: head, state: 'OPEN', isDraft: false, title: 'saved card' }),
      listComments: () => [], postComment, runSeat: forbidden, runRecheck: forbidden, log: () => {},
    });
    expect(result).toMatchObject({ status: 'resumed', callId: 'saved', comment: { status: 'posted' } });
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it.each(['moved', 'closed', 'draft', 'missing-row', 'foreign-row', 'unreadable'])
  ('refuses saved-result completion without a fresh model fallback (%s)', async variant => {
    const forbidden = vi.fn(() => { throw new Error('unexpected effect'); });
    const result = await resumeSavedRedTeam({ pr: number, repo, rev: head, env: {}, record: false }, {
      readRecords: () => variant === 'missing-row' ? [] : [row(variant === 'foreign-row' ? { repo: 'other/repo' } : {})],
      readRetryPr: () => {
        if (variant === 'unreadable') throw new Error('read failed');
        return { headRefOid: variant === 'moved' ? 'b'.repeat(40) : head,
          state: variant === 'closed' ? 'CLOSED' : 'OPEN', isDraft: variant === 'draft' };
      },
      postComment: forbidden, runSeat: forbidden, runRecheck: forbidden,
    });
    expect(result.status).toBe('error');
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('keeps the hold if fetching the full capped comment thread fails', () => {
    const p = pr({ comments: Array.from({ length: 100 }, () => ({ body: 'old comment' })) });
    expect(enrichPrsWithReferralHolds([p], { ...opts, readRuns: () => [run()],
      readComments: () => { throw new Error('thread read failed'); } })[0].referralHold)
      .toMatchObject({ kind: 'same-head' });
  });
});
