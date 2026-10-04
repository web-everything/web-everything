import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLandAdvanceReader, createLandAdvanceApplier, readLiveSessions, readJsonlTail, readFollowUps, writeFollowUp, resultProvider } from '../land-advance-io.mjs';
import { planLandAdvance } from '../land-advance.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { buildEscalationPacket, writeEscalationPacket, listUnresolvedEscalations, renderEscalationsSection } from '../land-advance-escalations.mjs';
import { allowedToolsArg, ALLOWED_TOOLS_BY_KIND } from '../land-advance-tools.mjs';
const now = Date.parse('2026-09-20T00:00:00Z');
const dirs = [];
const temp = () => { const p = fs.mkdtempSync(join(tmpdir(), 'land-advance-')); dirs.push(p); return p; };
afterEach(() => { dirs.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
const prs = [1,2,3].map((number) => ({ number, repo: 'we', slug: 'web-everything/web-everything', labels: ['review:pending'], createdAt: '2026-09-08' }));
const emptyFs = { ...fs, readdirSync: () => [], readFileSync: (p) => { if (String(p).endsWith('swept-repos.json')) return '["web-everything/web-everything","frontier-ui/frontierui","plateauapp/plateau-app"]'; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
const readerPorts = (overrides = {}) => ({ fs: emptyFs, now: () => now, readSessions: () => [], store: createMemoryRunStore(), machineLoad: () => 0,
  run: (cmd, args) => cmd === 'gh' ? '[]' : cmd === 'git' ? '321 180' : '/lanes/lane-1\n/lanes/lane-2', ...overrides });
describe('evidence IO', () => {
  it('records a failed repo without hiding other repos; uses full slugs', () => {
    const run = vi.fn((cmd, args) => {
      if (cmd !== 'gh') return cmd === 'git' ? '321 180' : '/lane-1';
      const slug = args[args.indexOf('--repo') + 1]; expect(slug).toMatch(/^(web-everything|frontier-ui|plateauapp)\//);
      if (slug === 'frontier-ui/frontierui') throw new Error('network unavailable');
      return JSON.stringify([prs[0]]);
    });
    const inputs = createLandAdvanceReader(readerPorts({ run }))();
    expect(inputs.prs.map((p) => p.repo)).toEqual(['we', 'plateau-app']); expect(inputs.errors[0].source).toBe('prs:frontierui');
    expect(run.mock.calls.some(([cmd, args]) => cmd === 'git' && args[0] === 'fetch')).toBe(false);
    expect(inputs.prototype).toMatchObject({ ahead: 180, behind: 321, refreshed: false });
  });
  it('refresh failure is unknown, lane failure closes capacity', () => {
    const inputs = createLandAdvanceReader(readerPorts({ refreshPrototype: true, run: (cmd) => { if (cmd === 'gh') return '[]'; throw new Error('failed'); } }))();
    expect(inputs.prototype.status).toBe('unknown'); expect(inputs.freeLanes).toBe('unknown'); expect(inputs.errors).toHaveLength(2);
  });
  it('probes pid or full sessionId, never trusts working labels', () => {
    const agents = Array.from({ length: 44 }, (_, i) => ({ name: `review-${i}`, sessionId: `full-session-${i}`, state: i < 31 ? 'working' : 'blocked', kind: 'background' }));
    const sessions = readLiveSessions({ listAgents: () => agents, ps: () => '' });
    expect(sessions.every((s) => s.liveness === 'dead-record')).toBe(true);
    expect(readLiveSessions({ listAgents: () => [{ pid: 1, state: 'done' }, { sessionId: 'abc', waitingFor: 'permission' }], ps: () => 'claude abc', isPidAlive: () => true }).map((s) => s.liveness)).toEqual(['done','waiting']);
    expect(() => readLiveSessions({ listAgents: () => [{ sessionId: 'abc' }], ps: () => null })).toThrow('Unknown liveness');
  });
  it('bounds history by bytes and lines', () => {
    const file = join(temp(), 'history.jsonl'); fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    const tail = readJsonlTail(file, { maxBytes: 200, maxLines: 3 }); expect(tail.capped).toBe(true); expect(tail.entries).toEqual([{ i: 97 }, { i: 98 }, { i: 99 }]);
  });
  it.each(['Provider used: CODEX-direct-task', '## Authorship\nGemini wrote it', '**Provider used:** Codex'])('parses section %s', (text) => expect(resultProvider(text)).toMatch(/Codex|Gemini/));
  it('does not treat an incidental mention as authorship', () => expect(resultProvider('Maybe use codex tomorrow')).toBeNull());
  it('calls the existing fix planner and retains no-scope refusals', () => {
    const run = (cmd, args) => cmd === 'gh' ? (args.includes('web-everything/web-everything') ? JSON.stringify([
      { number: 2170, labels: ['review:changes'], headRefName: 'lane/stuck-session-op-docs' },
      { number: 2108, labels: ['review:changes'], headRefName: 'lane/3140-fix' },
    ]) : '[]') : cmd === 'git' ? '0 1' : '/lane-1';
    const inputs = createLandAdvanceReader(readerPorts({ run, findItemFn: () => null, loadItems: () => [], resolveFallbackScope: () => [] }))();
    expect(inputs.fixPlans['we#2170'].refusal.kind).toBe('no-scope'); expect(inputs.fixPlans['we#2108'].refusal.kind).toBe('no-scope');
    const yes = createLandAdvanceReader(readerPorts({ run, findItemFn: () => ({ scope: ['we:scripts/'] }), loadItems: () => [] }))();
    expect(yes.fixPlans['we#2108'].planned.scope).toEqual(['we:scripts/']);
  });
  // #3856 graduation note: `planFixesFromReconcile`'s itemless-PR branch moved to the shared
  // `resolvePrWorkUnit` (`we:scripts/conveyor/pr-work-unit.mjs`) after this module's own branch snapshot,
  // via the injected `fetchItemlessDiffPaths` (UN-prefixed — the resolver adds the repo prefix itself),
  // not `resolveFallbackScope` (still item-carrying-only, and still pre-prefixed). `dispatchFix` itself
  // derives `ATTRIBUTION_KIND`/`ATTRIBUTION_NUM` from `itemNum`/`pr` when a planned entry carries neither
  // field (`reconcile-fix-dispatch.mjs`'s own fallback), so this is a wiring change, not a capability loss.
  it('carries a null-item fix plan through the reader and dispatch-fix row', async () => {
    const findItemFn = vi.fn(() => { throw new Error('must not look up an item'); });
    const run = (cmd, args) => cmd === 'gh'
      ? (args[0] === 'pr' && args[1] === 'diff' ? 'docs/agent/testing.md\n'
        : args.includes('web-everything/web-everything') ? JSON.stringify([
          { number: 2170, labels: ['review:changes'], headRefName: 'lane/stuck-session-op-docs' },
        ]) : '[]')
      : cmd === 'git' ? '0 0' : '/lane-1';
    const inputs = createLandAdvanceReader(readerPorts({ run, findItemFn, loadItems: () => [] }))();
    const plan = planLandAdvance(inputs);
    const row = plan.rows.find((r) => r.pr === 2170);
    expect(row).toMatchObject({ owedAction: 'dispatch-fix', dispatchable: true, fixPlan: { itemNum: null, scope: ['we:docs/agent/testing.md'] } });
    expect(row.refusal).toBeFalsy();
    expect(findItemFn).not.toHaveBeenCalled();
    const dispatchFix = vi.fn(() => ({ agentId: 'f', sessionSlug: 'fix-2170' }));
    await createLandAdvanceApplier({ dispatchFix, pickFixLane: () => 7, readCapacity: () => ({ freeLanes: 1 }), writeLedger: () => {}, now: () => now })(plan);
    expect(dispatchFix).toHaveBeenCalledWith(expect.objectContaining({ itemNum: null, pr: 2170, lane: 7 }), expect.any(Object));
  });
  it('round-trips follow-ups through the real run schema', () => {
    const store = createMemoryRunStore(), entry = { session: 'session-123', kind: 'review', target: 'frontierui#49', launchedAt: new Date(now).toISOString(), deadline: new Date(now + 1000).toISOString(), expectedResultPath: '/jobs/review-49.result.md', permissionsGranted: ['Read'] };
    writeFollowUp(entry, { store }); expect(readFollowUps({ store })).toEqual([entry]);
    writeFollowUp({ ...entry, session: null }, { store }); expect(readFollowUps({ store })).toHaveLength(2);
  });
});
describe('apply uses injected effects only', () => {
  const plan = () => planLandAdvance({ now, prs, freeLanes: 3, escalations: [] });
  const ports = () => ({ now: () => now, readCapacity: vi.fn(() => ({ freeLanes: 3, sessions: [], load: 0 })), writeLedger: vi.fn(), writePacket: vi.fn(), reap: vi.fn(), dispatchReview: vi.fn(async ({ pr }) => ({ agentId: `s-${pr}`, sessionSlug: `review-${pr}` })) });
  it('awaits each dispatch, grants one argv atom, logs each launch, and stops on failure', async () => {
    const p = ports(); let active = 0;
    // #3856 graduation — `repo` is the internal key (`row.repo`), not the gh slug (`row.slug`): `dispatchFix`/
    // `dispatchCiHeal` thread it into `sessionSlugFor` → `repoSlugTag`, which accepts only a known key (see the
    // applier's own comment at its dispatch call site).
    p.dispatchReview = vi.fn(async (args) => { expect(active++).toBe(0); expect(args.repo).toBe('we'); expect(args.extraArgs).toEqual([allowedToolsArg('review')]); await Promise.resolve(); active--; if (args.pr === 2) throw new Error('spawn failed'); return { agentId: 'a', sessionSlug: 'review-1' }; });
    const result = await createLandAdvanceApplier(p)(plan());
    expect(p.dispatchReview).toHaveBeenCalledTimes(2); expect(p.writeLedger).toHaveBeenCalledTimes(1); expect(result.errors[0].message).toBe('spawn failed');
    expect(p.writeLedger.mock.calls[0][0]).toMatchObject({ target: 'we#1', permissionsGranted: ALLOWED_TOOLS_BY_KIND.review });
  });
  it('a review refused by the fresh CI gate is deferred: no ledger entry, no capacity spent, no error', async () => {
    const p = ports(); p.dispatchReview = vi.fn(async ({ pr }) => (pr === 1
      ? { pr, repo: 'we', headSha: 'a'.repeat(40), skipped: 'review-ci: required-checks-not-successful', ci: { allowed: false } }
      : { agentId: `s-${pr}`, sessionSlug: `review-${pr}` }));
    const result = await createLandAdvanceApplier(p)(plan());
    expect(p.dispatchReview).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual([]);
    expect(result.deferred).toContainEqual({ target: 'we#1', reason: 'review-ci: required-checks-not-successful' });
    expect(p.writeLedger.mock.calls.map(([e]) => e.target)).toEqual(['we#2', 'we#3']);
    expect(result.dispatched).toHaveLength(2);
  });
  it('rechecks capacity at each step', async () => {
    const p = ports(); p.readCapacity.mockReturnValueOnce({ freeLanes: 1 }).mockReturnValue({ freeLanes: 0 });
    const result = await createLandAdvanceApplier(p)(plan()); expect(result.dispatched).toHaveLength(1); expect(p.dispatchReview).toHaveBeenCalledTimes(1);
  });
  it('routes fix arguments and invokes reaper once for summary rows', async () => {
    const p = ports(); p.dispatchFix = vi.fn(() => ({ agentId: 'f', sessionSlug: 'fix-1' })); p.pickFixLane = () => 7;
    const data = planLandAdvance({ now, freeLanes: 1, prs: [{ ...prs[0], labels: ['review:changes'] }], fixPlans: { 'we#1': { planned: { pr: 1, itemNum: '3140', scope: ['we:scripts/'] } } }, sessions: [{ liveness: 'dead-record' }] });
    await createLandAdvanceApplier(p)(data); expect(p.reap).toHaveBeenCalledOnce(); expect(p.dispatchFix).toHaveBeenCalledWith(expect.objectContaining({ lane: 7 }), expect.objectContaining({ extraArgs: [allowedToolsArg('fix')], repo: 'we' }));
  });
});
describe('tools and escalation packets', () => {
  it('closes tool kinds and disallows unbounded shell grants', () => {
    expect(Object.keys(ALLOWED_TOOLS_BY_KIND)).toEqual(['review','fix','build','ci-heal','conflict-fix']);
    for (const [kind, tools] of Object.entries(ALLOWED_TOOLS_BY_KIND)) {
      expect(Object.isFrozen(tools)).toBe(true); expect(allowedToolsArg(kind)).toBe(`--allowedTools=${tools.join(',')}`);
      for (const tool of tools) { expect(tool).not.toMatch(/dangerously|git push --force/); expect(['Bash','Bash(*)']).not.toContain(tool); }
    }
    expect(() => allowedToolsArg('other')).toThrow();
  });
  it('updates deterministic packets and excludes resolved packets', () => {
    const dir = temp(), row = { packetId: 'stuck-in-drain-we-2072', kind: 'stuck-in-drain', subject: 'we#2072', evidence: ['waiting'], blockedBy: 'plateau-app#153' };
    const packet = buildEscalationPacket(row, now); writeEscalationPacket(packet, { dir }); writeEscalationPacket(packet, { dir });
    expect(fs.readdirSync(dir)).toHaveLength(1); expect(listUnresolvedEscalations({ dir })).toHaveLength(1); expect(renderEscalationsSection([packet])).toContain('plateau-app#153');
    const resolved = buildEscalationPacket(row, now + 1, { ...packet, status: 'resolved', resolvedAt: new Date(now).toISOString(), resolution: 'fixed' });
    writeEscalationPacket(resolved, { dir }); expect(listUnresolvedEscalations({ dir })).toEqual([]);
  });
});
it('reads follow-up identity and target progress without inventing closed PRs from absence', () => {
  const store = createMemoryRunStore();
  const entry = { session: 'live-id', kind: 'review', target: 'we#1', launchedAt: '2026-09-18T00:00:00Z', deadline: '2026-09-19T00:00:00Z', expectedResultPath: '/jobs/r.result.md', permissionsGranted: ['Read'] };
  writeFollowUp(entry, { store });
  const inputs = createLandAdvanceReader(readerPorts({ store, readSessions: () => [{ id: 'live-id', liveness: 'live-idle' }],
    run: (cmd, args) => cmd === 'gh' ? (args[1] === 'view' ? '{"state":"MERGED"}' : '[]') : cmd === 'git' ? '0 0' : '' }))();
  expect(inputs.followUps[0].evidence).toMatchObject({ liveness: 'live-idle', targetState: 'MERGED' });
});
it('writes escalation packets only through apply and never folds a PR', async () => {
  const writePacket = vi.fn(), dispatchReview = vi.fn(), dispatchFix = vi.fn();
  const plan = planLandAdvance({ now, freeLanes: 0, prs: [{ ...prs[0], labels: ['review:accepted'], baseRefName: 'lane/mechanical-dispatcher' }], followUps: [{ target: 'we#2', session: 's', evidence: {}, launchedAt: '2026-09-01' }] });
  await createLandAdvanceApplier({ writePacket, dispatchReview, dispatchFix, now: () => now })(plan);
  expect(writePacket).toHaveBeenCalledOnce(); expect(writePacket.mock.calls[0][0].kind).toBe('follow-up-ambiguous');
  expect(dispatchReview).not.toHaveBeenCalled(); expect(dispatchFix).not.toHaveBeenCalled();
});
it('completion evidence must belong to this launch, not an old same-name session', () => {
  const store = createMemoryRunStore(), path = '/completion/review-49.json';
  const entry = { session: 's', kind: 'review', target: 'we#49', launchedAt: '2026-09-18T00:00:00Z', deadline: '2026-09-21T00:00:00Z', expectedResultPath: path, permissionsGranted: ['Read'] };
  writeFollowUp(entry, { store });
  for (const [startedAt, expected] of [['2026-09-17', false], ['2026-09-19', true]]) {
    const io = { ...emptyFs, readFileSync: (p, ...args) => p === path ? JSON.stringify({ status: 'done', startedAt }) : emptyFs.readFileSync(p, ...args) };
    const data = createLandAdvanceReader(readerPorts({ fs: io, store, followUpEvidence: () => ({}) }))();
    expect(data.followUps[0].evidence.resultPresent).toBe(expected);
  }
});
describe('mechanical session verdicts (#3383 item 11)', () => {
  const started = now - 3 * 3600000;
  const idle = (name, id) => ({ pid: 9, id, sessionId: `${id}-uuid`, kind: 'background', name, startedAt: started, status: 'idle', state: 'blocked', waitingFor: null, liveness: 'live-idle' });
  const evidenceBy = { fin: { resultFiles: [{ path: '/jobs/unstick-2072.result.md', mtimeMs: started + 1000 }], transcriptMtimeMs: now - 7200000 }, stuck: { resultFiles: [], transcriptMtimeMs: now - 6420000, redispatchAttempts: 1 }, once: { resultFiles: [], transcriptMtimeMs: now - 6420000 } };
  const sessions = [idle('unstick-2072', 'fin'), idle('review-148', 'stuck'), idle('review-149', 'once')];
  const sessionEvidence = () => (s) => evidenceBy[s.id];
  const readSessions = () => sessions;
  it('attaches the verdict to each session, and the plan owes a reap for the finished one and an escalation for the exhausted one', () => {
    const inputs = createLandAdvanceReader(readerPorts({ readSessions, sessionEvidence }))();
    expect(inputs.sessions.map((s) => [s.name, s.verdict, s.action])).toEqual([['unstick-2072', 'finished-unreaped', 'reap'], ['review-148', 'stalled', 'escalate'], ['review-149', 'stalled', 'redispatch-once']]);
    const p = planLandAdvance(inputs);
    expect(p.rows.filter((r) => r.owedAction === 'reap-owed').map((r) => r.subject)).toEqual(['session:fin']);
    const esc = p.rows.find((r) => r.owedAction === 'escalate');
    expect(esc).toMatchObject({ subject: 'session:review-148', kind: 'session-stalled', verdict: 'stalled' });
    expect(esc.packetId).toBe('session-stalled-session-review-148');
    // the first rung (redispatch-once) is not a row yet, and nothing here is an operator row
    expect(p.rows.some((r) => r.subject === 'session:review-149')).toBe(false);
    expect(p.rows.some((r) => r.owedAction === 'needs-operator')).toBe(false);
  });
  it('an unreadable evidence source degrades to no verdict, recorded as a source error', () => {
    const inputs = createLandAdvanceReader(readerPorts({ readSessions, sessionEvidence: () => { throw new Error('jobs dir gone'); } }))();
    expect(inputs.errors.some((e) => e.source === 'session-verdicts')).toBe(true);
    expect(inputs.sessions.every((s) => s.verdict === undefined)).toBe(true);
  });
});
