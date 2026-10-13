import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMirror, renderPlan, runMirrorReport, runMirrorApply, planLabelInputRows, readLabelTimeline, addApplyLabel, main, readSelfLogin } from '../pr-label-mirror.mjs';
import { buildDerivedRows } from '../../review-ledger-check.mjs';
import { buildVerdictRecord } from '../../lib/verdict-ledger.mjs';
import { derivePrState } from '../../lib/pr-state.mjs';

const fam = (family, missing = [], extra = []) => ({ family, missing, extra, agree: !missing.length && !extra.length });
const row = (pr, families, status = 'mismatch', lifecycleState = 'X') => ({ pr, status, lifecycleState, families });

describe('planMirror', () => {
  it('lists the exact add and remove set, sorted, and skips in-sync and unreadable PRs', () => {
    const plan = planMirror([
      row(1, [fam('review', ['review:accepted'], ['review:pending']), fam('ruling-needed', [], ['advisory:ruling-needed'])]),
      row(2, [fam('review')], 'agree'),
      row(3, [], 'unreadable', null),
      row(4, [fam('ready-to-merge', ['ready-to-merge'])]),
    ]);
    expect(plan.changes).toEqual([
      { pr: 1, lifecycleState: 'X', add: ['review:accepted'], remove: ['advisory:ruling-needed', 'review:pending'] },
      { pr: 4, lifecycleState: 'X', add: ['ready-to-merge'], remove: [] },
    ]);
    expect(plan).toMatchObject({ mode: 'report', writes: 0, total: 4, inSync: 1, unreadable: 1, counts: { add: 2, remove: 2 } });
    expect(renderPlan(plan)).toContain('#1 (X): add [review:accepted] remove [advisory:ruling-needed, review:pending]');
  });
});

describe('runMirrorReport (fixture dry run)', () => {
  it('derives from fixtures through slice F and plans only a diff', async () => {
    const prs = [{ number: 7, labels: [{ name: 'review:pending' }, { name: 'bug' }] }, { number: 8, labels: [] }];
    const facts = { headSha: 'a'.repeat(40), labels: [], checks: [], requiredChecks: [], probeErrors: [] };
    const plan = await runMirrorReport({
      repo: 'web-everything/web-everything',
      listPrs: () => prs,
      readEvents: async () => ({ status: 'ok', rows: [], store: { name: 'home', shared: false } }),
      buildRows: (o) => buildDerivedRows({ ...o, readFacts: (n) => (n === 8 ? null : facts) }),
    });
    expect(plan.writes).toBe(0);
    expect(plan.unreadable).toBe(1);
    expect(plan.changes.find((c) => c.pr === 7)?.remove).toContain('review:pending');
    expect(JSON.stringify(plan)).not.toContain('bug');
  });
});

describe('report only', () => {
  it('no write call outside the --apply branch: the report entry point and its helpers hold no label write', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-label-mirror.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const cut = src.indexOf('// ---- APPLY MODE');
    expect(cut).toBeGreaterThan(0); // the marker this guard slices on must exist
    const reportPart = src.slice(0, cut);
    for (const bad of ['setLabels', 'ensureLabel', 'createGhProvider', '--add-label', '--remove-label', 'pr edit', 'pr comment', 'writeRun', 'execFileSync', 'addLabel']) {
      expect(reportPart).not.toContain(bad);
    }
    for (const bad of ['--remove-label', 'pr comment', 'ensureLabel', 'writeRun', 'execFileSync']) expect(src).not.toContain(bad);
    expect(src).not.toMatch(/remove:\s*\[[^\]]/); // no label removal is ever requested
  });
});


describe('shared-store mirror reporting', () => {
  it('unreadable ledger plans nothing and retains the store failure', async () => {
    const store = { name: 'git', shared: true };
    const plan = await runMirrorReport({ store: 'git',
      listPrs: async () => [{ number: 7, labels: [{ name: 'review:pending' }] }],
      readEvents: async (_repo, opts) => { expect(opts.store).toBe('git'); return { status: 'unreadable', store, reason: 'no-board', error: 'missing board' }; },
      buildRows: (opts) => buildDerivedRows({ ...opts, readFacts: () => ({}) }) });
    expect(plan).toMatchObject({ store, ledgerUnreadable: { reason: 'no-board', error: 'missing board' }, unreadable: 1, inSync: 0, changes: [], counts: { add: 0, remove: 0 } });
    expect(renderPlan(plan)).toContain('ledger store: git (shared)');
    expect(renderPlan(plan)).toContain('no-board');
  });
  it('home report explicitly declares that other machines are invisible', async () => {
    const plan = await runMirrorReport({ listPrs: () => [], readEvents: async () => ({ status: 'ok', rows: [], store: { name: 'home', shared: false } }) });
    expect(renderPlan(plan)).toContain('ledger store: home (NOT shared - rows written on other machines are invisible here)');
  });
});


