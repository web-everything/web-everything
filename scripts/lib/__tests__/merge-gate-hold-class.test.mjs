import { resolveRequiredChecks } from '../check-state-predicate.mjs';
// @vitest-environment node
import { isCandidacyHold, deferCandidacyHoldsOnPrEvent, loadMergeGateHoldSetting, excusePrMergeGateHolds } from '../merge-gate-hold-class.mjs';
import { formatPrResult } from '../merge-gate-ci.mjs';
import { runDraftPromotionStep } from '../../conveyor/draft-promotion-loop.mjs';
import { readReviewCiGate, readReviewHeadAndLabels } from '../review-ci-gate-io.mjs';
import { describe, it, expect, vi } from 'vitest';
import { parsePrResultTable as rawParse, classifyMergeGateHold, excuseMergeGateRows, resolveMergeGateHoldSetting, readMergeGateVerdict } from '../merge-gate-hold-class.mjs';
import { runReconcilePass } from '../../conveyor/reconcile-pass.mjs';
import { defaultReadHeadCheckState } from '../../operations/promote-draft-pr-dispatch.mjs';

import { GATE_IDS } from '../merge-gate-inventory.mjs';

// Real merge-gate tables list the whole gate inventory; abridged fixtures are completed with passing rows so they
// stay readable. Raw (incomplete) tables are exercised through rawParse and must be refused.
const complete = log => {
  const out = [];
  let seen = null;
  const flush = () => { if (seen) for (const id of GATE_IDS) if (!seen.has(id)) out.push(`  pass              ${id.padEnd(22)} fixture`); seen = null; };
  for (const line of String(log).split('\n')) {
    const bare = line.replace(/^\d{4}-\d\d-\d\dT\S+\s/, '');
    if (/^#\d+:|^merge-gate:/.test(bare)) flush();
    if (/^#\d+: (PASS|HOLD)\s*$/.test(bare)) seen = new Set();
    else if (seen) { const m = /^  (\S+)\s+(\S+)/.exec(bare); if (m) seen.add(m[2]); }
    out.push(line);
  }
  flush();
  return out.join('\n');
};
const parsePrResultTable = (log, n) => rawParse(complete(log), n);
const log4965Raw = `2026-10-12T09:49:30.3934630Z #4965: HOLD
2026-10-12T09:49:30.3936795Z   hold              candidate-label        no "ready-to-merge" label — the drain never considers it
2026-10-12T09:49:30.3938131Z   hold              producer-certified     not AI-generated, no ready-to-merge label, not human-cleared
2026-10-12T09:49:30.3939344Z   pass              default-base           base main vs main
2026-10-12T09:49:30.3946148Z   hold              review-hold-labels     unsatisfied review hold label without review:accepted
2026-10-12T09:49:30.3950221Z   hold              review-acceptance      park: human-gated (review:human) — only a human may clear it [...]
2026-10-12T09:49:30.3953575Z   hold              test-gaming            test-gaming suspected: tests-removed: ...
2026-10-12T09:49:30.3956372Z   pass              red-main-freeze        no freeze (ops/red-main-freeze:red-main-freeze.json + ci.yml@main)
2026-10-12T09:49:30.3959386Z   hold              ledger                 labels: labels hold
2026-10-12T09:49:30.3959878Z merge-gate: HOLD — held`;
// Positive fixture: producer-format green main-CI diagnostic plus the incident table.
const log5008 = `main CI (ci.yml@main): green
#5008: HOLD
  pass              candidate-label        ready-to-merge present
  hold              red-main-freeze        main is RED (freeze: manual freeze: merge-queue switch: ruleset apply (operator go 2026-10-12))
  pass              ledger                 labels: labels clear (ledger not consulted)
merge-gate: HOLD — held`;
const log4965 = complete(log4965Raw);
const candidacy = complete(log4965Raw.split('\n').filter(l => !l.includes('test-gaming')).join('\n'));
const candidacyWithCodeqlHold = candidacy.replace(/^(  )pass(\s+codeql\s)/m, '$1hold$2');
const sha = 'a'.repeat(40);
// These injected REST snapshots represent exhausted SHA-specific pages.
const completeRows = rows => Object.defineProperty(rows, 'rowsComplete', { value: true });
const row = { name: 'merge-gate', id: 123, status: 'COMPLETED', conclusion: 'FAILURE' };
const green = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
const verdict = (log = candidacy) => ({ ...parsePrResultTable(log, log.includes('#5008') ? 5008 : 4965), head_sha: sha, completed_at: '2026-10-12T11:56:08Z' });
const classify = (results, extra = {}) => classifyMergeGateHold({ results, prLabels: ['review:pending'], ...extra });
const opts = (extra = {}) => ({ prNumber: 4965, headSha: sha, labels: ['review:pending'], setting: { value: 'on' }, readVerdict: () => verdict(), ...extra });

describe('strict job table parser', () => {
  it('parses the real #4965 excerpt', () => expect(parsePrResultTable(log4965, 4965)).toMatchObject({ num: 4965, ok: false, results: expect.arrayContaining([{ status: 'hold', id: 'ledger', reason: 'labels: labels hold' }]) }));
  it.each([log4965.replace('candidate-label', 'unknown-gate'), log4965.replace('hold              candidate', 'mystery           candidate'), log4965.replace('producer-certified', 'candidate-label'), log4965.replace('#4965: HOLD', '#4965: PASS')])('rejects malformed or contradictory evidence', log => expect(parsePrResultTable(log, 4965).error).toBeTruthy());
  it('rejects a later table whose footer is missing and rejects incomplete later tables', () => {
    expect(parsePrResultTable(`${log4965}\n#4965: PASS\n  pass ledger clear`, 4965).error).toBeTruthy();
    expect(parsePrResultTable(`${candidacy}\n#4965: HOLD`, 4965).error).toBeTruthy();
  });
});
describe('all matching PR tables fail closed', () => {
  // Full-inventory tables like the real job log: every gate listed, `over` overrides [status, reason] per gate.
  const table = (num, head, over = {}) => [`#${num}: ${head}`, ...GATE_IDS.map(id => {
    const [status, reason] = over[id] ?? ['pass', 'ok'];
    return `  ${status.padEnd(17)} ${id.padEnd(22)} ${reason}`;
  })].join('\n');
  const security = table(7, 'HOLD', { codeql: ['hold', 'CodeQL failed'] });
  const review = table(7, 'HOLD', { 'review-acceptance': ['hold', 'human-only: x'] });
  const footer = '\nmerge-gate: HOLD — held';
  const read = log => ({ ...rawParse(log, 7), head_sha: sha });
  const excuse = log => excuseMergeGateRows([row], opts({ prNumber: 7, readVerdict: () => read(log) }));
  it.each([[security, review], [review, security]])('keeps CodeQL visible and red whichever table comes first', (first, second) => {
    const log = `${first}\n${second}${footer}`;
    const parsed = read(log);
    expect(parsed).toMatchObject({ ok: false, results: expect.arrayContaining([{ status: 'hold', id: 'codeql', reason: 'CodeQL failed' }]) });
    expect(parsed.results).toHaveLength(2 * GATE_IDS.length);
    expect(classify(parsed.results).excused).toBe(false);
    expect(excuse(log)).toEqual({ rows: [row], excused: false });
  });
  it.each(['#7: HOLD\n  bad row', '#7: MAYBE\n  hold review-acceptance x', '#7: HOLD extra\n  hold review-acceptance x', '#7: HOLD', '#7: PASS\n  hold review-acceptance x', `${review}\n  hold review-acceptance duplicate`])('rejects a malformed second table: %s', second => {
    const log = `${review}\n${second}${footer}`;
    expect(read(log).error).toBeTruthy();
    expect(excuse(log)).toEqual({ rows: [row], excused: false });
  });
  it('refuses a review-only table that lacks the full gate inventory (round 3)', () => {
    const partial = '#7: HOLD\n  hold               review-acceptance      human-only: x';
    expect(read(`${partial}${footer}`).error).toMatch(/incomplete verdict table.*codeql/);
    expect(excuse(`${partial}${footer}`)).toEqual({ rows: [row], excused: false });
    // one complete table does not rescue a second partial one
    expect(read(`${review}\n${partial}${footer}`).error).toMatch(/incomplete verdict table/);
    // every gate except codeql: the missing evidence alone keeps it held
    const noCodeql = review.split('\n').filter(l => !l.includes(' codeql ')).join('\n');
    expect(read(`${noCodeql}${footer}`).error).toMatch(/missing gates: codeql/);
  });
  it('keeps matching rows across a complete other-PR table and validates other tables strictly', () => {
    const other = table(8, 'PASS');
    const log = `${review}\n${other}\n${review}${footer}`;
    expect(read(log)).toMatchObject({ ok: false });
    expect(read(log).results).toHaveLength(2 * GATE_IDS.length);
    expect(excuse(log).excused).toBe(true);
    expect(read(`${log}\n${table(7, 'HOLD', { codeql: ['hold', 'failed'] })}`).error).toBeTruthy();
    // an injected other-PR header must not hide our blocking rows (historical unescaped logs)
    const injected = `${review.split('\n').slice(0, 3).join('\n')}\n#8: HOLD\n  hold              codeql                 CodeQL failed\n${review.split('\n').slice(3).join('\n')}${footer}`;
    expect(read(injected).error).toBeTruthy();
    expect(excuse(injected)).toEqual({ rows: [row], excused: false });
    expect(read(`${review}\n#8: HOLD\n  malformed other PR row\n${review}${footer}`).error).toBeTruthy();
  });
  it('still excuses a single complete review-only table', () => {
    expect(excuse(`${review}${footer}`)).toMatchObject({ excused: true, rows: [{ conclusion: 'SUCCESS' }] });
  });
  it('accepts only all-PASS tables as ok; any red main-CI line anywhere clears mainCiGreen (round 3)', () => {
    const pass = table(7, 'PASS');
    const green = 'main CI (ci.yml@main): green', red = 'main CI (ci.yml@main): RED since bbbbbbbbb';
    expect(read(`${green}\n${pass}\n${red}\n${pass}`)).toHaveProperty('error');
    expect(read(`${green}\n${pass}\n${pass}`)).toMatchObject({ ok: true, mainCiGreen: true });
    expect(read(`${green}\n${review}\n${review}${footer}`)).toMatchObject({ ok: false, mainCiGreen: true });
    // a red line after another PR's table, before or after ours, or after the footer
    for (const log of [`${green}\n${red}\n${review}\n${table(8, 'PASS')}${footer}`, `${green}\n${review}${footer}\n${red}`, `${red}\n${green}\n${review}${footer}`]) {
      expect(read(log).mainCiGreen).toBe(false);
    }
  });
  it('rejects a late row with an unknown status word (red-team break)', () => {
    for (const late of ['  unknown           codeql                 security check failed', ' unknown codeql failed', 'FAILED codeql']) {
      const log = `${review}${footer}\n${late}`;
      expect(read(log).error).toMatch(/after the merge-gate footer/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
  });
  it('fails closed on a post-footer gate-shaped row with an unrecognised status token (operator send-back)', () => {
    // review-acceptance held, every other gate passing, then the HOLD footer, then a malformed security row.
    for (const late of [' unknown codeql security check failed', 'fail-closed codeql security check failed']) {
      const log = `${review}${footer}\n${late}`;
      expect(read(log).error).toMatch(/after the merge-gate footer/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
    // Both the status token and the gate id unrecognised: only the table's own row shape gives it away.
    for (const late of ['  unknown           new-gate               security check failed', '  unknown new-gate failed', `runner diagnostic\n  mystery  future-gate  failed`]) {
      const log = `${review}\n${table(8, 'PASS')}${footer}\n${late}`;
      expect(read(log).error).toMatch(/after the merge-gate footer/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
    // Plain diagnostics after the footer stay noise, so the sole review-only HOLD is still excused.
    expect(read(`${review}${footer}\nrunner diagnostic\nPost job cleanup finished`).ok).toBe(false);
    expect(excuse(`${review}${footer}\nrunner diagnostic\nPost job cleanup finished`).excused).toBe(true);
  });
  it('refuses blocking rows moved under a forged other-PR header with padded inventories (round audit)', () => {
    const own = table(7, 'HOLD', { 'review-acceptance': ['hold', 'human-only: x'] });
    const forged = table(8, 'HOLD', { 'test-gaming': ['hold', 'test-gaming suspected'] });
    for (const log of [`${own}\n${forged}${footer}`, `${forged}\n${own}${footer}`]) {
      expect(read(log).error).toMatch(/ambiguous evidence/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
  });
  it('rejects late rows even when another PR header sits between the table and the footer', () => {
    const other = table(8, 'PASS');
    const late = '  hold              codeql                 security check failed';
    for (const log of [`${review}\n${other}${footer}\n${late}`, `${review}\n${other}${footer}\nrunner diagnostic\n${late.trim()}`]) {
      expect(read(log).error).toMatch(/after the merge-gate footer/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
  });
  it('rejects gate rows after the footer (round 3 audit)', () => {
    const late = '  hold              codeql                 CodeQL failed';
    for (const log of [`${review}${footer}\n${late}`, `${review}${footer}\n\n${late}`, `${review}${footer}\nrunner diagnostic\n${late}`, `${review}${footer}\nrunner diagnostic\n${late.trim()}`, `${review}${footer}\n  hold codeql`, `${review}${footer}\nrunner diagnostic\nhold codeql`, `${review}${footer}\nnote: codeql hold`]) {
      expect(read(log).error).toMatch(/after the merge-gate footer/);
      expect(excuse(log)).toEqual({ rows: [row], excused: false });
    }
  });
  it('rejects a footer that sits between tables (truncated later invocation)', () => {
    const log = `${review}${footer}\nmain CI (ci.yml@main): green\n${review}`;
    expect(read(log).error).toBeTruthy();
    expect(excuse(log)).toEqual({ rows: [row], excused: false });
  });
});
describe('hold classification', () => {
  it('excuses candidacy only', () => expect(classify(verdict().results)).toMatchObject({ excused: true, kind: 'candidacy' }));
  it('keeps test-gaming real', () => expect(classify(verdict(log4965).results)).toMatchObject({ excused: false, kind: 'real' }));
  it.each(['codeql', 'test-gaming'])('never excuses a failing %s alongside review holds and a passing duplicate', id => {
    expect(classify([
      { id, status: 'hold', reason: 'security failed' },
      { id: 'review-acceptance', status: 'hold', reason: 'human-only: x' },
      { id, status: 'pass', reason: 'clear' },
    ])).toMatchObject({ excused: false, kind: 'real', others: [{ id, status: 'hold', reason: 'security failed' }] });
  });
  it.each(['codeql', 'default-base', 'manifest-baseline', 'non-empty-body', 'duplicate-id-on-main', 'couple-whole', 'blocked-by'])('keeps %s real', id => expect(classify([{ id, status: 'hold', reason: 'blocked' }]).excused).toBe(false));
  it('never excuses fail-closed or a current candidate', () => {
    expect(classify([{ id: 'candidate-label', status: 'fail-closed' }]).excused).toBe(false);
    expect(classify(verdict().results, { prLabels: [{ name: 'ready-to-merge' }] }).excused).toBe(false);
  });
  it.each([['labels: labels hold', true], ['ledger unavailable', false]])('ledger authority %s', (reason, excused) => expect(classify([{ id: 'ledger', status: 'hold', reason }]).excused).toBe(excused));
  it.each([[{ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }, true], [{ frozen: true }, false], [{ error: 'unreadable' }, false], [{ frozen: false, publishedAt: '2026-10-12T10:00:00Z' }, false]])('stale shared freeze %j', (freeze, excused) => expect(classify(verdict(log5008).results, { freeze, mainCiGreen: true, verdictCompletedAt: '2026-10-12T11:56:08Z' })).toMatchObject({ excused, kind: excused ? 'stale-freeze' : 'real' }));
  it('main CI red is real; combined candidacy + stale freeze is identified', () => {
    const extra = { freeze: { frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }, mainCiGreen: true, verdictCompletedAt: '2026-10-12T11:56:08Z' };
    expect(classify([{ id: 'red-main-freeze', status: 'hold', reason: 'main is RED' }], extra).excused).toBe(false);
    expect(classify([...verdict().results.filter(r => r.id !== 'red-main-freeze'), ...verdict(log5008).results.filter(r => r.status === 'hold')], extra).kind).toBe('candidacy+stale-freeze');
  });
});
describe('settings and row evidence', () => {
  it('resolves all layers and fails closed on any invalid layer', () => {
    expect(resolveMergeGateHoldSetting({ platform: {}, repo: {}, env: {} })).toEqual({ value: 'on', source: 'standard' });
    expect(resolveMergeGateHoldSetting({ platform: {}, repo: {}, env: { MERGE_GATE_CANDIDACY_HOLD_IS_NOT_CI_FAILURE: 'off' } })).toEqual({ value: 'off', source: 'env' });
    expect(resolveMergeGateHoldSetting({ platform: { mergeGate: { candidacyHoldIsNotCiFailure: 'bad' } }, repo: {}, env: {} })).toMatchObject({ value: 'off', why: expect.stringContaining('invalid') });
    expect(resolveMergeGateHoldSetting({ platform: { mergeGate: { candidacyHoldIsNotCiFailure: 'off' } }, repo: { mergeGate: { candidacyHoldIsNotCiFailure: 'on' } }, env: {} }).source).toBe('repo');
  });
  it.each([{ setting: { value: 'off' } }, { readVerdict: () => ({ error: 'no log' }) }, { headSha: 'b'.repeat(40) }, { prNumber: 5000 }, { readVerdict: () => { throw Error('read failed'); } }])('preserves red on missing authority %j', extra => expect(excuseMergeGateRows([row], opts(extra)).rows).toEqual([row]));
  it('annotates only the selected merge-gate and retains every other row', () => {
    const badTest = { ...green, conclusion: 'FAILURE' };
    const out = excuseMergeGateRows([{ ...row, id: 122 }, row, badTest], opts());
    expect(out.rows).toEqual([{ ...row, id: 122 }, { ...row, conclusion: 'SUCCESS', mergeGateHoldExcused: { kind: 'candidacy', holds: expect.any(Array), holdIds: expect.any(Array), headSha: sha, jobId: 123 } }, badTest]);
    expect(excuseMergeGateRows([{ ...row, status: 'completed', conclusion: 'failure' }], opts()).rows[0].conclusion).toBe('success');
  });
  it('never reads a superseded failure', () => {
    const readVerdict = vi.fn();
    excuseMergeGateRows([row, { ...row, id: 124, conclusion: 'SUCCESS' }], opts({ readVerdict }));
    expect(readVerdict).not.toHaveBeenCalled();
  });
  it('reads and caches immutable job evidence with throttled gh', () => {
    const runGh = vi.fn(args => args[1].endsWith('/logs') ? candidacy : JSON.stringify({ head_sha: sha, completed_at: '2026-10-12T11:56:08Z' }));
    const cache = new Map();
    const options = { repo: 'owner/repo', jobId: 123, prNumber: 4965, runGh, cache };
    expect(readMergeGateVerdict(options)).toMatchObject({ num: 4965, head_sha: sha });
    readMergeGateVerdict(options);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(runGh.mock.calls[0][1].throttle.op).toBe('merge-gate-verdict');
  });
});
const identity = x => x;
function plan({ setting = 'on', draft = false, testRed = false, readVerdict = () => verdict(), ...extra } = {}) {
  return runReconcilePass({ env: { WE_REVIEW_START_AFTER: 'ci-green' }, readPrs: () => [{ number: 4965, headRefOid: sha, headRefName: 'lane/4965-example', baseRefName: 'main', labels: [{ name: 'review:pending' }], comments: [], isDraft: draft, statusCheckRollup: [row, { ...green, conclusion: testRed ? 'FAILURE' : 'SUCCESS' }] }],
    readAgents: () => [], enrich: identity, readRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readChecks: () => [row, green],
    readMergeGateVerdict: readVerdict, readFreeze: () => ({ error: 'not needed' }), mergeGateSetting: { value: setting },
    enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
    ...Object.fromEntries(['enrichAlreadyLanded', 'enrichBaseRef', 'enrichSystemFix', 'enrichEscalationBase', 'enrichFixClaims', 'enrichTimeouts', 'enrichReferralHolds', 'enrichLedgerHolds', 'enrichRulings', 'enrichScopeBloat', 'enrichCodeQL', 'enrichMechanicalRound', 'enrichOwedMainRule'].map(k => [k, identity])),
    resolveMainSha: () => null, readPriority: () => null, ...extra });
}
describe('reconcile planner and fresh promotion', () => {
  it('off reproduces ci-heal; unbound excusal cannot admit review', () => {
    expect(plan({ setting: 'off' }).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
    const after = plan();
    expect(after.dispatch.some(d => d.kind === 'ci-heal')).toBe(false);
    expect(after.dispatch.some(d => d.kind === 'review')).toBe(false);
    expect(after.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  });
  it('promotes a candidacy-held draft', () => expect(plan({ draft: true }).dispatch.some(d => d.kind === 'promote-draft')).toBe(true));
  it.each([
    () => { throw Error('unreadable feed'); },
    () => Object.assign([row, green], { rowsComplete: false }),
    () => [row, { ...green, status: 'IN_PROGRESS', conclusion: null }],
    () => [row, { ...green, head_sha: 'b'.repeat(40) }],
    () => [{ ...row, id: 124 }, green],
    () => [{ ...row, status: 'IN_PROGRESS', conclusion: null }, green],
  ])('does not dispatch candidacy-held review without complete current-head green evidence', readChecks => {
    expect(plan({ readChecks }).dispatch.some(d => d.kind === 'review')).toBe(false);
  });
  it.each([{ testRed: true }, { readVerdict: () => ({ error: 'missing' }) }])('keeps real CI failure red (#5020) or unreadable verdict', args => expect(plan(args).dispatch.some(d => d.kind === 'ci-heal')).toBe(true));
  it('does not read freeze for candidacy', () => { const readFreeze = vi.fn(); plan({ readFreeze }); expect(readFreeze).not.toHaveBeenCalled(); });
  it.each([[candidacy, 'green'], [log4965, 'red']])('fresh head read classifies verdict as %s', (log, state) => {
    const readPrLabels = vi.fn(() => ['review:pending']);
    const result = defaultReadHeadCheckState({ repoSlug: 'owner/repo', prNumber: 4965, sha, runGh: () => [row, green].map(r => JSON.stringify(r)).join('\n'), getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readPrLabels, readMergeGateVerdict: () => verdict(log), mergeGateSetting: { value: 'on' } });
    expect(result.state).toBe(state);
    expect(readPrLabels).toHaveBeenCalled();
  });
});

it('reads a shared freeze at most once across a pass', () => {
  const readFreeze = vi.fn(() => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }));
  const readPrs = () => [5008, 5009].map(number => ({ number, headRefOid: sha, headRefName: `lane/${number}-example`, baseRefName: 'main', labels: [{ name: 'review:pending' }], comments: [], isDraft: true, statusCheckRollup: [row, green] }));
  const result = plan({ readPrs, readFreeze, readVerdict: ({ prNumber }) => ({ ...verdict(log5008), num: prNumber }) });
  expect(readFreeze).toHaveBeenCalledTimes(1);
  expect(result.dispatch.filter(d => d.kind === 'promote-draft')).toHaveLength(2);
});
it('keeps all PR rows unchanged when the injected excusal step throws', () => {
  expect(plan({ excuseMergeGateHolds: () => { throw Error('unavailable'); } }).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
});
it('uses a rollup detailsUrl job id and case-insensitive head binding', () => {
  const readVerdict = vi.fn(() => ({ ...verdict(), head_sha: sha.toUpperCase() }));
  const input = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/100/job/123' };
  expect(excuseMergeGateRows([input], opts({ readVerdict })).rows[0].conclusion).toBe('SUCCESS');
  expect(readVerdict).toHaveBeenCalledWith(expect.objectContaining({ jobId: 123, prNumber: 4965 }));
});
it('missing labels, job id or completion never authorize excusal', () => {
  expect(excuseMergeGateRows([row], opts({ labels: undefined }))).toMatchObject({ excused: false, reviewHold: true,
    rows: [{ ...row, mergeGateReviewHold: { holds: expect.any(Array), holdIds: expect.any(Array), headSha: sha, jobId: 123 } }] });
  const noId = { ...row, id: undefined };
  expect(excuseMergeGateRows([noId], opts()).rows).toEqual([noId]);
  const pending = { ...row, status: 'IN_PROGRESS' };
  expect(excuseMergeGateRows([pending], opts()).rows).toEqual([pending]);
});

describe('fast draft promotion merge-gate holds', () => {
  const repo = 'web-everything/web-everything';
  function step(extra = {}) {
    const pr = { number: 4965, state: 'OPEN', isDraft: true, headRefName: 'lane/4965-example',
      headRefOid: sha, baseRefName: 'main', labels: [], isCrossRepository: false,
      comments: [], body: '', statusCheckRollup: [row, green] };
    const readVerdict = extra.readMergeGateVerdict ?? vi.fn(() => verdict());
    const ready = vi.fn();
    const readHeadCheckState = vi.fn(args => defaultReadHeadCheckState({ ...args,
      runGh: () => [row, green].map(r => JSON.stringify(r)).join('\n'),
      getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readPrLabels: () => [],
      readMergeGateVerdict: readVerdict, mergeGateSetting: { value: 'on' } }));
    const result = runDraftPromotionStep({ repos: [repo], listDrafts: () => [pr],
      readHeadCheckState, readPrView: () => pr, readAgents: () => [], readClaim: () => null,
      readRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), ready, clearAwaiting: vi.fn(),
      readMergeGateVerdict: readVerdict, readFreeze: () => ({ error: 'unused' }), mergeGateSetting: 'on', ...extra });
    return { result, ready, readHeadCheckState, readVerdict, pr };
  }
  it('promotes candidacy-only holds through both fresh readers', () => {
    const out = step();
    expect(out.result.rows[0]).toMatchObject({ action: 'promoted' });
    expect(out.ready).toHaveBeenCalledWith(repo, 4965);
    expect(out.readHeadCheckState).toHaveBeenCalledWith({ repoSlug: repo, sha, prNumber: 4965 });
    expect(out.readVerdict).toHaveBeenCalledTimes(2);
    expect(out.readVerdict).toHaveBeenLastCalledWith({ repo, jobId: 123, prNumber: 4965 });
    expect(out.pr.statusCheckRollup[0].conclusion).toBe('FAILURE');
  });
  it.each(['real', 'unreadable', 'throws', 'off'])('keeps the planner rollup red for %s evidence', kind => {
    const out = step({ readHeadCheckState: () => ({ state: 'green' }),
      mergeGateSetting: kind === 'off' ? 'off' : 'on',
      readMergeGateVerdict: () => {
        if (kind === 'throws') throw Error('offline');
        return kind === 'unreadable' ? { error: 'missing' } : verdict(kind === 'real' ? candidacyWithCodeqlHold : candidacy);
      } });
    expect(out.result.rows[0].action).toBe('skip');
    expect(out.ready).not.toHaveBeenCalled();
  });
  it('keeps a real hold red at the first head read', () => {
    const out = step({ readMergeGateVerdict: () => verdict(candidacyWithCodeqlHold) });
    expect(out.result.rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('read red') });
    expect(out.ready).not.toHaveBeenCalled();
  });
});

describe('fresh review CI merge-gate holds', () => {
  const repo = 'owner/repo';
  const rest = { ...row, status: 'completed', conclusion: 'failure', head_sha: sha,
    details_url: 'https://github.com/owner/repo/actions/runs/100/job/123' };
  function gate(extra = {}) {
    // Historical strict-CI fixture: keep its original refusal contract independent of shipped start timing.
    return readReviewCiGate({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo, pr: 4965, readHead: () => sha, readLabels: () => [],
      readChecks: () => completeRows([rest, { context: 'legacy', state: 'success' }]),
      readRequired: () => ({ source: 'live', checks: ['merge-gate', 'legacy'] }),
      readMergeGateVerdict: () => verdict(), readFreeze: () => ({ error: 'unused' }), mergeGateSetting: 'on', ...extra });
  }
  it('admits classified candidacy-only REST failures and preserves legacy statuses', () => {
    const readVerdict = vi.fn(() => verdict());
    expect(gate({ readMergeGateVerdict: readVerdict })).toMatchObject({ allowed: true, affected: [] });
    expect(readVerdict).toHaveBeenCalledWith({ repo, jobId: 123, prNumber: 4965 });
    expect(rest.conclusion).toBe('failure');
    expect(gate({ readChecks: () => completeRows([rest, { context: 'legacy', state: 'failure' }]) })).toMatchObject({
      allowed: false, affected: [{ name: 'legacy', reason: 'failure' }],
    });
  });
  it('reads head and labels together and uses the final current labels', () => {
    const run = vi.fn()
      .mockReturnValueOnce(JSON.stringify({ headRefOid: sha, labels: [] }))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: sha, labels: [{ name: 'ready-to-merge' }] }));
    expect(gate({ readHead: undefined, readLabels: undefined,
      readHeadAndLabels: args => readReviewHeadAndLabels({ ...args, run }) }).allowed).toBe(false);
    expect(run.mock.calls).toEqual(Array(2).fill([['pr', 'view', '4965', '--repo', repo, '--json', 'headRefOid,labels']]));
    expect(gate({ readHead: undefined, readLabels: undefined,
      readHeadAndLabels: () => ({ headRefOid: sha, labels: [] }) }).allowed).toBe(true);
  });
  it.each([undefined, () => undefined, () => { throw Error('labels unavailable'); }])('preserves red without readable labels', readLabels => {
    expect(gate({ readLabels })).toMatchObject({ allowed: false,
      affected: [{ name: 'merge-gate', reason: 'failure' }] });
  });
  it('admits a proven cleared freeze but refuses unreadable freeze evidence', () => {
    const readMergeGateVerdict = () => ({ ...verdict(log5008), num: 4965 });
    expect(gate({ readMergeGateVerdict,
      readFreeze: () => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }) }).allowed).toBe(true);
    expect(gate({ readMergeGateVerdict, readFreeze: () => { throw Error('offline'); } })).toMatchObject({
      allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }],
    });
  });
  it.each([
    'main CI (ci.yml@main): RED since bbbbbbbbb',
    'main CI (ci.yml@main): UNREADABLE — unavailable',
    '',
    'main CI (ci.yml@main): green\nmain CI (ci.yml@main): RED since bbbbbbbbb',
    'main CI (ci.yml@main): green\nmerge-gate: HOLD — held',
  ])('does not let a cleared manual freeze hide absent or red main-CI evidence: %s', diagnostic => {
    const log = log5008.replace('main CI (ci.yml@main): green', diagnostic);
    expect(gate({ readMergeGateVerdict: () => ({ ...verdict(log), num: 4965 }),
      readFreeze: () => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }) }))
      .toMatchObject({ allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }] });
  });
  it('does not borrow a later invocation main-CI diagnostic after the footer', () => {
    const log = `${log5008.replace('main CI (ci.yml@main): green\n', '')}\nmain CI (ci.yml@main): green`;
    expect(gate({ readMergeGateVerdict: () => ({ ...verdict(log), num: 4965 }),
      readFreeze: () => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }) }).allowed).toBe(false);
  });
  it.each([
    'main is RED (freeze: main CI red since bbbbbbbbb)',
    'main is RED (freeze: automatic red-main freeze: main CI red)',
    'main is RED (freeze: unknown origin mentioning manual freeze: later)',
  ])('keeps %s red after a newer manual freeze was cleared', reason => {
    const log = log5008.replace(/main is RED.*\n/, `${reason}\n`);
    const readFreeze = vi.fn(() => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }));
    expect(gate({ readMergeGateVerdict: () => ({ ...verdict(log), num: 4965 }), readFreeze }))
      .toMatchObject({ allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }] });
    expect(readFreeze).not.toHaveBeenCalled();
  });
  it.each([
    'merge-gate: HOLD — workflow self-check failed — fail closed: cannot compare workflow with main; held',
    'merge-gate: HOLD — main went RED during this run; held',
    'merge-gate: HOLD — held; unexpected failure',
    'merge-gate: PASS — held',
    '',
    '#5009: HOLD\n  hold candidate-label not a candidate\nmerge-gate: HOLD — workflow self-check failed — fail closed: unavailable; held',
    'merge-gate: HOLD — held\nmerge-gate: HOLD — workflow self-check failed — fail closed: unavailable; held',
  ])('keeps job-level failure or incomplete evidence red: %s', footer => {
    const log = candidacy.replace('merge-gate: HOLD — held', footer);
    expect(gate({ readMergeGateVerdict: () => verdict(log) }))
      .toMatchObject({ allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }] });
    expect(plan({ readVerdict: () => verdict(log) }).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
    expect(defaultReadHeadCheckState({ repoSlug: repo, prNumber: 4965, sha,
      runGh: () => JSON.stringify(row), getRequiredChecks: () => ({ checks: ['merge-gate'] }),
      readPrLabels: () => [], readMergeGateVerdict: () => verdict(log), mergeGateSetting: { value: 'on' } }).state).toBe('red');
  });
  it('does not excuse a legacy merge-gate status', () => {
    const readMergeGateVerdict = vi.fn(() => verdict());
    expect(gate({ readChecks: () => completeRows([{ context: 'merge-gate', state: 'failure' },
      { context: 'legacy', state: 'success' }]), readMergeGateVerdict })).toMatchObject({
      allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }],
    });
    expect(readMergeGateVerdict).not.toHaveBeenCalled();
  });
  it.each(['real', 'unreadable', 'throws', 'candidate', 'off'])('refuses %s evidence', kind => {
    const result = gate({ mergeGateSetting: kind === 'off' ? 'off' : 'on',
      readLabels: () => kind === 'candidate' ? [{ name: 'ready-to-merge' }] : [],
      readMergeGateVerdict: () => {
        if (kind === 'throws') throw Error('offline');
        return kind === 'unreadable' ? { error: 'missing' } : verdict(kind === 'real' ? candidacyWithCodeqlHold : candidacy);
      } });
    expect(result).toMatchObject({ allowed: false, reason: 'required-checks-not-successful',
      affected: [{ name: 'merge-gate', reason: 'failure' }] });
  });
});

