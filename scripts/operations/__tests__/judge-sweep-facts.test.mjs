import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildJudgeSweepBundle, finishJudgeSweep, judgeSweepFactsOperation, needsJudgment, JUDGE_SWEEP_REPO } from '../judge-sweep-facts.mjs';
import { createJudgeSweepFactsReader, createShapeCache, operatorGh } from '../judge-sweep-facts-io.mjs';
import { resolveOperation } from '../run.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { renderPanelComment } from '../../lib/review-render.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import * as throttle from '../../lib/gh-throttle.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40), BASE = 'c'.repeat(40), REPO = JUDGE_SWEEP_REPO;
const NOW = Date.parse('2026-10-22T13:00:00Z');
const at = minutes => new Date(NOW - minutes * 60_000).toISOString();
const facts = overrides => ({ number: 1, title: 'fixture', labels: [], headSha: SHA, round: 1, cap: 5,
  redTeam: { state: 'unknown', latestResultId: null, latestOutcome: null }, latestVerdict: null,
  openReferrals: [], openSendBacks: [], lastFixLoop: null, humanRequired: null,
  minutesSinceUpdate: 1, fixerRunning: false, inCi: false, owner: null, evidenceErrors: [], ...overrides });
const pr = overrides => ({ number: 1, title: 'fixture $(touch sentinel)', headRefOid: SHA, baseRefOid: BASE, labels: [],
  updatedAt: at(1), createdAt: at(120), body: '<!-- authored-by-actor: author -->', author: { login: 'author' },
  assignees: [], files: [{ path: 'scripts/x.mjs' }], changedFiles: 1, statusCheckRollup: [], ...overrides });
