/** @file pr-stall-sweep.test.mjs
 * @description Slice 2 of the automatic PR stall sweep: settings + kill switch, the shadow pass and its audit log, the
 *   rate limits, and the hard rule that shadow mode makes ZERO GitHub writes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStallSweepSettings, runStallSweep, planStallActions, stallSweepDir, strictGh, strictDrainText, STALL_SWEEP_DEFAULTS } from '../pr-stall-sweep.mjs';
import { createPrSweepReader } from '../../operations/pr-sweep-io.mjs';
import { runPrSweep } from '../pr-sweep.mjs';
import { runPrSweepJob } from '../pr-sweep-job.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T18:00:00Z');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const auditDir = () => { const root = mkdtempSync(join(tmpdir(), 'stall-')); roots.push(root); return join(root, 'pr-stall-sweep'); };
const lines = (dir) => { const f = join(dir, '2026-10.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };
const shadow = (o = {}) => ({ value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow', ...o }, sources: { mode: 'test' }, errors: [] });

const old = new Date(NOW - 3 * 3600_000).toISOString();
const PRS = [
  { number: 11, title: 'fixer gone', url: 'u', isDraft: false, headRefOid: HEAD, updatedAt: old, createdAt: old, body: '', labels: [{ name: 'review:changes' }], statusCheckRollup: [] },
  { number: 12, title: 'at the cap', url: 'u', isDraft: false, headRefOid: 'b'.repeat(40), updatedAt: old, createdAt: old, body: '', labels: [{ name: 'status:at-round-limit' }], statusCheckRollup: [] },
];
/** A fake `gh` that answers the read verbs and records every call. */
function fakeGh({ prs = PRS, truncated = false } = {}) {
  const calls = [];
  const gh = (_bin, args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('commits')) {
      const pr = prs.find((p) => String(p.number) === String(args[2]));
      return JSON.stringify({ commits: [{ oid: pr?.commitOid ?? pr?.headRefOid, committedDate: old }] });
    }
    if (args[0] === 'pr' && args[1] === 'view' && args.some((x) => String(x).startsWith('files'))) return JSON.stringify({ files: [{ path: 'scripts/foo.mjs' }], changedFiles: truncated ? 150 : 1 });
    if (args[0] === 'api') return JSON.stringify([[]]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}
const WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];
function expectReadOnly(calls) {
  expect(calls.length).toBeGreaterThan(0);
  for (const a of calls) {
    expect(['pr', 'api'], a.join(' ')).toContain(a[0]);
    if (a[0] === 'pr') expect(['list', 'view'], a.join(' ')).toContain(a[1]);
    for (const f of WRITE_FLAGS) expect(a, a.join(' ')).not.toContain(f);
  }
}
const reader = (gh, unreadable = false) => {
  const r = createPrSweepReader({ run: gh, ps: () => '', readText: () => '', now: () => NOW, settings: () => ({ prSweep: { repos: [REPO] } }) });
  return unreadable ? (i) => ({ ...r(i), unreadable: ['drain log: torn'] }) : r;
};