// PR #6535 round 6: the red-team check is produced by the accepted review, so a fresh head's missing check is
// review work (a candidacy hold), never a CI failure that refuses that same review. A candidate still needs it.
describe('red-team hold is candidacy, not CI repair', () => {
  const freshHead = `#4965: HOLD
  hold              review-acceptance      no review:accepted on the pinned head
  hold              red-team               no red-team check run on head
  pass              codeql                 no failed CodeQL run
merge-gate: HOLD — held`;
  const failed = { name: 'merge-gate', status: 'completed', conclusion: 'failure', head_sha: sha,
    details_url: 'https://github.com/owner/repo/actions/runs/100/job/123' };
  const probe = (extra = {}) => readReviewCiGate({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'owner/repo', pr: 4965,
    readHead: () => sha, readLabels: () => [], readChecks: () => completeRows([failed, { name: 'test', status: 'completed', conclusion: 'success', head_sha: sha }]),
    readRequired: () => ({ source: 'live', checks: ['test', 'merge-gate'] }),
    readMergeGateVerdict: () => verdict(freshHead), readFreeze: () => ({ error: 'unused' }), mergeGateSetting: 'on', ...extra });
  it('admits the review that produces the missing red-team check', () => {
    expect(probe()).toMatchObject({ allowed: true, affected: [] });
  });
  const pendingReason = 'red-team check run in progress or incomplete';
  const pending = freshHead.replace('no red-team check run on head', pendingReason);
  it('admits the review that completes its own pending red-team check', () => {
    expect(probe({ readMergeGateVerdict: () => verdict(pending) })).toMatchObject({ allowed: true, affected: [] });
    expect(classify([{ id: 'red-team', status: 'hold', reason: pendingReason }]))
      .toMatchObject({ excused: true, kind: 'candidacy' });
  });
  it('keeps the pending red-team hold for a ready-to-merge candidate', () => {
    expect(probe({ readLabels: () => [{ name: 'ready-to-merge' }], readMergeGateVerdict: () => verdict(pending) }))
      .toMatchObject({ allowed: false });
    expect(classify([{ id: 'red-team', status: 'hold', reason: pendingReason }], { prLabels: ['ready-to-merge'] }))
      .toMatchObject({ excused: false, kind: 'real' });
  });
  it('does not defer the pending red-team hold on the PR event leg', () => {
    const results = [{ id: 'red-team', status: 'hold', reason: pendingReason }];
    const input = { num: 4965, ok: false, results, blocking: results };
    expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting: 'on' })).toEqual(input);
  });
  it.each(['clear', 'absent'])('admits excused review-acceptance with a %s red-team check', state => {
    const log = state === 'clear'
      ? freshHead.replace('hold              red-team               no red-team check run on head',
        'pass              red-team               red-team check run succeeded on head')
      : freshHead.split('\n').filter(line => !line.includes('red-team')).join('\n');
    expect(probe({ readMergeGateVerdict: () => verdict(log) })).toMatchObject({ allowed: true, affected: [] });
  });
  it('requires the exact pending reason, red-team id and hold status for candidacy', () => {
    expect(isCandidacyHold({ id: 'red-team', status: 'fail-closed', reason: pendingReason })).toBe(false);
    expect(isCandidacyHold({ id: 'codeql', status: 'hold', reason: pendingReason })).toBe(false);
    expect(isCandidacyHold({ id: 'red-team', status: 'hold', reason: `${pendingReason}: unknown` })).toBe(false);
  });
  // Every reason readRedTeamCheckFact / the publication-hold reads can emit besides plain absence or pending (all `ok:false`, so
  // merge-gate-ci renders them `hold`): each is a real hold the review gate must not excuse.
  const realReasons = [
    'red-team check run failed (failure)',
    'WE_APP_ID unset or invalid; configure the WE App repository variable',
    'red-team check runs unreadable: offline',
    'red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history',
    'no red-team check run on head for owner/repo#4965: external_id missing or mismatching',
    'red-team head not pinned: no head', 'Unpublished finished red-team round for PR #4965',
  ];
  it.each(realReasons)('keeps a red-team hold for "%s" real, even for a non-candidate', reason => {
    expect(probe({ readMergeGateVerdict: () => verdict(freshHead.replace('no red-team check run on head', reason)) }))
      .toMatchObject({ allowed: false });
    expect(isCandidacyHold({ id: 'red-team', status: 'hold', reason })).toBe(false);
  });
  it('still refuses a candidate, and a fail-closed red-team row stays real', () => {
    expect(probe({ readLabels: () => [{ name: 'ready-to-merge' }] })).toMatchObject({ allowed: false });
    expect(probe({ readMergeGateVerdict: () => verdict(freshHead.replace('hold              red-team', 'fail-closed       red-team')) }))
      .toMatchObject({ allowed: false });
    expect(isCandidacyHold({ id: 'red-team', status: 'hold', reason: 'no red-team check run on head' })).toBe(true);
    expect(isCandidacyHold({ id: 'red-team', status: 'fail-closed', reason: 'no red-team check run on head' })).toBe(false);
  });
  it('never defers a red-team hold on any event: the PR leg is the only red-team gate for a drain-direct merge', () => {
    const results = [{ id: 'red-team', status: 'hold', reason: 'no red-team check run on head' }];
    const input = { num: 4965, ok: false, results, blocking: results };
    for (const mergeEvent of ['pull_request', 'merge_group', undefined]) expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent, setting: 'on' })).toEqual(input);
  });
});