const comment = (body, minutes = 1, login = 'chalbert') => ({ body, createdAt: at(minutes), author: { login } });
const advisory = ({ head = SHA, findings = [], minutes = 1, outcome = 'changes', login } = {}) => comment([
  renderPanelComment({ findings, verdict: outcome === 'accept' ? 'accept' : 'changes',
    lensVerdicts: { correctness: outcome }, lenses: ['correctness'] }),
  `**Advisory outcome:** \`${outcome}\``, `Net basis: \`${'c'.repeat(40)}..${head}\``,
].join('\n'), minutes, login);
const finding = { file: 'scripts/x.mjs', line: 12, summary: 'loses the current head',
  category: 'correctness', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const memoryCache = () => {
  let text = '{}';
  return createShapeCache({ cacheDir: '/scratch', read: () => text, write: (_p, data) => { text = data; } });
};
function fixture(overrides = {}) {
  const gh = vi.fn(() => JSON.stringify([pr()]));
  const readComments = vi.fn(() => []);
  const shape = vi.fn(() => ({ humanRequired: false }));
  const options = { gh, now: () => NOW, readLedgerRows: () => [], readFixRows: () => [],
    readJobs: () => [], readComments, cache: memoryCache(), shape, baseCap: 5, cardReadable: () => false, ...overrides };
  return { ...options, read: createJudgeSweepFactsReader(options) };
}
afterEach(() => vi.restoreAllMocks());

describe('deterministic first-match judge classification', () => {
  it.each([
    ['at-cap', { round: 5 }],
    ['at-cap', { labels: ['status:round-limit'] }],
    // At a known cap the first rule wins. This gate record also catches an unreadable current round.
    ['red-team-blocked-at-cap', { round: null, redTeam: { state: 'blocked', latestOutcome: 'round-cap' } }],
    ['finding-back-unfixed-more-than-once', { verdictHistory: [{ findings: [{ key: 'k' }] }, { findings: [{ key: 'k' }] }] }],
    ['clean-and-owed-approval', { labels: ['review:human'], latestVerdict: { accepted: true }, redTeam: { state: 'clear' } }],
    ['stalled>45min-no-owner', { minutesSinceUpdate: 46 }],
    ['fixer running', { fixerRunning: true, round: 5 }],
    ['fix-loop active (<60 min)', { minutesSinceFixLoop: 59, round: 5 }],
    ['waiting on review', { round: 4 }],
    ['in CI', { inCi: true, round: 5 }],
    ['in CI', { inCi: true }],
    ['waiting on review', {}],
  ])('%s', (reason, patch) => {
    expect(needsJudgment(facts(patch))).toEqual({ reason,
      needsJudgment: !['fixer running', 'in CI', 'waiting on review', 'fix-loop active (<60 min)'].includes(reason) });
  });
  it('does not confuse nonconsecutive findings or missing red-team evidence with a clean approval', () => {
    expect(needsJudgment(facts({ verdictHistory: [{ findings: [{ key: 'k' }] }, { findings: [] }, { findings: [{ key: 'k' }] }] })).needsJudgment).toBe(false);
    expect(needsJudgment(facts({ labels: ['review:human'], latestVerdict: { accepted: true } })).needsJudgment).toBe(false);
    expect(needsJudgment(facts({ round: 3, cap: 8,
      redTeam: { state: 'blocked', latestOutcome: 'round-cap' } })).needsJudgment).toBe(false);
  });
  it('keeps assigned and running PRs out of the no-owner stall rule, including exactly 45 minutes', () => {
    for (const patch of [{ owner: 'alice' }, { fixerRunning: true }, { minutesSinceUpdate: 45 }]) {
      expect(needsJudgment(facts({ minutesSinceUpdate: 46, ...patch })).needsJudgment).toBe(false);
    }
  });
  it('fails closed on unavailable evidence and names an operator fallback', () => {
    expect(needsJudgment(facts({ evidenceErrors: ['comments unreadable'] }))).toMatchObject({
      needsJudgment: true, reason: expect.stringContaining('inspect PR evidence and rerun') });
  });
  it('builds one complete bundle with counts and no internal classifier inputs', () => {
    const bundle = buildJudgeSweepBundle({ generatedAt: at(0), elapsedMs: 12,
      prs: [facts({ round: 5 }), facts({ number: 2, inCi: true })] });
    expect(bundle).toMatchObject({ generatedAt: at(0), elapsedMs: 12, counts: { needsJudgment: 1, noAction: 1 } });
    expect(bundle.prs).toHaveLength(2);
    expect(bundle.prs[0]).not.toHaveProperty('verdictHistory');
  });
});

describe('injected reader and shared evidence readers', () => {
  it('lists once, includes every PR, and skips comments for plainly in-flight first-round PRs', () => {
    const f = fixture({ gh: vi.fn(() => JSON.stringify([pr({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }), pr({ number: 2 })])),
      readJobs: () => [{ repo: REPO, pr: 2, kind: 'fix-run' }] });
    const bundle = buildJudgeSweepBundle(f.read());
    expect(bundle.prs.map(p => p.reason)).toEqual(['in CI', 'fixer running']);
    expect(bundle.prs.map(p => p.number)).toEqual([1, 2]);
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(f.readComments).not.toHaveBeenCalled();
    expect(f.shape).not.toHaveBeenCalled();
    const args = f.gh.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    for (const field of ['labels', 'headRefOid', 'baseRefOid', 'updatedAt', 'files', 'author']) expect(args.at(-1)).toContain(field);
  });
  it('uses ledger rounds instead of a label guess and retains the latest fix-loop outcome', () => {
    const f = fixture({ readLedgerRows: () => ['b', 'c', 'd', 'e'].map(h => ({ repo: REPO, pr: 1, type: 'review-run', headSha: h.repeat(40), at: at(20) })),
      readFixRows: () => [{ repo: 'we', pr: 1, kind: 'fix', at: at(80) }, { repo: 'we', pr: 1, kind: 'outcome', outcome: 'no-change', at: at(70) },
        { repo: 'frontierui', pr: 1, kind: 'outcome', outcome: 'pushed', at: at(61) }] });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ round: 5, cap: 5, reason: 'at-cap',
      lastFixLoop: { kind: 'outcome', outcome: 'no-change', at: at(70) } });
  });
  it('extracts findings/lens verdicts and detects a key present in consecutive published verdicts', () => {
    const f = fixture({ readComments: () => [advisory({ head: OLD, findings: [finding], minutes: 20 }), advisory({ findings: [finding] })] });
    const row = buildJudgeSweepBundle(f.read()).prs[0];
    expect(row.reason).toBe('finding-back-unfixed-more-than-once');
    expect(row.latestVerdict).toMatchObject({ lensVerdicts: { correctness: 'changes' },
      findings: [{ key: referralFindingKey('correctness', finding), severity: 'broken', class: 'correctness' }] });
  });
  it('credits a trusted grant using the shared additive floor and grant-time round anchor', () => {
    const grant = buildRoundExtensionComment({ repo: REPO, pr: 1, by: 1, actor: 'chalbert',
      channel: 'fixture', reason: 'progress', at: at(1) });
    const f = fixture({ readComments: () => [comment(grant)], readLedgerRows: () =>
      ['b', 'c', 'd', 'e', 'f', '1', '2'].map(h => ({ repo: REPO, pr: 1, type: 'review-run', headSha: h.repeat(40), at: at(20) })) });
    // Seven reviewed heads at grant time + one grant exceeds the additive floor of six.
    expect(f.read().prs[0]).toMatchObject({ round: 8, cap: 8 });
    const forged = fixture({ readComments: () => [comment(grant, 1, 'untrusted-user')] });
    expect(forged.read().prs[0].cap).toBe(5);
  });
  it('requires trusted, live-head acceptance AND red-team evidence before reporting owed approval', () => {
    const comments = [advisory({ outcome: 'accept' }), comment(redTeamMarker(1, SHA))];
    const f = fixture({ gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]), readComments: () => comments });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ reason: 'clean-and-owed-approval', humanRequired: false,
      redTeam: { state: 'clear', latestResultId: expect.any(String) } });
    comments[0] = advisory({ outcome: 'accept', login: 'untrusted-user' });
    expect(buildJudgeSweepBundle(f.read()).prs[0].needsJudgment).toBe(false);
    comments[0] = advisory({ outcome: 'accept', head: OLD });
    expect(buildJudgeSweepBundle(f.read()).prs[0].needsJudgment).toBe(false);
  });
  it('reads active referrals through the shared reader and reports an unruled finding', () => {
    const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-fixture';
    const record = { version: 1, repo: REPO, pr: 1, head: SHA, runId,
      reviewer: mandatoryReferralReviewer(runId), authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key: referralFindingKey(seat, finding), seat, original: finding, finding: normalizeFinding(finding) }], rulings: [] };
    const f = fixture({ readComments: () => [comment(renderReferralRecord(record))] });
    const row = f.read().prs[0];
    expect(row.evidenceErrors).toEqual([]);
    expect(row.openReferrals).toEqual([{ key: referralFindingKey(seat, finding), ruled: false, superseded: false }]);
  });
  it('fails closed on malformed markers, a failed comment read, and unavailable process evidence', () => {
    for (const overrides of [
      { readComments: () => [comment('<!-- mandatory-referrals-v1: corrupt -->')] },
      { readComments: () => { throw new Error('offline'); } },
      { readJobs: () => { throw new Error('ps unavailable'); } },
    ]) {
      const row = buildJudgeSweepBundle(fixture(overrides).read()).prs[0];
      expect(row.needsJudgment).toBe(true);
      expect(row.evidenceErrors.length).toBeGreaterThan(0);
    }
  });
  it.each(['red-team:blocked', 'red-team:clear'].flatMap(label => [
    { trigger: 'no shortcut', pending: false, ci: false, fixer: false },
    { trigger: 'review:pending', pending: true, ci: false, fixer: false },
    { trigger: 'in-progress CI', pending: false, ci: true, fixer: false },
    { trigger: 'fixer running', pending: false, ci: false, fixer: true },
    { trigger: 'all shortcuts', pending: true, ci: true, fixer: true },
  ].map(trigger => ({ label, ...trigger }))))(
    'refuses a blocked red-team label without a trusted live result ($label; $trigger)',
    ({ label, pending, ci, fixer }) => {
      const gh = vi.fn(() => JSON.stringify([pr({
        labels: [label, ...(pending ? ['review:pending'] : [])].map(name => ({ name })),
        statusCheckRollup: ci ? [{ name: 'test', status: 'IN_PROGRESS' }] : [],
      })]));
      const f = fixture({ gh, readJobs: () => fixer ? [{ repo: REPO, pr: 1, kind: 'fix-run' }] : [] });
      // Operator rule: a live fixer claim or CI in flight wins (noAction); the evidence gap is still reported.
      expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject(ci || fixer
        ? { needsJudgment: false, reason: fixer ? 'fixer running' : 'in CI',
          evidenceErrors: ['red-team label lacks live result evidence'] }
        : { needsJudgment: true, reason: 'evidence-unavailable: inspect PR evidence and rerun',
          evidenceErrors: ['red-team label lacks live result evidence'] });
      expect(f.readComments).toHaveBeenCalledTimes(1);
      expect(gh).toHaveBeenCalledTimes(1);
    });
  it('refuses incomplete/oversized listings with an explicit operator fallback', () => {
    for (const listing of [Array.from({ length: 200 }, (_, i) => pr({ number: i + 1 })), [pr({ labels: null })], [pr({ headRefOid: '' })]]) {
      expect(() => fixture({ gh: () => JSON.stringify(listing) }).read()).toThrow(/inspect PR evidence.*operator query/);
    }
  });
  it('shares a hard 128-call budget across comment pages and PRs', () => {
    const tsv = Array.from({ length: 100 }, () => `ordinary\t${at(1)}\tchalbert\tcomment-id\thttps://example.test/comment`).join('\n');
    const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify([pr(), pr({ number: 2 })]) : tsv);
    const f = fixture({ gh, readComments: undefined });
    const row = buildJudgeSweepBundle(f.read());
    expect(gh).toHaveBeenCalledTimes(128);
    expect(gh.mock.calls.filter(([args]) => args[0] === 'pr')).toHaveLength(1);
    expect(row.prs.every(p => p.needsJudgment && p.evidenceErrors.length)).toBe(true);
    expect(gh.mock.calls.at(-1)[0]).toContain('page=127');
    expect(gh.mock.calls.slice(1).every(([args]) => !args.includes('--paginate'))).toBe(true);
  });
  it('fetches complete short comment threads through the shared paged TSV reader', () => {
    const gh = vi.fn(args => args[0] === 'pr' ? JSON.stringify([pr()]) : `hello\\nworld\t${at(1)}\tchalbert\tid\thttps://example.test\n`);
    const f = fixture({ gh, readComments: undefined });
    expect(f.read().prs[0].evidenceErrors).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[1][0]).toContain(`repos/${REPO}/issues/1/comments`);
  });
});