// ---- #5649 slice K: apply mode ----------------------------------------------------------------------------------
const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const FACTS = { headSha: HEAD, head: { sha: HEAD }, labels: [], checks: [], requiredChecks: [{ name: 'test', state: 'green' }], probeErrors: [] };
const humanVerdict = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'human', at: '2026-10-12T10:00:00.000Z', reason: 'needs a person', headSha: HEAD, declaredActor: 'op', session: 's', channel: 'chat', source: 'review-set-label' });
const tl = (label, change, actor, createdAt = '2026-10-12T11:00:00Z', actorType = 'User') => ({ label, change, actor, actorType, createdAt });

/** A fake world: ledger rows, live labels, a call log whose ORDER the tests assert. */
function world({ labels = [], verdict = 'human', timeline = { status: 'ok', items: [] }, appendOk = true } = {}) {
  const w = { log: [], rows: verdict ? [{ type: 'verdict', ...humanVerdict(7), verdict }] : [], labels };
  w.opts = {
    repo: REPO,
    listPrs: () => [{ number: 7, labels: w.labels.map((name) => ({ name })) }],
    readEvents: async () => ({ status: 'ok', rows: [...w.rows], store: { name: 'home', shared: false } }),
    buildRows: (o) => buildDerivedRows({ ...o, readFacts: () => FACTS }),
    readTimeline: async () => timeline,
    selfLogin: 'mirror-bot-login',
    appendRow: async (row) => { w.log.push(`append:${row.label}:${row.change}`); if (!appendOk) return { ok: false, errors: ['refused'] }; w.rows.push(row); return { ok: true, errors: [] }; },
    addLabel: async (_repo, pr, label) => { w.log.push(`add:${pr}:${label}`); },
  };
  return w;
}