describe('settings', () => {
  const file = (block) => (path) => { if (String(path).endsWith('pr-stall-sweep.json')) return JSON.stringify({ prStallSweep: block }); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const log = () => {};
  it('is off by standard, and every leaf carries its source', () => {
    const s = resolveStallSweepSettings({ env: {}, read: file({}), log });
    expect(s.value).toMatchObject({ mode: 'off', intervalMinutes: 15, maxActionsPerSweep: 3, maxActionsPerHour: 6, maxActionsPerPrHead: 1, grantCeiling: 10 });
    expect(s.sources.mode).toBe('standard');
  });
  it('the repo file, then env, win in order', () => {
    expect(resolveStallSweepSettings({ env: {}, read: file({ mode: 'shadow' }), log })).toMatchObject({ value: { mode: 'shadow' }, sources: { mode: 'tool' } });
    expect(resolveStallSweepSettings({ env: { WE_PR_STALL_SWEEP_MODE: 'off' }, read: file({ mode: 'shadow' }), log })).toMatchObject({ value: { mode: 'off' }, sources: { mode: 'env' } });
    expect(resolveStallSweepSettings({ env: { WE_PR_STALL_SWEEP_MAX_ACTIONS_PER_HOUR: '2' }, read: file({}), log }).value.maxActionsPerHour).toBe(2);
  });
  it('an unusable kill-switch value turns the sweep OFF', () => {
    const s = resolveStallSweepSettings({ env: { WE_PR_STALL_SWEEP_MODE: 'yes please' }, read: file({ mode: 'shadow' }), log });
    expect(s.value.mode).toBe('off');
    expect(s.sources.mode).toMatch(/unusable/);
  });
  it('an unusable mode in the repo file is OFF, never a lower layer\'s shadow', () => {
    const read = (path) => { if (String(path).endsWith('pr-stall-sweep.json')) return JSON.stringify({ prStallSweep: { mode: 'sure' } });
      if (/platform-preferences/.test(String(path))) return JSON.stringify({ prStallSweep: { mode: 'shadow' } }); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    expect(resolveStallSweepSettings({ env: {}, read, log }).value.mode).toBe('off');
    expect(resolveStallSweepSettings({ env: {}, read: file({ mode: { nested: 'shadow' } }), log }).value.mode).toBe('off');
    const emptyMode = (path) => (String(path).endsWith('pr-stall-sweep.json') ? JSON.stringify({ prStallSweep: { mode: {} } }) : read(path));
    expect(resolveStallSweepSettings({ env: {}, read: emptyMode, log }).value.mode).toBe('off');
  });
  it.each([['null'], ['[]'], ['"off"']])('a settings file whose root is %s means OFF', (root) => {
    const read = (path) => (String(path).endsWith('pr-stall-sweep.json') ? root : JSON.stringify({ prStallSweep: { mode: 'shadow' } }));
    expect(resolveStallSweepSettings({ env: {}, read, log }).value.mode).toBe('off');
  });
  it('an unreadable settings layer means OFF', () => {
    const torn = (path) => { if (String(path).endsWith('pr-stall-sweep.json')) return '{"prStallSweep": {"mode": "off"'; return JSON.stringify({ prStallSweep: { mode: 'shadow' } }); };
    expect(resolveStallSweepSettings({ env: {}, read: torn, log }).value.mode).toBe('off');
  });
  it.each([[false], ['off'], [[]], [null]])('a settings block that is %j means OFF', (block) => {
    const read = (path) => (String(path).endsWith('pr-stall-sweep.json') ? JSON.stringify({ prStallSweep: block }) : JSON.stringify({ prStallSweep: { mode: 'shadow' } }));
    expect(resolveStallSweepSettings({ env: {}, read, log }).value.mode).toBe('off');
  });
  it('a wrong-shape override never loosens a valid stricter platform value', () => {
    const read = (path) => (String(path).endsWith('pr-stall-sweep.json') ? JSON.stringify({ prStallSweep: { maxActionsPerHour: { a: 50 }, grantCeiling: { b: 10 } } })
      : JSON.stringify({ prStallSweep: { maxActionsPerHour: 1, grantCeiling: 1 } }));
    const s = resolveStallSweepSettings({ env: {}, read, log });
    expect([s.value.maxActionsPerHour, s.value.grantCeiling]).toEqual([1, 1]);
  });
  it('the final values are logged with their sources', () => {
    const out = []; resolveStallSweepSettings({ env: { WE_POLICY_CASCADE_LOG: '1', WE_PR_STALL_SWEEP_MODE: 'bogus' }, read: file({ mode: 'shadow' }), log: (l) => out.push(l) });
    expect(out.join('\n')).toMatch(/prStallSweep.*mode="off" \(unusable mode value: off\)/);
  });
  it('a nested object where a number belongs falls back to the standard', () => {
    const s = resolveStallSweepSettings({ env: {}, read: file({ maxActionsPerHour: { a: 50 }, maxActionsPerSweep: { b: 9 } }), log });
    expect([s.value.maxActionsPerHour, s.value.maxActionsPerSweep]).toEqual([6, 3]);
    expect(s.errors.join(' ')).toMatch(/tool\.maxActionsPerHour=.*wrong shape/);
  });
  it('the classifier policies are cascade leaves; an invalid one is refused, not applied', () => {
    const s = resolveStallSweepSettings({ env: {}, read: file({ stateLanes: { fixing: 'operator' }, policyActions: { grant: false }, grantCeiling: 99 }), log });
    expect(s.value.stateLanes).toEqual({ fixing: 'operator' });
    expect(s.value.policyActions.grant).toBe(false);
    expect(s.value.grantCeiling).toBe(10);
    expect(s.errors.join(' ')).toMatch(/grantCeiling/);
  });
  it('the audit dir override only counts for a pr-stall-sweep directory', () => {
    expect(stallSweepDir({ WE_PR_STALL_SWEEP_DIR: '/tmp/elsewhere' })).toMatch(/\.operations\/pr-stall-sweep$/);
    expect(stallSweepDir({ WE_PR_STALL_SWEEP_DIR: '/tmp/x/pr-stall-sweep' })).toBe('/tmp/x/pr-stall-sweep');
  });
});

describe('the shadow pass', () => {
  it('makes ZERO GitHub writes, and logs what it would do', async () => {
    const { gh, calls } = fakeGh(); const dir = auditDir();
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expectReadOnly(calls);
    expect(calls.some((a) => a.includes('files,changedFiles'))).toBe(true); // the judged row read its file list
    const recs = lines(dir);
    expect(recs.map((r) => r.phase).sort()).toEqual(['operator', 'pass', 'would-do']);
    expect(recs.find((r) => r.phase === 'would-do')).toMatchObject({ lane: 'system', action: 'tooling-card', pr: 11, mode: 'shadow' });
    expect(recs.find((r) => r.phase === 'operator')).toMatchObject({ pr: 12, lane: 'operator' });
    expect(out.state.lastRunAt).toBe(NOW);
  });
  it('`on` is not implemented: it behaves exactly as shadow, still with zero writes', async () => {
    const { gh, calls } = fakeGh(); const dir = auditDir();
    await runStallSweep({ now: NOW, env: {}, settings: shadow({ mode: 'on' }), gh, read: reader(gh), dir, log: () => {} });
    expectReadOnly(calls);
    expect(lines(dir).find((r) => r.phase === 'would-do').modeNote).toMatch(/not implemented/);
  });
  it('off reads nothing and writes nothing', async () => {
    const { gh, calls } = fakeGh(); const dir = auditDir();
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow({ mode: 'off' }), gh, read: reader(gh), dir })).skipped).toBe('off');
    expect(calls).toEqual([]); expect(lines(dir)).toEqual([]);
  });
  it('waits its interval, and never repeats a line for the same head', async () => {
    const { gh } = fakeGh(); const dir = auditDir();
    const first = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expect((await runStallSweep({ now: NOW + 60_000, env: {}, state: first.state, settings: shadow(), gh, read: reader(gh), dir })).skipped).toBe('not-due');
    await runStallSweep({ now: NOW + 20 * 60_000, env: {}, state: first.state, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expect(lines(dir).filter((r) => r.phase !== 'pass').length).toBe(2);
  });
  it('an incomplete read plans no action', async () => {
    const { gh } = fakeGh(); const dir = auditDir();
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh, true), dir, log: () => {} });
    expect(out.act).toEqual([]);
    expect(lines(dir).map((r) => r.phase)).toEqual(['pass']);
  });
  it('an unreadable file list or a corrupt audit history plans no action', async () => {
    const { gh } = fakeGh(); const dir = auditDir();
    const failing = async () => { throw new Error('gh 502'); };
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), readFiles: failing, dir, log: () => {} })).act).toEqual([]);
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), readFiles: async () => [undefined], dir: auditDir(), log: () => {} })).act).toEqual([]);
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), readFiles: async () => [], dir: auditDir(), log: () => {} })).act).toEqual([]);
    const failClosed = () => ({ verdict: 'escalate', reasons: ['fail-closed: x'], evidence: { failClosed: true } });
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), judge: failClosed, dir: auditDir(), log: () => {} })).act).toEqual([]);
    const dir2 = auditDir(); mkdirSync(dir2, { recursive: true }); writeFileSync(join(dir2, '2026-09.jsonl'), '{"phase":"would-do"\n');
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir: dir2, log: () => {} });
    expect(out.act).toEqual([]); expect(out.incomplete).toBe(true);
  });
  it('one unreadable PR row makes the whole pass plan nothing', async () => {
    const fresh = { ...PRS[0], number: 13, headRefOid: 'not-a-sha', updatedAt: new Date(NOW).toISOString(), labels: [] };
    const { gh } = fakeGh({ prs: [...PRS, fresh] }); const dir = auditDir();
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expect(out.act).toEqual([]); expect(out.incomplete).toBe(true);
  });
  it.each([['an event with no label', { events: [[{ event: 'labeled', created_at: old }]] }], ['commits that are not a list', { commits: {} }],
    ['a comment with no body', { comments: [[{ user: { login: 'x' }, created_at: old }]] }]])('the strict gh seam turns %s into an unreadable PR, and the pass plans nothing', async (_n, bad) => {
    const { gh } = fakeGh();
    const wrapped = (bin, args, o) => {
      const p = String(args.at(-1));
      if (bad.events && /\/events\?/.test(p)) return JSON.stringify(bad.events);
      if (bad.comments && /\/comments\?/.test(p)) return JSON.stringify(bad.comments);
      if (bad.commits && args.includes('commits')) return JSON.stringify({ commits: bad.commits });
      return gh(bin, args, o);
    };
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh: wrapped, read: reader(strictGh(wrapped)), dir: auditDir(), log: () => {} });
    expect(out.act).toEqual([]); expect(out.incomplete).toBe(true);
  });
  it('a truncated file list (gh caps it at 100) plans nothing', async () => {
    const { gh } = fakeGh({ truncated: true });
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir: auditDir(), log: () => {} });
    expect(out.act).toEqual([]); expect(out.errors.join(' ')).toMatch(/truncated/);
  });
  it('a malformed drain skip row makes the drain log unreadable', () => {
    const line = (rows) => `x\n2026 merge-ai-prs · skip-reasons: ${JSON.stringify(rows)}\n`;
    expect(strictDrainText(() => line([{ num: 11, kind: 'not-certified' }]))('p')).toMatch(/skip-reasons/);
    expect(() => strictDrainText(() => line([{ num: '11', kind: 'not-certified' }]))('p')).toThrow(/malformed/);
    expect(strictDrainText(() => 'no marker')('p')).toBe('no marker');
  });
  it('a held audit lock plans nothing', async () => {
    const { gh } = fakeGh(); const dir = auditDir(); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.lock'), `${process.pid}\n`);
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expect(out.act).toEqual([]); expect(out.errors.join(' ')).toMatch(/audit log/);
  }, 30_000);
  it.each([[{ updatedAt: 'unreadable' }], [{ statusCheckRollup: undefined }], [{ statusCheckRollup: [{}] }], [{ body: undefined }], [{ createdAt: undefined }], [{ statusCheckRollup: [{ name: 'test', status: 'COMPLETED' }] }], [{ commitOid: 'c'.repeat(40) }], [{ isDraft: undefined }], [{ labels: [{}] }]])('one PR with unreadable evidence %j makes the pass plan nothing', async (patch) => {
    const { gh } = fakeGh({ prs: [...PRS, { ...PRS[0], number: 14, labels: [], ...patch }] });
    expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir: auditDir(), log: () => {} })).act).toEqual([]);
  });
  it('the judge gets the configured rounds.judge.maxGrants', async () => {
    const { gh } = fakeGh(); const judge = vi.fn(() => ({ verdict: 'escalate', reasons: ['x'], evidence: {} }));
    await runStallSweep({ now: NOW, env: { WE_ROUND_JUDGE_SHADOW_DIR: '/nowhere' }, settings: shadow(), gh, read: reader(gh), judge, dir: auditDir(), log: () => {} });
    expect(judge).toHaveBeenCalledOnce();
    expect(Number.isInteger(judge.mock.calls[0][0].maxGrants)).toBe(true);
  });
  it('the per-head cap is lifetime: an action logged months ago still counts', async () => {
    const { gh } = fakeGh(); const dir = auditDir(); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-01.jsonl'), `${JSON.stringify({ phase: 'would-do', ts: '2026-01-02T00:00:00Z', prHead: `${REPO}#11@${HEAD}`, key: `${REPO}#11@${HEAD}:awaiting-review`, action: 'ask-review-daemon' })}\n`);
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir, log: () => {} });
    expect(out.act).toEqual([]); expect(out.held[0]).toMatchObject({ pr: 11, held: 'per-PR-head cap' });
  });
  it('a classifier setting reaches the classifier', async () => {
    const { gh } = fakeGh(); const dir = auditDir();
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow({ stateLanes: { fixing: 'operator' } }), gh, read: reader(gh), dir, log: () => {} });
    expect(out.items.find((i) => i.pr === 11)).toMatchObject({ lane: 'operator', action: 'tooling-card' });
  });
  it('under test with no explicit dir it writes nothing, whatever the env override says', async () => {
    const { gh, calls } = fakeGh();
    for (const env of [{ VITEST: 'true' }, { VITEST: 'true', WE_PR_STALL_SWEEP_DIR: '/tmp/not-it' }]) {
      expect((await runStallSweep({ now: NOW, env, settings: shadow(), gh, read: reader(gh) })).skipped).toBe('under-test');
    }
    expect(calls).toEqual([]);
  });
  it('an audit log that cannot be written plans nothing', async () => {
    const { gh } = fakeGh(); const root = auditDir(); mkdirSync(root.replace(/pr-stall-sweep$/, ''), { recursive: true });
    writeFileSync(root, 'a file, not a dir');
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir: root, log: () => {} });
    expect(out.act).toEqual([]); expect(out.errors.join(' ')).toMatch(/audit log/);
  });
  it('an action record missing what the limits count by makes the history incomplete', async () => {
    const { gh } = fakeGh(); const dir = auditDir(); mkdirSync(dir, { recursive: true });
    for (const bad of [{ ts: 'not a time', prHead: `${REPO}#1@${HEAD}`, key: `${REPO}#1@${HEAD}:fixing` }, { ts: '2026-10-01T00:00:00Z', prHead: '', key: ':fixing' }]) {
      const d = auditDir(); mkdirSync(d, { recursive: true }); writeFileSync(join(d, '2026-10.jsonl'), `${JSON.stringify({ phase: 'would-do', action: 'a', ...bad })}\n`);
      expect((await runStallSweep({ now: NOW, env: {}, settings: shadow(), gh, read: reader(gh), dir: d, log: () => {} })).act).toEqual([]);
    }
    void dir;
  });
});

