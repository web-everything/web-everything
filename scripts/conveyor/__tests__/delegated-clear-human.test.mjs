// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKERS, clearHumanViaCli, createEventEmitter, resolveDelegatedClearHumanMode, loadDelegatedClearHumanMode,
  evaluateEligibility, runDelegatedClearHuman, redTeamAtHead, liveReaders, main } from '../delegated-clear-human.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const labels = ['review:human', 'advisory:accepted', 'red-team:clear'];
const pr = (over = {}) => ({ number: 7, headRefOid: HEAD, labels, ...over });
const advisory = (head = HEAD, outcome = 'accept') => ({ author: { login: 'web-everything' },
  body: `**Verdict:** accept\n**Advisory outcome:** ${outcome}\nNet basis: \`${OTHER}..${head}\`` });
const row = (name = 'test', conclusion = 'SUCCESS', startedAt = '2026-11-19T12:00:00Z') =>
  ({ name, status: 'COMPLETED', conclusion, head_sha: HEAD, startedAt, app: { id: 1, slug: 'ci' } });
const deps = (over = {}) => ({
  readPr: p => p, readComments: () => [advisory()],
  readRedTeam: () => ({ clear: true, evidence: { ok: true } }), readPublicationHold: () => null,
  readReview: () => ({ head: HEAD, findings: [] }),
  readRequiredChecks: () => ({ checks: ['test', 'merge-gate'], source: 'live' }),
  readChecks: () => [row(), row('merge-gate', 'FAILURE')],
  scoreNet: () => ({ scored: true, humanRequired: false, signals: {}, files: 3, diffLines: 10 }),
  readFiles: () => ['src/a.mjs'], readLiveHead: () => HEAD, ...over,
});
const evaluate = (over = {}, p = pr()) => evaluateEligibility(p, deps(over));
const sweep = (over = {}) => runDelegatedClearHuman({ prs: [pr()], mode: 'shadow', ...deps(),
  emit: async () => {}, clearHuman: async () => {}, refreshGate: async () => {}, ...over });

describe('mode setting', () => {
  it('ships off in the declared feature file', () => {
    expect(JSON.parse(readFileSync(new URL('../../settings/auto-clear-human.json', import.meta.url))).orchestrator.autoClearHuman).toBe('off');
    expect(resolveDelegatedClearHumanMode()).toMatchObject({ value: 'off', source: 'standard' });
  });
  it.each(['off', 'shadow', 'on'])('resolves %s with provenance', mode => {
    expect(resolveDelegatedClearHumanMode({ repo: { orchestrator: { autoClearHuman: mode } } })).toEqual({ value: mode, source: 'tool' });
  });
  it('cascades platform, tool and environment through policy-cascade', () => {
    expect(resolveDelegatedClearHumanMode({ platform: { orchestrator: { autoClearHuman: 'on' } },
      repo: { orchestrator: { autoClearHuman: 'shadow' } }, env: { WE_AUTO_CLEAR_HUMAN: 'off' } })).toEqual({ value: 'off', source: 'env' });
  });
  it.each(['invalid', null, 1])('invalid new or legacy mode %s disables instead of inheriting on', value => {
    for (const repo of [{ orchestrator: { autoClearHuman: value } }, { delegatedClearHuman: { mode: value } }])
      expect(resolveDelegatedClearHumanMode({ platform: { delegatedClearHuman: { mode: 'on' } }, repo }).value).toBe('off');
  });
  it('aliases legacy mode; the new key wins even over a legacy env value', () => {
    expect(resolveDelegatedClearHumanMode({ repo: { delegatedClearHuman: { mode: 'shadow' } } }).value).toBe('shadow');
    expect(resolveDelegatedClearHumanMode({ repo: { orchestrator: { autoClearHuman: 'off' }, delegatedClearHuman: { mode: 'on' } },
      env: { WE_DELEGATED_CLEAR_HUMAN_MODE: 'on' } }).value).toBe('off');
  });
  it('unreadable declared settings disable', () => {
    expect(loadDelegatedClearHumanMode({ readDeclared: () => ({ errors: ['bad'] }), readPlatform: () => ({ prefs: {} }) }).value).toBe('off');
  });
});