describe('facts-first review CI merge-gate refusals', () => {
  const repo = 'owner/repo';
  const pr = 4965;
  const readRequired = () => ({ source: 'live', checks: ['merge-gate', 'test'] });
  async function gate(failedCheck, live) {
    // The store's completed-failure contract predates early review; exercise its strict policy explicitly.
    const { readReviewCiGateFactsFirst } = await import('../review-facts.mjs');
    return readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo, pr, live, liveHead: () => sha,
      readRequired, mergeGateSetting: 'on',
      lookup: () => ({ facts: { state: 'open', headSha: sha, labels: ['review:pending'],
        checks: ['merge-gate', 'test'].map(name => ({ name, conclusion: name === failedCheck ? 'failure' : 'success' })),
      } }),
    });
  }
  it('re-reads a failed store merge-gate live so a candidacy hold can be allowed', async () => {
    const allowed = { allowed: true, headSha: sha, reason: 'required-checks-successful' };
    const live = vi.fn(() => allowed);
    expect(await gate('merge-gate', live)).toEqual(allowed);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledWith({ repo, pr, readRequired, mergeGateSetting: 'on', policy: { startAfter: 'ci-green', startEarly: 'off' } });
  });
  it('rechecks a stored failure live when the snapshot cannot prove row completeness', async () => {
    const live = vi.fn(() => ({ allowed: true }));
    // Completed-only store rows omit pending checks and legacy statuses; use the live gate.
    expect(await gate('test', live)).toEqual({ allowed: true });
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe('PR-event candidacy deferral', () => {
  const key = 'prEventCandidacyHoldsPass';
  const envKey = 'MERGE_GATE_PR_EVENT_CANDIDACY_HOLDS_PASS';
  const held = (id, reason = 'pending', status = 'hold') => ({ id, reason, status });
  const pending = () => {
    const results = ['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance'].map(id => held(id));
    results.push(held('ledger', 'labels: labels hold'), held('codeql', 'clear', 'pass'));
    // Real tables list the whole inventory, so the formatted table parses without completion.
    for (const id of GATE_IDS) if (!results.some(r => r.id === id)) results.push(held(id, 'clear', 'pass'));
    return { num: 5011, ok: false, results, blocking: results.filter(r => r.status === 'hold'), clearanceCarry: { retained: true } };
  };
  it.each(['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'ledger'])('recognizes only candidacy holds for %s', id => {
    expect(isCandidacyHold(held(id, 'labels: labels hold'))).toBe(true);
    for (const status of ['pass', 'fail-closed', 'skipped-by-policy']) expect(isCandidacyHold(held(id, 'labels: labels hold', status))).toBe(false);
  });
  it('rejects other ledger authority and other gates', () => {
    expect(isCandidacyHold(held('ledger', 'ledger: pending'))).toBe(false);
    expect(isCandidacyHold(held('test-gaming'))).toBe(false);
    expect(isCandidacyHold(null)).toBe(false);
  });
  it('defers candidacy, preserves metadata and inputs, and produces a parseable PASS', () => {
    const input = pending(), before = structuredClone(input);
    const out = deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting: { value: 'on' } });
    expect(out).toMatchObject({ num: 5011, ok: true, blocking: [], clearanceCarry: input.clearanceCarry });
    expect(out.results.slice(0, 5)).toEqual(input.blocking.map(r => ({ ...r, status: 'skipped-by-policy', reason: `candidacy hold deferred to the merge_group run (mergeGate.prEventCandidacyHoldsPass=on): ${r.reason}` })));
    expect(input).toEqual(before);
    expect(rawParse(formatPrResult(out), 5011)).toMatchObject({ ok: true, results: out.results });
  });
  it.each(['merge_group', 'workflow_dispatch', undefined, null, 'PULL_REQUEST', 'pull_request_target'])('leaves event %s unchanged', mergeEvent => {
    const input = pending();
    expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent, setting: 'on' })).toEqual(input);
  });
  it.each(['off', 'invalid', undefined])('leaves setting %s unchanged', setting => {
    const input = pending();
    expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting })).toEqual(input);
  });
  it.each([
    ...['test-gaming', 'manifest-baseline', 'red-main-freeze', 'codeql', 'default-base', 'non-empty-body', 'duplicate-id-on-main', 'couple-whole', 'blocked-by'].map(id => held(id)),
    held('candidate-label', 'unreadable', 'fail-closed'), held('review-acceptance', 'human-only: workflow edit'), held('ledger', 'ledger: blocked'),
  ])('keeps $id / $reason blocking', row => {
    const input = pending(); input.results.push(row); input.blocking.push(row);
    const out = deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting: 'on' });
    expect(out.ok).toBe(false); expect(out.blocking).toEqual([row]);
  });
  it('resolves the second key independently across all layers, failing closed', () => {
    const resolve = options => resolveMergeGateHoldSetting({ key, ...options });
    expect(resolve({})).toEqual({ value: 'on', source: 'standard' });
    expect(resolve({ platform: { mergeGate: { [key]: 'off' } } })).toEqual({ value: 'off', source: 'platform' });
    const platform = { mergeGate: { [key]: 'off' } }, repo = { mergeGate: { [key]: 'on' } };
    expect(resolve({ platform, repo })).toEqual({ value: 'on', source: 'repo' });
    expect(resolve({ platform, repo, env: { [envKey]: 'off' } })).toEqual({ value: 'off', source: 'env' });
    for (const layer of ['platform', 'repo', 'env']) {
      expect(resolve({ [layer]: layer === 'env' ? { [envKey]: 'bad' } : { mergeGate: { [key]: 'bad' } } })).toMatchObject({ value: 'off', source: layer });
    }
    expect(resolve({ platform: { mergeGate: { [key]: 'bad' } }, env: { [envKey]: 'on' } }).value).toBe('off');
    expect(resolve({ readErrors: ['unreadable'] }).value).toBe('off');
    expect(resolve({ repo: { mergeGate: { candidacyHoldIsNotCiFailure: 'off' } } })).toEqual({ value: 'on', source: 'standard' });
  });
  it('loads the new key and logs its effective source once', () => {
    const log = vi.fn();
    const options = { key, env: {}, readFile: () => '{}', readDeclared: () => ({ settings: { mergeGate: { [key]: 'off' } } }), log };
    expect(loadMergeGateHoldSetting(options)).toEqual({ value: 'off', source: 'repo' });
    loadMergeGateHoldSetting(options);
    expect(log.mock.calls).toEqual([['merge-gate · mergeGate.prEventCandidacyHoldsPass=off (source: repo)']]);
  });
});