describe('rate limits', () => {
  const item = (n, o = {}) => ({ lane: 'system', action: 'tooling-card', key: `${REPO}#${n}@h:fixing`, prHead: `${REPO}#${n}@h`, ...o });
  const limits = { maxActionsPerSweep: 2, maxActionsPerHour: 3, maxActionsPerPrHead: 1 };
  it('per sweep', () => {
    const p = planStallActions([item(1), item(2), item(3)], { now: NOW, limits });
    expect(p.act.map((i) => i.key)).toEqual([item(1).key, item(2).key]);
    expect(p.held[0].held).toBe('per-sweep cap');
  });
  it('per hour, from the audit history', () => {
    const history = [1, 2].map((n) => ({ ...item(90 + n), phase: 'would-do', ts: new Date(NOW - 10 * 60_000).toISOString() }));
    expect(planStallActions([item(1), item(2)], { now: NOW, limits, history }).held[0].held).toBe('per-hour cap');
    const stale = history.map((h) => ({ ...h, ts: new Date(NOW - 2 * 3600_000).toISOString() }));
    expect(planStallActions([item(1), item(2)], { now: NOW, limits, history: stale }).act).toHaveLength(2);
  });
  it('per PR head, and once-per-head asks are never repeated', () => {
    expect(planStallActions([item(1), item(1, { action: 'ask-review-daemon', key: 'k2' })], { now: NOW, limits }).held[0].held).toBe('per-PR-head cap');
    const history = [{ ...item(1, { onceKey: 'o' }), action: 'ask-review-daemon', phase: 'would-do', ts: new Date(NOW - 5 * 3600_000).toISOString() }];
    expect(planStallActions([item(5, { action: 'ask-review-daemon', onceKey: 'o' })], { now: NOW, limits, history })).toEqual({ act: [], held: [] });
  });
  it('operator items are never planned', () => expect(planStallActions([item(1, { lane: 'operator' })], { now: NOW, limits }).act).toEqual([]));
});