describe('#5649 runMirrorApply', () => {
  it('a hand-removed review:human becomes a removed label-input row and is restored (--apply)', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'added', 'mirror-bot-login', '2026-10-12T10:30:00Z'), tl('review:human', 'removed', 'operator')] } });
    const report = await runMirrorReport(w.opts); // RED reason today: the report plans the add but has no way to write it
    expect(report.changes[0].add).toContain('review:human');
    expect(report.writes).toBe(0);
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual(['append:review:human:removed', 'add:7:review:human']);
    expect(out.rowsAppended).toEqual([expect.objectContaining({ pr: 7, label: 'review:human', change: 'removed', sender: 'operator' })]);
    expect(out.labelsAdded).toEqual([{ pr: 7, label: 'review:human' }]);
    expect(out.failures).toEqual([]);
  });

  it('a hand-added review:human becomes an added label-input row, and derivePrState then holds label-input:review:human', async () => {
    const w = world({ verdict: null, labels: ['review:human'], timeline: { status: 'ok', items: [tl('review:human', 'added', 'operator')] } });
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual(['append:review:human:added']);
    expect(out.labelsAdded).toEqual([]);
    const state = derivePrState(w.rows, { ...FACTS, repo: REPO, pr: 7, now: Date.parse('2026-10-12T12:00:00Z') }, {});
    expect(JSON.stringify(state)).toContain('label-input:review:human');
  });

  it("the mirror's own label write is never re-ledgered", async () => {
    const w = world({ labels: ['review:human'], timeline: { status: 'ok', items: [tl('review:human', 'added', 'Mirror-Bot-Login')] } });
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual([]);
    expect(out.rowsAppended).toEqual([]);
  });

  it('idempotent: the same timeline event on a second pass appends nothing', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    await runMirrorApply(w.opts);
    w.labels = ['review:human']; // the restore landed
    const second = await runMirrorApply(w.opts);
    expect(w.log.filter((l) => l.startsWith('append'))).toEqual(['append:review:human:removed']);
    expect(second.rowsAppended).toEqual([]);
  });

  it('report mode (no --apply) makes zero gh writes and appends zero rows (guard: passes today)', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    const plan = await runMirrorReport(w.opts);
    expect(plan.writes).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.rows).toHaveLength(1);
  });

  it('--apply never removes a label: the production add is one review:human with an empty remove list', async () => {
    const calls = [];
    const w = world({ labels: ['bug', 'review:pending'], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    w.opts.addLabel = (repo, pr, label) => addApplyLabel(repo, pr, label, { provider: { setLabels: (...a) => calls.push(a) } });
    const out = await runMirrorApply(w.opts);
    expect(out.labelsAdded).toEqual([{ pr: 7, label: 'review:human' }]);
    expect(calls).toEqual([[REPO, 7, { add: 'review:human', remove: [] }]]);
  });

  it('--apply adds only review:human: any other label is refused by the production add', async () => {
    const calls = [];
    for (const label of ['advisory:ruling-needed', 'review:accepted', 'ready-to-merge', '--remove-label']) {
      await expect(addApplyLabel(REPO, 7, label, { provider: { setLabels: (...a) => calls.push(a) } })).rejects.toThrow(/may add only/);
    }
    expect(calls).toEqual([]);
  });

  it('a clear-human that lands between the plan and the add wins: the add is re-derived and skipped', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    const append = w.opts.appendRow;
    w.opts.appendRow = async (row) => { const r = await append(row); w.rows.push({ type: 'verdict', ...buildVerdictRecord({ repo: REPO, pr: 7, verdict: 'accepted', at: '2026-10-12T12:00:00.000Z', reason: 'cleared', headSha: HEAD, declaredActor: 'op', session: 's', channel: 'chat', source: 'review-set-label' }) }); return r; };
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual(['append:review:human:removed']);
    expect(out.labelsAdded).toEqual([]);
    expect(out.failures).toEqual([]);
  });

  it('a truncated or unreadable timeline plans no write and no row', async () => {
    for (const reason of ['truncated-timeline', 'timeline-read-failed: boom']) {
      const w = world({ labels: [], timeline: { status: 'unreadable', reason } });
      const out = await runMirrorApply(w.opts);
      expect(w.log).toEqual([]);
      expect(out.failures).toEqual([{ pr: 7, reason: expect.stringContaining(reason) }]);
    }
  });

  it('readLabelTimeline: maps Labeled/Unlabeled to added/removed with actor and type, and pages back with before cursors', async () => {
    const node = (t, label, login, createdAt, type = 'User') => ({ __typename: t, createdAt, actor: login ? { __typename: type, login } : null, label: { name: label } });
    const pages = [
      { pageInfo: { hasPreviousPage: true, startCursor: 'CUR1' }, nodes: [node('UnlabeledEvent', 'review:human', 'operator', '2026-10-12T11:00:00Z')] },
      { pageInfo: { hasPreviousPage: false, startCursor: 'CUR0' }, nodes: [node('LabeledEvent', 'review:human', 'ci', '2026-10-12T09:00:00Z', 'Bot'), node('LabeledEvent', 'bug', null, '2026-10-12T09:30:00Z')] },
    ];
    const queries = [];
    const read = (args) => { queries.push(args.join(' ')); return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: pages[queries.length - 1] } } } }); };
    const r = await readLabelTimeline({ repo: REPO, pr: 7, read });
    expect(r.status).toBe('ok');
    expect(r.items).toEqual([
      { label: 'review:human', change: 'removed', actor: 'operator', actorType: 'User', createdAt: '2026-10-12T11:00:00Z' },
      { label: 'review:human', change: 'added', actor: 'ci', actorType: 'Bot', createdAt: '2026-10-12T09:00:00Z' },
      { label: 'bug', change: 'added', actor: null, actorType: null, createdAt: '2026-10-12T09:30:00Z' },
    ]);
    expect(queries[0]).not.toContain('before:');
    expect(queries[1]).toContain('before:"CUR1"');
  });

  it('readLabelTimeline: more pages than the cap, a missing cursor, or a bad payload is unreadable, never "no changes"', async () => {
    const more = () => JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasPreviousPage: true, startCursor: 'C' }, nodes: [] } } } } });
    expect(await readLabelTimeline({ repo: REPO, pr: 7, read: more, maxPages: 2 })).toEqual({ status: 'unreadable', reason: 'truncated-timeline' });
    const noCursor = () => JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasPreviousPage: true }, nodes: [] } } } } });
    expect(await readLabelTimeline({ repo: REPO, pr: 7, read: noCursor })).toMatchObject({ status: 'unreadable', reason: 'bad-page-info' });
    expect(await readLabelTimeline({ repo: REPO, pr: 7, read: () => '{"data":{"repository":{"pullRequest":null}}}' })).toMatchObject({ status: 'unreadable' });
    expect(await readLabelTimeline({ repo: REPO, pr: 7, read: () => { throw new Error('gh down'); } })).toMatchObject({ status: 'unreadable', reason: expect.stringContaining('gh down') });
    expect(await readLabelTimeline({ repo: 'bad repo', pr: 7, read: more })).toMatchObject({ status: 'unreadable', reason: 'bad-target' });
  });

  it('readSelfLogin reads the gh api user login and refuses an empty one', () => {
    expect(readSelfLogin({ read: (a) => { expect(a).toEqual(['api', 'user', '--jq', '.login']); return 'mirror-bot-login\n'; } })).toBe('mirror-bot-login');
    expect(() => readSelfLogin({ read: () => '\n' })).toThrow(/no login/);
  });

  it('a PR whose current verdict is not human gets no review:human add even after a hand removal', async () => {
    const w = world({ verdict: 'accepted', labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    const out = await runMirrorApply(w.opts);
    expect(w.log.filter((l) => l.startsWith('add'))).toEqual([]);
    expect(out.labelsAdded).toEqual([]);
  });

  it('a refused append fails closed: no label add, a failure entry', async () => {
    const w = world({ labels: [], appendOk: false, timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual(['append:review:human:removed']);
    expect(out.failures[0]).toMatchObject({ pr: 7, reason: expect.stringContaining('append-refused') });
  });

  it('an unreadable ledger writes nothing and reports the reason', async () => {
    const w = world({});
    w.opts.readEvents = async () => ({ status: 'unreadable', reason: 'no-board', error: 'x', store: { name: 'git', shared: true } });
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual([]);
    expect(out.failures[0].reason).toContain('ledger-unreadable');
  });

  it('a fresh ledger read that fails just before the append writes nothing for that PR and reports it', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    let reads = 0;
    const good = w.opts.readEvents;
    w.opts.readEvents = async (...a) => { reads += 1; return reads === 1 ? good(...a) : { status: 'unreadable', reason: 'store-read-failed', error: 'x', store: { name: 'home' } }; };
    const out = await runMirrorApply(w.opts);
    expect(w.log).toEqual([]);
    expect(out.failures).toEqual([{ pr: 7, reason: 'ledger-unreadable: store-read-failed' }]);
  });

  it('an unknown mirror login refuses to write at all, and a PR whose facts are unreadable is never a candidate', async () => {
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    await expect(runMirrorApply({ ...w.opts, selfLogin: '' })).rejects.toThrow(/own login is unknown/);
    await expect(runMirrorApply({ ...w.opts, selfLogin: async () => '' })).rejects.toThrow(/own login is unknown/);
    const timelines = [];
    const out = await runMirrorApply({ ...w.opts, buildRows: (o) => buildDerivedRows({ ...o, readFacts: () => null }), readTimeline: async (a) => { timelines.push(a); return { status: 'ok', items: [] }; } });
    expect(timelines).toEqual([]);
    expect(out.unreadable).toBe(1);
    expect(w.log).toEqual([]);
  });

  it('--store reaches the append: the default append passes the named store through', async () => {
    const seen = [];
    const w = world({ labels: [], timeline: { status: 'ok', items: [tl('review:human', 'removed', 'operator')] } });
    delete w.opts.appendRow;
    const mod = await import('../../lib/verdict-ledger.mjs');
    const spy = vi.spyOn(mod, 'appendVerdictAsync').mockImplementation(async (row, opts) => { seen.push([row.type, opts]); w.rows.push(row); return { ok: true, errors: [] }; });
    try { await runMirrorApply({ ...w.opts, store: 'dual' }); } finally { spy.mockRestore(); }
    expect(seen).toEqual([['label-input', { store: 'dual' }]]);
  });

  it('a PR list that hit --limit is an error, never a partial apply', async () => {
    const w = world({});
    await expect(runMirrorApply({ ...w.opts, limit: 1 })).rejects.toThrow(/--limit/);
    expect(w.log).toEqual([]);
  });
});

describe('#5649 planLabelInputRows', () => {
  const base = { repo: REPO, pr: 7, selfLogin: 'me' };
  it('only the latest change per label counts, and only while it matches the live labels', () => {
    const items = [tl('review:human', 'added', 'op', '2026-10-12T09:00:00Z'), tl('review:human', 'removed', 'op', '2026-10-12T09:30:00Z')];
    expect(planLabelInputRows({ ...base, items, liveLabels: ['review:human'] })).toEqual([]); // stale: label is back, last change was a removal
    expect(planLabelInputRows({ ...base, items, liveLabels: [] })).toHaveLength(1);
  });
  it('a row already in the ledger (same repo, pr, label, change, time) is dropped even while the label is still absent', () => {
    const items = [tl('review:human', 'removed', 'operator', '2026-10-12T11:00:00Z')];
    const [row] = planLabelInputRows({ ...base, liveLabels: [], items });
    expect(row).toMatchObject({ type: 'label-input', label: 'review:human', change: 'removed', sender: 'operator', at: '2026-10-12T11:00:00Z' });
    expect(planLabelInputRows({ ...base, liveLabels: [], items, events: [row] })).toEqual([]);
    expect(planLabelInputRows({ ...base, liveLabels: [], items, events: [{ ...row, pr: 8 }] })).toHaveLength(1); // another PR's row never suppresses it
  });
  it('a bot or missing actor is hand-made for added, not for removed', () => {
    expect(planLabelInputRows({ ...base, liveLabels: ['review:human'], items: [tl('review:human', 'added', 'ci[bot]', undefined, 'Bot')] })).toHaveLength(1);
    expect(planLabelInputRows({ ...base, liveLabels: ['review:human'], items: [tl('review:human', 'added', null, undefined, null)] })[0].sender).toBe('unknown');
    expect(planLabelInputRows({ ...base, liveLabels: [], items: [tl('review:human', 'removed', 'ci[bot]', undefined, 'Bot')] })).toEqual([]);
    expect(planLabelInputRows({ ...base, liveLabels: [], items: [tl('review:human', 'removed', null, undefined, null)] })).toEqual([]);
  });
  it('labels outside the closed hold set are ignored, and a hostile login is stored folded', () => {
    expect(planLabelInputRows({ ...base, liveLabels: ['bug'], items: [tl('bug', 'added', 'op')] })).toEqual([]);
    const [r] = planLabelInputRows({ ...base, liveLabels: ['review:human'], items: [tl('review:human', 'added', 'x\ny`rm -rf`')] });
    expect(r.sender).not.toMatch(/[\n`]/);
  });
});

describe('#5649 CLI exit code', () => {
  it('a failure in an apply pass is a non-zero exit; a clean pass is zero; report mode never applies', async () => {
    const out = [];
    const write = (t) => out.push(t);
    expect(await main(['--apply', '--json'], { apply: async () => ({ mode: 'apply', writes: 0, failures: [{ pr: 7, reason: 'append-refused: x' }] }), write })).toBe(1);
    expect(await main(['--apply'], { apply: async () => ({ mode: 'apply', writes: 1, failures: [], counts: { add: 0, remove: 0 }, changes: [], total: 0, inSync: 0, unreadable: 0 }), write })).toBe(0);
    let applied = false;
    expect(await main([], { report: async () => ({ mode: 'report', writes: 0, counts: { add: 0, remove: 0 }, changes: [], total: 0, inSync: 0, unreadable: 0 }), apply: async () => { applied = true; return {}; }, write })).toBe(0);
    expect(applied).toBe(false);
    expect(await main(['--apply'], { apply: async () => { throw new Error('boom'); }, write })).toBe(2);
    for (const bad of ['--apply=false', '--apply=0', '--apply=']) {
      applied = false;
      expect(await main([bad], { apply: async () => { applied = true; return {}; }, report: async () => { applied = true; return {}; }, write })).toBe(2);
      expect(applied).toBe(false);
    }
  });
});