describe('review-hold annotation (card 273, #5157)', () => {
  it('annotates the latest failing row without making CI green', () => {
    const readVerdict = () => ({ num: 4965, head_sha: sha, ok: false, results: [{ id: 'test-gaming', status: 'hold' }] });
    const out = excuseMergeGateRows([row], opts({ readVerdict }));
    expect(out).toEqual({ excused: false, reviewHold: true, rows: [{ ...row, mergeGateReviewHold: { holds: ['test-gaming'], holdIds: ['test-gaming'], headSha: sha, jobId: 123 } }] });
    expect(excuseMergeGateRows([row], opts({ readVerdict, setting: 'off' }))).toEqual({ rows: [row], excused: false });
    const pr = { number: 4965, headRefOid: sha, labels: ['review:human'], statusCheckRollup: [row] };
    expect(excusePrMergeGateHolds([pr], { mergeGateSetting: 'on', readMergeGateVerdict: readVerdict })[0].statusCheckRollup).toEqual(out.rows);
  });
  it('never annotates fail-closed or mixed real failures', () => {
    for (const results of [[{ id: 'test-gaming', status: 'fail-closed' }], [{ id: 'test-gaming', status: 'hold' }, { id: 'red-main-freeze', status: 'hold' }]]) {
      expect(excuseMergeGateRows([row], opts({ readVerdict: () => ({ num: 4965, head_sha: sha, ok: false, results }) }))).toEqual({ rows: [row], excused: false });
    }
  });
});