describe('wiring', () => {
  const base = { now: NOW, config: {}, settings: { value: { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, dispatchDiagnosis: false, repos: [REPO] }, sources: {} },
    readPrevious: () => ({ stallSweep: { lastRunAt: 1 } }), readPrs: () => [], readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: async () => ({}),
    notify: () => ({ ok: true }), flush: () => ({}), persist: () => {}, append: () => {} };
  it('the health PR job runs the stall sweep and keeps its state', async () => {
    const stallSweep = vi.fn(async ({ state }) => ({ mode: 'shadow', state: { lastRunAt: NOW, was: state.lastRunAt }, items: [], act: [] }));
    const report = await runPrSweep({ ...base, stallSweep });
    expect(stallSweep).toHaveBeenCalledOnce();
    expect(report.nextState.stallSweep).toEqual({ lastRunAt: NOW, was: 1 });
    expect(report.stallSweep).toMatchObject({ mode: 'shadow', wouldDo: 0 });
  });
  it('the card-335 report is saved BEFORE the stall sweep runs', async () => {
    const order = [];
    await runPrSweep({ ...base, persist: () => order.push('persist'), stallSweep: async () => { order.push('stall'); return { state: {} }; } });
    expect(order).toEqual(['persist', 'stall', 'persist']);
  });
  it('a dry run does not run it', async () => {
    const stallSweep = vi.fn();
    await runPrSweep({ ...base, dryRun: true, stallSweep });
    expect(stallSweep).not.toHaveBeenCalled();
  });
  it('a failing stall sweep keeps the previous state and reports the error', async () => {
    const report = await runPrSweep({ ...base, stallSweep: async () => { throw new Error('boom'); } });
    expect(report.nextState.stallSweep).toEqual({ lastRunAt: 1 });
    expect(report.errors.join(' ')).toMatch(/stall sweep: boom/);
  });
  it('the job runs at least as often as the stall interval when the sweep is on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stall-job-')); roots.push(root);
    const seams = () => ({ store: { dir: root, list: () => ({ records: [] }) }, enqueue: vi.fn(() => ({ id: 'n' })), reattach: vi.fn(async () => ({})), evict: vi.fn(), prune: vi.fn(), codeSha: 'abc', sourceRoot: tmpdir(), snapshot: {} });
    const state = { lastEnqueuedAt: NOW - 20 * 60_000 };
    const on = seams(); await runPrSweepJob({ now: NOW, state, config: { intervalMinutes: 30 }, ...on, stallSettings: () => shadow(), log: () => {} });
    expect(on.enqueue).toHaveBeenCalledOnce();
    const off = seams(); await runPrSweepJob({ now: NOW, state, config: { intervalMinutes: 30 }, ...off, stallSettings: () => shadow({ mode: 'off' }), log: () => {} });
    expect(off.enqueue).not.toHaveBeenCalled();
  });
});
