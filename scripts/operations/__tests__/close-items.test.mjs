import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { planCloseItems, closeItemsOperation, evidencePointer, CATEGORIES } from '../close-items.mjs';
import { planReopenItems, reopenItemsOperation } from '../reopen-items.mjs';
import { createCloseItemsReader, createReopenItemsReader, createCloseItemsSinks } from '../close-items-io.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { readQueueFile } from '../../conveyor/queue-store.mjs';
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const body = (status = 'open', extra = '') => `---\nstatus: ${status}\nkind: story\nworkItem: story\nsize: 3\ndateOpened: "2026-10-01"\n${extra}---\n# Fixture\n\nFixture body.\n`;
function fixture(cards = {}) {
  const root = mkdtempSync(join(tmpdir(), 'close-items-')); roots.push(root);
  mkdirSync(join(root, 'backlog')); mkdirSync(join(root, 'scripts/settings'), { recursive: true });
  writeFileSync(join(root, 'scripts/settings/build-priority.json'), JSON.stringify({ build: { priority: ['20'] } }));
  for (const [id, content] of Object.entries(cards)) writeFileSync(join(root, 'backlog', `${id}-fixture.md`), content);
  const queueFile = join(root, 'queue.json'); writeFileSync(queueFile, JSON.stringify([{ num: '001' }, { num: 'xabc123' }, { num: '2' }]));
  const options = { root, env: { CONVEYOR_QUEUE_FILE: queueFile }, today: () => '2026-10-13', openPrs: () => ({ nums: ['7'] }), actor: 'fixture-operator', channel: 'test' };
  return { root, queueFile, options, reader: createCloseItemsReader(options), path: id => join(root, 'backlog', `${id}-fixture.md`) };
}
async function run(declaration, input, sinks = {}) {
  const registry = createRegistry(); registry.register(declaration);
  let record = advanceWhileRunning(startRun({ op: declaration.name, id: 'fixture-run', input, registry }), { registry });
  if (record.pending?.kind === 'effect') ({ run: record } = await applyPendingEffects(record, { sinks, store: createMemoryRunStore() }));
  return record;
}
describe('close-items fixture batches', () => {
  it('exercises every per-id refusal and leaves all files unchanged on dry run', async () => {
    const f = fixture({ 1: body(), 2: body('open', 'parent: "20"\n'), 3: body('active'), 4: body('preparing'), 5: body('resolved'), 6: body('closed'),
      7: body(), 8: body(), 9: body('parked', 'blockedBy: ["8"]\n'), 10: body(), 11: body('open', 'parent: "10"\n'),
      12: body(), 13: body('mystery'), 14: body(), 20: body(), 99: body() });
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 404].map(num => ({ num, bucket: 'DUPLICATE', outcome: num === 14 ? 'pack' : 'fold', dupOf: num === 12 ? 404 : 99 }));
    writeFileSync(join(f.root, 'triage.json'), JSON.stringify({ mainSha: 'abcdef123', rows }));
    const before = Object.fromEntries(Object.keys({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 10: 1, 12: 1, 13: 1, 14: 1 }).map(id => [id, readFileSync(f.path(id), 'utf8')]));
    const queueBefore = readFileSync(f.queueFile, 'utf8');
    const record = await run(closeItemsOperation({ readCloseItemsContext: f.reader }), { triage: 'triage.json', category: 'DUPLICATE' });
    expect(record.verdict.counts).toEqual({ requested: 13, wouldClose: 1, refused: 12, byRefusal: {
      'on-priority': 1, 'in-flight': 2, 'already-terminal': 2, 'open-pr': 1, 'live-dependent': 1, 'open-children': 1,
      'bad-pointer': 1, 'pack-not-fold': 1, 'transition-refused': 1, 'not-found': 1,
    } });
    expect(record.findings.plan.audit).toMatchObject({ actor: 'fixture-operator', channel: 'test', reason: 'duplicate' });
    for (const [id, text] of Object.entries(before)) expect(readFileSync(f.path(id), 'utf8')).toBe(text);
    expect(readFileSync(f.queueFile, 'utf8')).toBe(queueBefore);
  });
  it.each(Object.keys(CATEGORIES))('maps %s from triage without writing', category => {
    const f = fixture({ 1: body(), 99: body() });
    const triage = { mainSha: 'abc1234', rows: [{ num: 1, bucket: category, outcome: 'fold', dupOf: 99, evidence: 'abcdef123 fixed here' }, { num: 99, bucket: 'KEEP' }] };
    writeFileSync(join(f.root, 'triage.json'), JSON.stringify(triage));
    const input = { triage: 'triage.json', category };
    const p = planCloseItems(f.reader(input), input);
    expect(p.output.counts).toMatchObject({ requested: 1, wouldClose: 1, refused: 0 });
    expect(p.output.closed[0].closedReason).toBe(CATEGORIES[category]);
    if (category === 'ALREADY-FIXED') expect(p.output.closed[0].closedBy).toBe('abcdef123');
    expect(readFileSync(f.path(1), 'utf8')).toBe(body());
  });
  it('refuses KEEP, mixed modes, and invalid pointers including batch members', () => {
    const f = fixture({ 1: body(), 2: body(), 3: body('closed') });
    const read = f.reader({});
    expect(() => planCloseItems(read, { triage: 'x', category: 'KEEP' })).toThrow(/KEEP/);
    expect(() => planCloseItems(read, { triage: 'x', category: 'OBSOLETE', ids: '1' })).toThrow(/exclusive/);
    for (const into of ['', '404', '1', '3', '2']) {
      const p = planCloseItems(read, { ids: into === '2' ? '1,2' : '1', reason: 'duplicate', into });
      expect(p.output.refused[0].refusal).toBe('bad-pointer');
    }
  });
  it('refuses hash-named cards and their NNN aliases referenced by an open PR (#5184 send-back)', () => {
    const f = fixture({ 123: body('open', 'bornAs: xabc123\n'), xdef456: body(), 44: body('open', 'bornAs: xbody44\n'),
      55: body(), 66: body('open', 'bornAs: xtitl66\n'), 77: body() });
    const prs = [
      { repo: 'o/r', number: 9001, headRefName: 'lane/descriptive-name', title: 'docs', body: '',
        files: ['backlog/xabc123-renamed-before-numbering.md', 'backlog/xdef456-fixture.md'] },
      { repo: 'o/r', number: 9002, headRefName: 'feature/xbody44', title: 'chore', body: 'Refs #55 and `we:backlog/77-fixture.md`.', files: [] },
      { repo: 'o/r', number: 9003, headRefName: 'lane/foo', title: 'WE #xtitl66: thing', body: '', files: [] },
    ];
    const read = { ...f.reader({}), openPrs: { prs } };
    const p = planCloseItems(read, { ids: '123,xabc123,xdef456,44,xbody44,55,66,77', reason: 'obsolete' });
    expect(p.output.counts.wouldClose).toBe(0);
    expect(p.output.refused.map(r => [r.id, r.refusal])).toEqual(['123', 'xabc123', 'xdef456', '44', 'xbody44', '55', '66', '77'].map(id => [id, 'open-pr']));
    expect(p.output.refused[0].detail).toMatch(/o\/r#9001/);
    expect(planCloseItems({ ...read, openPrs: { prs: [] } }, { ids: '123,xdef456', reason: 'obsolete' }).output.counts.wouldClose).toBe(2);
  });
  it('fails the whole apply on unavailable/incomplete PR checks and warns in dry run', () => {
    const f = fixture({ 1: body() });
    for (const openPrs of [{ unavailable: true }, { partial: [{ repo: 'fixture' }] }, { prs: [], truncated: [{ repo: 'fixture', reason: 'page cap' }] }, undefined, {}]) {
      const read = { ...f.reader({}), openPrs };
      expect(planCloseItems(read, { ids: '1', reason: 'obsolete' }).output.warnings).toEqual(['open-pr-check-unavailable']);
      try { planCloseItems(read, { ids: '1', reason: 'obsolete', apply: true }); throw new Error('did not refuse'); }
      catch (e) { expect(e.reason).toBe('open-pr-check-unavailable'); }
      expect(readFileSync(f.path(1), 'utf8')).toBe(body());
    }
  });
  describe('open-PR read for the close guard (paged, fail closed)', () => {
    const page = (nodes, hasNextPage, totalCount) => JSON.stringify({ data: { repository: { pullRequests: { totalCount,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c1' : null }, nodes } } } });
    const node = (number, headRefName) => ({ number, title: `t${number}`, url: '', isDraft: false, createdAt: '', updatedAt: 'u',
      headRefName, headRefOid: 'h', baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      reviewDecision: '', labels: { nodes: [] }, commits: { nodes: [] } });
    function fakeGh({ pages, changedFiles = 1, files = n => [`backlog/x${n}aaaaa-fixture.md`] }) {
      let call = 0;
      return (cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql') return pages[call++];
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ body: '', changedFiles });
        const n = /pulls\/(\d+)\/files/.exec(args[1])?.[1];
        if (args[0] === 'api' && n) return files(n).map(p => `${p}\t`).join('\n');
        throw new Error(`unexpected gh ${args.join(' ')}`);
      };
    }
    const opts = exec => ({ exec, repos: ['o/r'], maxRows: 1, paging: { pageSize: 1, pageRetries: 0, heavyMaxAgeSeconds: 0 } });
    it('reads every page and refuses the hash card a PR file names', () => {
      const exec = fakeGh({ pages: [page([node(1, 'lane/a')], true, 2), page([node(2, 'lane/b')], false, 2)] });
      const f = fixture({ x2aaaaa: body() });
      const read = createCloseItemsReader({ ...f.options, openPrs: undefined, openPrRead: { ...opts(exec), maxRows: 10 } })({});
      expect(read.openPrs.prs.map(p => p.number)).toEqual([1, 2]);
      expect(planCloseItems(read, { ids: 'x2aaaaa', reason: 'obsolete', apply: true }).output.refused[0].refusal).toBe('open-pr');
    });
    it.each([
      ['a page cap with more pages left', { pages: [page([node(1, 'lane/a')], true, 2)] }],
      ['a file list shorter than changedFiles', { pages: [page([node(1, 'lane/a')], false, 1)], changedFiles: 3 }],
      ['an unreadable page', { pages: ['{"errors":[{"message":"boom"}]}'] }],
    ])('refuses apply on %s', (_, gh) => {
      const f = fixture({ 1: body() });
      const read = createCloseItemsReader({ ...f.options, openPrs: undefined, openPrRead: opts(fakeGh(gh)) })({});
      expect(() => planCloseItems(read, { ids: '1', reason: 'obsolete', apply: true })).toThrow(/open PR check unavailable/);
    });
  });
  it('allows children/dependents within the batch and cascades refusals for members that remain live', () => {
    const f = fixture({ 1: body(), 2: body('open', 'blockedBy: ["1"]\nparent: "1"\n') });
    expect(planCloseItems(f.reader({}), { ids: '1,2', reason: 'obsolete' }).output.counts.wouldClose).toBe(2);
    const read = f.reader({}); read.cards.find(c => c.num === '2').status = 'active';
    expect(planCloseItems(read, { ids: '1,2', reason: 'obsolete' }).output.counts.wouldClose).toBe(0);
  });
  it.each([false, true])('refuses to close a survivor of existing duplicates (apply=%s)', async apply => {
    const f = fixture({ 1: body('open', 'bornAs: xsurvivor\nblockedBy: ["5"]\n'), 2: body(), 3: body(), 4: body(), 5: body() });
    const sinks = createCloseItemsSinks(f.options);
    await run(closeItemsOperation({ readCloseItemsContext: f.reader }), { ids: '2,3', reason: 'duplicate', into: '1', apply: true }, sinks);
    // Both canonical and pre-numbering references must protect the survivor.
    writeFileSync(f.path(3), readFileSync(f.path(3), 'utf8').replace('closedInto: "1"', 'closedInto: "xsurvivor"'));
    const before = [1, 2, 3, 5].map(id => readFileSync(f.path(id), 'utf8'));
    const queueBefore = readFileSync(f.queueFile, 'utf8');
    for (const reason of ['duplicate', 'fixed-elsewhere', 'obsolete', 'wont-do']) {
      const record = await run(closeItemsOperation({ readCloseItemsContext: f.reader }), {
        ids: 'xsurvivor,5', reason, ...(reason === 'duplicate' ? { into: '4' } : {}),
        ...(reason === 'fixed-elsewhere' ? { by: '#1234' } : {}), apply,
      }, sinks);
      expect(record.verdict.counts[apply ? 'closed' : 'wouldClose']).toBe(0);
      expect(record.verdict.refused).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'xsurvivor', refusal: 'closed-duplicates', detail: expect.stringMatching(/2.*3/) }),
        expect.objectContaining({ id: '5', refusal: 'live-dependent' }),
      ]));
      expect([1, 2, 3, 5].map(id => readFileSync(f.path(id), 'utf8'))).toEqual(before);
      expect(readFileSync(f.queueFile, 'utf8')).toBe(queueBefore);
    }
  });
  it.each([false, true])('refuses to reopen a dependent with closed blockers (apply=%s)', async apply => {
    const f = fixture({ 1: body('closed', 'closedReason: obsolete\ndateClosed: "2026-10-13"\nblockedBy: ["002", "xblocker", "4"]\n'),
      2: body('closed'), 3: body('closed', 'bornAs: xblocker\n'), 4: body('resolved') });
    const before = readFileSync(f.path(1), 'utf8');
    const record = await run(reopenItemsOperation({ readReopenItemsContext: createReopenItemsReader(f.options) }),
      { ids: '1', reason: 'returned', apply }, createCloseItemsSinks(f.options));
    expect(record.verdict.counts).toMatchObject({ [apply ? 'reopened' : 'wouldReopen']: 0, refused: 1, byRefusal: { 'closed-blockers': 1 } });
    expect(record.verdict.refused[0]).toMatchObject({ id: '1', refusal: 'closed-blockers', detail: expect.stringMatching(/2.*3/) });
    expect(readFileSync(f.path(1), 'utf8')).toBe(before);
  });
  it.each(['close', 'reopen', 'unresolve'])('guards links through the backlog CLI %s verb', verb => {
    const f = fixture({ '001': body(verb === 'close' ? 'open' : verb === 'unresolve' ? 'resolved' : 'closed',
      'bornAs: xsurvivor\nblockedBy: ["xblocker"]\n'),
      '002': body('closed', 'closedReason: duplicate\nclosedInto: "xsurvivor"\n'),
      '003': body('closed', 'bornAs: xblocker\n') });
    const before = readFileSync(f.path('001'), 'utf8');
    const cli = createRequire(import.meta.url).resolve('../../backlog.mjs');
    const result = spawnSync(process.execPath, [cli, verb, '1', '--reason=obsolete', '--force',
      `--backlog-dir=${join(f.root, 'backlog')}`], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(verb === 'close' ? /closed duplicates 002/ : /closed blockers 003/);
    expect(readFileSync(f.path('001'), 'utf8')).toBe(before);
  });
  it('applies through guarded writes, removes number and bornAs, then reopens without queue insertion', async () => {
    const f = fixture({ 1: body('open', 'bornAs: xabc123\n'), 2: body(), 99: body() });
    const sinks = createCloseItemsSinks(f.options);
    const record = await run(closeItemsOperation({ readCloseItemsContext: f.reader }), { ids: 'xabc123', reason: 'duplicate', into: '99', apply: true, note: 'fold approved' }, sinks);
    expect(record.verdict.counts.closed).toBe(1);
    expect(record.verdict.queueRemoved).toEqual(['001', 'xabc123']);
    expect(readFileSync(f.path(1), 'utf8')).toMatch(/status: closed/);
    expect(readFileSync(f.path(1), 'utf8')).toMatch(/closedReason: duplicate/);
    expect(readFileSync(f.path(1), 'utf8')).toMatch(/closedInto: "99"/);
    expect(readQueueFile(f.queueFile).map(x => x.num)).toEqual(['2']);
    expect(record.findings.plan.audit).toMatchObject({ actor: 'fixture-operator', channel: 'test', ids: ['xabc123'], note: 'fold approved' });
    const require = createRequire(import.meta.url);
    const loaderPath = require.resolve('../../../src/_data/backlog.js');
    const burndownPath = require.resolve('../../../src/_data/burndown.js');
    const oldEnv = process.env.WE_BACKLOG_DIR;
    try {
      process.env.WE_BACKLOG_DIR = join(f.root, 'backlog'); delete require.cache[loaderPath]; delete require.cache[burndownPath];
      const loaded = require(loaderPath)(); expect(loaded.find(c => c.num === '1' || c.num === '001').status).toBe('closed');
      const points = require(burndownPath)().points; expect(points).toEqual({ total: 6, done: 0, remaining: 6 });
    } finally {
      if (oldEnv === undefined) delete process.env.WE_BACKLOG_DIR; else process.env.WE_BACKLOG_DIR = oldEnv;
      delete require.cache[loaderPath]; delete require.cache[burndownPath];
    }
    const reopened = await run(reopenItemsOperation({ readReopenItemsContext: createReopenItemsReader(f.options) }), { ids: '1', reason: 'scope returned', apply: true }, sinks);
    expect(reopened.verdict.counts.reopened).toBe(1); expect(reopened.verdict.note).toMatch(/operator act/);
    const text = readFileSync(f.path(1), 'utf8'); expect(text).toMatch(/status: open/); expect(text).not.toMatch(/closedReason|closedInto|closedBy|dateClosed/);
    expect(text).toMatch(/reopenedReason: "scope returned"/); expect(readQueueFile(f.queueFile).map(x => x.num)).toEqual(['2']);
  });
  it.each(['fixed-elsewhere', 'obsolete', 'wont-do'])('applies %s fields and removes them on reopen', async reason => {
    const f = fixture({ 1: body() }); const sinks = createCloseItemsSinks(f.options);
    await run(closeItemsOperation({ readCloseItemsContext: f.reader }), { ids: '1', reason, ...(reason === 'fixed-elsewhere' ? { by: '#1234' } : {}), apply: true }, sinks);
    const text = readFileSync(f.path(1), 'utf8'); expect(text).toContain(`closedReason: ${reason}`); expect(text).toContain('dateClosed: "2026-10-13"');
    if (reason === 'fixed-elsewhere') expect(text).toContain('closedBy: "#1234"');
    await run(reopenItemsOperation({ readReopenItemsContext: createReopenItemsReader(f.options) }), { ids: '1', reason: 'returned', apply: true }, sinks);
    expect(readFileSync(f.path(1), 'utf8')).not.toMatch(/closedBy|closedReason|dateClosed/);
  });
  it('reopen dry run refuses nonclosed cards and requires a reason', () => {
    const f = fixture({ 1: body(), 2: body('closed') });
    const read = createReopenItemsReader(f.options)({});
    expect(planReopenItems(read, { ids: '1,2,404', reason: 'returned' }).output.counts).toEqual({ requested: 3, wouldReopen: 1, refused: 2, byRefusal: { 'not-closed': 1, 'not-found': 1 } });
    expect(() => planReopenItems(read, { ids: '2', reason: '' })).toThrow(/reason/);
    expect(readFileSync(f.path(2), 'utf8')).toBe(body('closed'));
  });
  it('runs both IO shells through guarded filesystem writes in a real checkout', async () => {
    await withRealRepo(async ({ root, git }) => {
      mkdirSync(join(root, 'backlog'));
      const path = join(root, 'backlog/101-fixture.md');
      writeFileSync(path, body('open', 'bornAs: xreal01\n'));
      const queueFile = join(root, 'queue.json');
      writeFileSync(queueFile, JSON.stringify([{ num: '101' }, { num: 'xreal01' }]));
      const options = { root, env: { CONVEYOR_QUEUE_FILE: queueFile }, openPrs: () => ({ nums: [] }), actor: 'operator', channel: 'fixture' };
      const sinks = createCloseItemsSinks(options);
      const closed = await run(closeItemsOperation({ readCloseItemsContext: createCloseItemsReader(options) }), { ids: '101', reason: 'obsolete', apply: true }, sinks);
      expect(closed.verdict.counts.closed).toBe(1);
      expect(readFileSync(path, 'utf8')).toContain('status: closed');
      expect(readQueueFile(queueFile)).toEqual([]);
      const reopened = await run(reopenItemsOperation({ readReopenItemsContext: createReopenItemsReader(options) }), { ids: 'xreal01', reason: 'new need', apply: true }, sinks);
      expect(reopened.verdict.counts.reopened).toBe(1);
      expect(readFileSync(path, 'utf8')).toContain('status: open');
      expect(readQueueFile(queueFile)).toEqual([]);
      expect(git(['status', '--porcelain'])).toContain('backlog/');
    });
  });
  it('extracts evidence pointers only at the start', () => {
    for (const [value, expected] of [['abcdef1 detail', 'abcdef1'], ['#1234 fixed', '#1234'], ['PR #123 fixed', 'PR #123'], ['https://github.com/a/b/pull/22 fixed', 'https://github.com/a/b/pull/22'], ['words abcdef1', undefined], ['a'.repeat(41), undefined]]) expect(evidencePointer(value)).toBe(expected);
  });
});