describe('seven-clause predicate', () => {
  it('accepts complete evidence and records every fact', () => {
    const r = evaluate();
    expect(r.failed).toEqual([]);
    expect(r.evidence).toMatchObject({ head: HEAD, labels, advisory: { head: HEAD, basis: `${OTHER}..${HEAD}` }, redTeam: { evidence: { ok: true } },
      publicationHold: null, securityFindings: [], requiredChecks: { checks: ['test', 'merge-gate'] },
      checkRows: expect.any(Array), score: { files: 3, diffLines: 10 }, workflowEdit: { hold: false }, liveHead: HEAD });
  });
  it.each(BLOCKERS)('refuses blocker label %s', label => {
    expect(evaluate({}, pr({ labels: [...labels, label] })).failed).toContain(label);
  });
  it('requires review:human', () => expect(evaluate({}, pr({ labels: labels.slice(1) })).failed).toContain('review-human'));
  it('requires advisory:accepted even with review:accepted', () => {
    expect(evaluate({}, pr({ labels: ['review:human', 'review:accepted', 'red-team:clear'] })).failed).toContain('advisory-label');
  });
  it('requires an accept ruling', () => expect(evaluate({ readComments: () => [advisory(HEAD, 'changes')] }).failed).toContain('advisory-ruling'));
  it('rejects an older advisory basis', () => expect(evaluate({ readComments: () => [advisory(OTHER)] }).failed).toContain('advisory-head'));
  it('rejects a forged advisory', () => expect(evaluate({ readComments: () => [{ ...advisory(), author: { login: 'attacker' } }] }).eligible).toBe(false));
  it('requires the latest advisory to accept', () => expect(evaluate({ readComments: () => [advisory(), advisory(HEAD, 'changes')] }).eligible).toBe(false));
  it('requires red-team label and settled clear evidence', () => {
    expect(evaluate({}, pr({ labels: labels.slice(0, 2) })).failed).toContain('red-team');
    expect(evaluate({ readRedTeam: () => ({ clear: false, evidence: { ok: true } }) }).failed).toContain('red-team');
    expect(evaluate({ readRedTeam: () => ({ clear: true, evidence: { ok: false } }) }).failed).toContain('red-team');
  });
  it('refuses a publication hold', () => expect(evaluate({ readPublicationHold: () => 'unpublished' }).failed).toContain('red-team-publication'));
  it.each(['security', '', ' /correctness'])('refuses security-class lens %s including empty', category => {
    expect(evaluate({ readReview: () => ({ head: HEAD, findings: [{ category }] }) }).failed).toContain('security-finding');
  });
  it('refuses a review from another head or unreadable findings', () => {
    expect(evaluate({ readReview: () => ({ head: OTHER, findings: [] }) }).failed).toContain('unreadable-review');
    expect(evaluate({ readReview: () => ({ head: HEAD }) }).failed).toContain('unreadable-review');
  });
  it.each(['test', 'smoke'])('each required check %s must be present and successful', name => {
    for (const rows of [[row(), row('smoke')].filter(r => r.name !== name),
      [row(), row('smoke')].map(r => r.name === name ? { ...r, conclusion: 'FAILURE' } : r)]) {
      expect(evaluate({ readRequiredChecks: () => ({ checks: ['test', 'smoke'], source: 'live' }), readChecks: () => rows }).eligible).toBe(false);
    }
  });
  it.each(['FAILURE', 'NEUTRAL', 'SKIPPED', ''])('required test conclusion %s refuses', conclusion => {
    expect(evaluate({ readChecks: () => [row('test', conclusion)] }).failed).toContain('required-checks');
  });
  it('refuses an unknown roster or empty rows', () => {
    expect(evaluate({ readRequiredChecks: () => ({ checks: ['test'], source: 'fallback' }) }).eligible).toBe(false);
    expect(evaluate({ readChecks: () => [] }).eligible).toBe(false);
  });
  it('rejects non-required failing checks but ignores merge-gate and review-gate', () => {
    expect(evaluate({ readChecks: () => [row(), row('advisory', 'FAILURE')] }).failed).toContain('other-check');
    expect(evaluate({ readChecks: () => [row(), row('merge-gate', 'FAILURE'), row('review-gate', 'FAILURE')] }).eligible).toBe(true);
  });
  it.each([['FAILURE', 'SUCCESS', true], ['SUCCESS', 'FAILURE', false]])('same-identity later attempt supersedes %s with %s', (old, latest, ok) => {
    const rows = [
      { ...row('test', latest, '2026-11-19T13:00:00Z'), id: 10, run_id: 20, run_attempt: 2 },
      { ...row('test', old), id: 10, run_id: 20, run_attempt: 1 },
    ];
    expect(evaluate({ readChecks: () => rows }).eligible).toBe(ok);
  });
  it.each([
    [{ id: 1, slug: 'ci' }, { id: 2, slug: 'other' }, {}, {}],
    [{ id: 1, slug: 'ci' }, { id: 1, slug: 'ci' }, { workflow_id: 1 }, { workflow_id: 2 }],
  ])('different app/workflow success cannot hide a required failure (%j, %j)', (app, otherApp, workflow, otherWorkflow) => {
    const rows = [
      { ...row('test', 'FAILURE'), app, ...workflow, id: 10, run_id: 20, run_attempt: 1 },
      { ...row('test', 'SUCCESS', '2026-11-19T13:00:00Z'), app: otherApp, ...otherWorkflow, id: 11, run_id: 21, run_attempt: 1 },
    ];
    const result = evaluate({ readChecks: () => rows });
    expect(result.failed).toContain('required-checks');
    expect(result.failed).toContain('other-check');
    expect(result.evidence.checkRows).toEqual(rows);
  });
  it('timestamps alone cannot supersede a failing required attempt', () => {
    const result = evaluate({ readChecks: () => [row('test', 'FAILURE'),
      row('test', 'SUCCESS', '2026-11-19T13:00:00Z')] });
    expect(result.failed).toContain('required-checks');
  });
  it('same-identity later success supersedes an optional failure', () => {
    expect(evaluate({ readChecks: () => [row(), row('optional', 'FAILURE'),
      row('optional', 'SUCCESS', '2026-11-19T13:00:00Z')] }).eligible).toBe(true);
  });
  it.each([undefined, { id: 1, slug: 'ci' }])('ambiguous optional producer identity refuses (%j)', app => {
    const result = evaluate({ readChecks: () => [row(), { ...row('optional', 'FAILURE'), app: undefined },
      { ...row('optional', 'SUCCESS', '2026-11-19T13:00:00Z'), app }] });
    expect(result.failed).toContain('unreadable-check-identities');
  });
  it('unordered duplicate rows fail closed', () => expect(evaluate({ readChecks: () => [row(), row('test', 'FAILURE')] }).eligible).toBe(false));
  it('foreign-head checks refuse', () => expect(evaluate({ readChecks: () => [{ ...row(), head_sha: OTHER }] }).eligible).toBe(false));
  it('gateSelf refuses', () => expect(evaluate({ scoreNet: () => ({ scored: true, humanRequired: false, signals: { gateSelf: ['gate.mjs'] } }) }).failed).toContain('gate-self'));
  it.each([true, undefined, null, 0, 'false'])('humanRequired %j refuses automatic clearance', humanRequired => {
    expect(evaluate({ scoreNet: () => ({ scored: true, humanRequired, signals: {} }) }).failed).toContain('human-required');
  });
  it('missing and unscored scores refuse automatic clearance', () => {
    expect(evaluate({ scoreNet: () => undefined }).failed).toContain('human-required');
    expect(evaluate({ scoreNet: () => ({ scored: false, humanRequired: false, signals: {} }) }).failed).toContain('unreadable-score');
  });
  it('workflow edit refuses', () => expect(evaluate({ readFiles: () => ['.github/workflows/ci.yml'] }).failed).toContain('workflow-edit'));
  it('head re-read must match H', () => expect(evaluate({ readLiveHead: () => OTHER }).failed).toContain('head-moved'));
  it('fresh PR head must match H', () => expect(evaluate({ readPr: () => pr({ headRefOid: OTHER }) }).failed).toContain('head-moved'));
  it('malformed head refuses', () => expect(evaluate({}, pr({ headRefOid: 'abc' })).failed).toContain('head-unpinned'));
  it.each(Object.keys(deps()))('unreadable %s fails closed', name => {
    expect(evaluate({ [name]: () => { throw Error('unreadable'); } }).eligible).toBe(false);
    expect(evaluate({ [name]: () => undefined }).eligible).toBe(false);
  });
});