it('excusal retains a genuine failure from another workflow run', () => {
  const other = { ...row, id: 122, detailsUrl: 'https://github.com/o/r/actions/runs/10/job/122' };
  const held = { ...row, detailsUrl: 'https://github.com/o/r/actions/runs/20/job/123' };
  const out = excuseMergeGateRows([other, held], opts());
  expect(out.rows).toHaveLength(2);
  expect(out.rows[0]).toEqual(other);
  expect(resolveRequiredChecks({ rows: out.rows, rowsHead: sha, rowsComplete: true, head: sha,
    requiredNames: ['merge-gate'], rosterSource: 'live' }).state).toBe('fail');
  expect(resolveRequiredChecks({ rows: [out.rows[1]], rowsHead: sha, rowsComplete: true, head: sha,
    requiredNames: ['merge-gate'], rosterSource: 'live' }).state).toBe('held');
});

it.each([
  { jobId: 999 }, { headSha: 'b'.repeat(40) }, { holdIds: [] }, { holdIds: ['codeql'] },
])('strict resolution rejects excusal outside its job, head or human hold binding: %j', invalid => {
  const held = { ...row, detailsUrl: 'https://github.com/o/r/actions/runs/20/job/123' };
  const out = excuseMergeGateRows([held], opts());
  const annotated = out.rows[0];
  expect(resolveRequiredChecks({ rows: [{ ...annotated,
    mergeGateHoldExcused: { ...annotated.mergeGateHoldExcused, ...invalid } }],
    rowsHead: sha, rowsComplete: true, head: sha, requiredNames: ['merge-gate'], rosterSource: 'live' }).state).toBe('fail');
});