describe('shape cache and operator credential boundary', () => {
  it('calls shape only on a human PR cache miss, persists false, and misses again on a new head', () => {
    let head = SHA;
    const cache = memoryCache();
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ headRefOid: head, labels: [{ name: 'review:human' }] })]) });
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.shape).toHaveBeenCalledTimes(1);
    expect(f.shape).toHaveBeenCalledWith(['scripts/x.mjs']);
    head = OLD;
    f.read();
    expect(f.shape).toHaveBeenCalledTimes(2);
  });
  it('recomputes humanRequired after base changes with an unchanged head', () => {
    let base = BASE;
    let files = ['README.md'];
    const f = fixture({ gh: () => JSON.stringify([pr({ baseRefOid: base, headRefOid: SHA,
      labels: [{ name: 'review:human' }], files: files.map(path => ({ path })), changedFiles: files.length })]),
      shape: vi.fn(paths => ({ humanRequired: paths.includes('AGENTS.md') })) });
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.read().prs[0].humanRequired).toBe(false);
    expect(f.shape).toHaveBeenCalledTimes(1);
    base = OLD;
    files = ['README.md', 'AGENTS.md'];
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(2);
    expect(f.shape).toHaveBeenLastCalledWith(['README.md', 'AGENTS.md']);
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(2);
  });
  it('loads a persisted head-and-base cache without shape or net-file reads', () => {
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ [`${REPO}:${SHA}:${BASE}`]: true }), write: () => { throw new Error('no write'); } });
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ files: null, labels: [{ name: 'review:human' }] })]) });
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).not.toHaveBeenCalled();
  });
  it('discards historical head-only false entries and recomputes from the net files', () => {
    const oldKey = `${REPO}:${SHA}`;
    let saved;
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ [oldKey]: false }),
      write: (_p, data) => { saved = JSON.parse(data); } });
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]),
      shape: vi.fn(() => ({ humanRequired: true })) });
    expect(f.read().prs[0].humanRequired).toBe(true);
    expect(f.shape).toHaveBeenCalledTimes(1);
    expect(saved).toEqual({ [`${REPO}:${SHA}:${BASE}`]: true });
  });
  it.each([undefined, '', 'unreadable'])('fails closed when base identity is unavailable: %s', baseRefOid => {
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => JSON.stringify({ [`${REPO}:${SHA}:${BASE}`]: false }),
      write: () => { throw new Error('no cache write'); } });
    const f = fixture({ cache, gh: () => JSON.stringify([pr({ baseRefOid, labels: [{ name: 'review:human' }] })]) });
    expect(buildJudgeSweepBundle(f.read()).prs[0]).toMatchObject({ humanRequired: null, needsJudgment: true,
      evidenceErrors: ['shape unavailable; inspect full diff before delegating'] });
    expect(f.shape).not.toHaveBeenCalled();
  });
  it('treats corrupt cache as a miss and bounds persisted cache size', () => {
    let saved;
    const cache = createShapeCache({ cacheDir: '/scratch', read: () => '{bad', write: (_p, data) => { saved = data; } });
    expect(cache.get(`${REPO}:${SHA}:${BASE}`)).toBeUndefined();
    for (let i = 0; i < 300; i++) cache.set(`${REPO}:${i.toString(16).padStart(40, '0')}:${BASE}`, false);
    expect(Object.keys(JSON.parse(saved))).toHaveLength(256);
    expect(saved.length).toBeLessThan(128 * 1024);
  });
  it('fails closed on a truncated net-file list or malformed shape instead of caching false', () => {
    for (const overrides of [
      { gh: () => JSON.stringify([pr({ files: [], changedFiles: 200, labels: [{ name: 'review:human' }] })]) },
      { gh: () => JSON.stringify([pr({ labels: [{ name: 'review:human' }] })]), shape: () => ({}) },
    ]) {
      const row = buildJudgeSweepBundle(fixture(overrides).read()).prs[0];
      expect(row).toMatchObject({ humanRequired: null, needsJudgment: true });
      expect(row.evidenceErrors).toContain('shape unavailable; inspect full diff before delegating');
    }
  });
  it('unsets both environment tokens and uses the operator binary inside gh-throttle with no retries', () => {
    const call = vi.spyOn(throttle, 'runGhSync').mockReturnValue('[]');
    operatorGh(['pr', 'list']);
    expect(call).toHaveBeenCalledWith(['pr', 'list'], expect.objectContaining({
      throttle: { bin: '/opt/homebrew/bin/gh', personalRoute: false, maxAttempts: 1 },
    }));
    const options = call.mock.calls[0][1];
    expect(options.env).not.toHaveProperty('GH_TOKEN');
    expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('declared CLI registration', () => {
  it('registers compute-only with no sinks', () => {
    const { declaration, sinks } = resolveOperation('judge-sweep-facts');
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(sinks).toEqual({});
  });
  it('escapes terminal and bidi controls while preserving inert untrusted titles in JSON', () => {
    const title = '$(touch sentinel)\u001b[31m\u009b\u202e';
    const result = finishJudgeSweep({ code: 0, run: { verdict: { prs: [{ title }] } } });
    expect(result.lines[0]).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(JSON.parse(result.lines[0]).prs[0].title).toBe(title);
  });
  it('prints exactly one JSON bundle with or without --json using only an in-memory run store', async () => {
    for (const argv of [[], ['--json']]) {
      const declaration = judgeSweepFactsOperation({ readFacts: fixture().read });
      const registry = createRegistry();
      registry.register(declaration);
      const store = createMemoryRunStore();
      const outcome = await runOperationCli({ declaration, registry, sinks: {}, store, argv, newRunId: () => 'judge-sweep-fixture' });
      const printed = finishJudgeSweep(outcome);
      expect(printed.code).toBe(0);
      expect(printed.lines).toHaveLength(1);
      expect(JSON.parse(printed.lines[0])).toMatchObject({ counts: { needsJudgment: 0, noAction: 1 }, prs: [{ number: 1 }] });
    }
  });
});