describe('settled red-team evidence', () => {
  it('settles unknown evidence by the PR comments before planning clear (real settlement helper)', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const comment = { author: { login: 'web-everything' }, createdAt: new Date(now).toISOString(),
      body: renderRedTeamComment({ pr: 7, rev: HEAD, findings: [], provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'accept' }) };
    const raw = { ok: false, reason: 'review-unfinished', settleBounds: { unfinishedUndecided: true,
      unfinishedStartedAt: now - 3600e3, unfinishedActiveAt: now - 3 * 3600e3, evaluatedAt: now,
      completeHeadRead: () => ({ complete: true, blocked: false }) } };
    const plan = vi.fn(({ evidence }) => ({ add: evidence.ok ? 'red-team:clear' : 'red-team:pending', remove: [] }));
    const options = { repo: 'o/r', readEvidence: () => raw, plan };
    expect(redTeamAtHead({ ...pr(), comments: [comment] }, HEAD, options)).toMatchObject({ clear: true, evidence: { settledByComment: 'review-unfinished' } });
    expect(redTeamAtHead({ ...pr(), comments: [] }, HEAD, options).clear).toBe(false);
    expect(plan.mock.calls[0][0].evidence.ok).toBe(true);
  });
});

describe('sweep and writer', () => {
  it('shadow writes nothing and emits would-approve plus a tick', async () => {
    const emit = vi.fn(), clearHuman = vi.fn(), refreshGate = vi.fn();
    const out = await sweep({ emit, clearHuman, refreshGate });
    expect(clearHuman).not.toHaveBeenCalled(); expect(refreshGate).not.toHaveBeenCalled();
    expect(out.wouldApprove).toEqual([7]);
    expect(emit.mock.calls.map(([e]) => e.kind)).toEqual(['would-approve', 'delegated-clear-human-tick']);
    expect(emit.mock.calls[1][0].detail).toEqual({ reviewHumanSeen: 1, wouldApprove: 1, excluded: 0 });
  });
  it('shadow exclusion and an empty sweep still emit one tick', async () => {
    const emit = vi.fn(); await sweep({ emit, readFiles: () => null });
    expect(emit.mock.calls.filter(([e]) => e.kind === 'delegated-clear-human-tick')).toHaveLength(1);
    emit.mockClear(); await sweep({ emit, prs: [] }); expect(emit).toHaveBeenCalledOnce();
  });
  it.each(['off', 'invalid'])('%s writes and emits nothing', async mode => {
    const emit = vi.fn(), clearHuman = vi.fn(); await sweep({ mode, emit, clearHuman });
    expect(emit).not.toHaveBeenCalled(); expect(clearHuman).not.toHaveBeenCalled();
  });
  it.each(['size:over-cap', 'workflow-edit'])('%s emits decision-owed with all facts', async reason => {
    const emit = vi.fn();
    await sweep({ emit, ...(reason === 'workflow-edit' ? { readFiles: () => ['.github/workflows/ci.yml'] } : { prs: [pr({ labels: [...labels, reason] })] }) });
    expect(emit.mock.calls.map(([e]) => e.kind)).toContain(`excluded:${reason}`);
    expect(emit.mock.calls.find(([e]) => e.kind === 'orchestrator-decision-owed')[0].detail).toMatchObject({ head: HEAD, score: { files: 3 }, failed: [reason] });
  });
  it('on writes at most one pinned clearance then refreshes its gate', async () => {
    const clearHuman = vi.fn(), refreshGate = vi.fn();
    const out = await sweep({ mode: 'on', prs: [pr(), pr({ number: 8 })], clearHuman, refreshGate });
    expect(clearHuman).toHaveBeenCalledOnce(); expect(out.cleared).toEqual([7]);
    expect(clearHuman.mock.calls[0][0]).toMatchObject({ pr: 7, head: HEAD, actor: 'orchestrator', reason: expect.stringContaining('checkRows') });
    expect(refreshGate).toHaveBeenCalledWith(expect.objectContaining({ pr: 7, head: HEAD }));
  });
  it('a refused writer consumes the one-clear attempt budget', async () => {
    const clearHuman = vi.fn(() => { throw Error('posting identity refused'); });
    await sweep({ mode: 'on', prs: [pr(), pr({ number: 8 })], clearHuman });
    expect(clearHuman).toHaveBeenCalledOnce();
  });
  it('a push during event IO refuses at the write boundary', async () => {
    const clearHuman = vi.fn(); let moved = false;
    const out = await sweep({ mode: 'on', clearHuman, emit: () => { moved = true; }, readLiveHead: () => moved ? OTHER : HEAD });
    expect(out.refused[0].failed).toContain('head-moved'); expect(clearHuman).not.toHaveBeenCalled();
  });
  it('CLI uses sanctioned argv with expect-head, orchestrator and daemon', async () => {
    const exec = vi.fn(); await clearHumanViaCli({ pr: 7, head: HEAD, reason: 'facts $(inert)', repo: 'o/r', exec });
    expect(exec.mock.calls[0][1]).toEqual(['scripts/review-set-label.mjs', '7', '--to=clear-human', '--actor=orchestrator',
      '--channel=daemon', `--expect-head=${HEAD}`, '--reason=facts $(inert)', '--repo=o/r']);
  });
  it.each(['off', 'shadow', 'on'])('replay in %s never writes; substitutes human label and exposes every fact', async mode => {
    const clearHuman = vi.fn(), emit = vi.fn();
    const out = await sweep({ mode, replay: true, prs: [pr({ labels: ['review:accepted', ...labels.slice(1)] })],
      readPr: p => ({ ...p, headRefOid: OTHER }), readLiveHead: () => OTHER, emit, clearHuman });
    expect(out.wouldApprove).toEqual([7]); expect(clearHuman).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    expect(out.results[0].evidence).toMatchObject({ replay: true, head: HEAD, labels, originalLabels: ['review:accepted', ...labels.slice(1)] });
  });
  it('replay emits only with explicit emitReplay', async () => {
    const emit = vi.fn(); await sweep({ replay: true, emitReplay: true, emit });
    expect(emit).toHaveBeenCalledOnce(); expect(emit.mock.calls[0][0].detail.replay).toBe(true);
  });
  it('dedupes per PR, head, verdict while retaining every tick', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clear-human-events-'));
    try {
      const append = vi.fn(); const emit = createEventEmitter({ repo: 'o/r', home, append });
      const event = { kind: 'excluded:workflow-edit', pr: 7, detail: { head: HEAD } };
      await emit(event); await emit(event);
      await emit({ ...event, detail: { head: OTHER } });
      await emit({ kind: 'delegated-clear-human-tick', detail: {} });
      await emit({ kind: 'delegated-clear-human-tick', detail: {} });
      expect(append).toHaveBeenCalledTimes(4);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('live reader budget exhaustion fails closed', () => {
    const exec = vi.fn(() => JSON.stringify({ headRefOid: HEAD }));
    const readers = liveReaders({ repo: 'o/r', maxCalls: 1, exec });
    expect(readers.readLiveHead(pr())).toBe(HEAD);
    expect(() => readers.readLiveHead(pr())).toThrow(/budget exhausted/); expect(exec).toHaveBeenCalledOnce();
  });
  it('live check reader exhausts pages and refuses oversized inputs with an operator fallback', () => {
    const readers = liveReaders({ repo: 'o/r', exec: () => JSON.stringify({ check_runs: Array.from({ length: 100 }, () => row()), total_count: 1001 }) });
    expect(() => readers.readChecks(pr(), HEAD)).toThrow(/page cap exceeded; operator/);
  });
  it('live check reader pins the API to H and refuses an incomplete count', () => {
    const exec = vi.fn(() => JSON.stringify({ check_runs: [row()], total_count: 2 }));
    expect(() => liveReaders({ repo: 'o/r', exec }).readChecks(pr(), HEAD)).toThrow(/incomplete/);
    expect(exec.mock.calls[0][1][1]).toContain(`/commits/${HEAD}/check-runs`);
  });
  it('live diff reads H and base objects without substituting a branch or fetching', () => {
    const exec = vi.fn((_cmd, args) => {
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: HEAD, baseRefOid: OTHER });
      if (args[0] === 'merge-base') return OTHER;
      if (args.includes('--name-only')) return 'src/a.mjs\0';
      if (args.includes('--numstat')) return '1\t0\tsrc/a.mjs\0';
      return 'diff --git a/src/a.mjs b/src/a.mjs\n';
    });
    const readers = liveReaders({ repo: 'o/r', exec }); readers.readPr(pr());
    expect(readers.readFiles(pr(), HEAD)).toEqual(['src/a.mjs']);
    expect(readers.scoreNet(pr(), HEAD)).toMatchObject({ scored: true, head: HEAD, files: 1, diffLines: 1 });
    for (const [, args] of exec.mock.calls.filter(([cmd]) => cmd === 'git')) {
      expect(args).toContain(HEAD); expect(args).not.toContain('fetch');
    }
  });
  it('malformed replay argument refuses before reading live inputs', async () => {
    await expect(main(['--repo=o/r', '--replay=7@abc'])).rejects.toThrow(/40-hex/);
  });
});
