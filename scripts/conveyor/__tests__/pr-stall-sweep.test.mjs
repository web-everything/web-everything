/** @file pr-stall-sweep.test.mjs
 * @description Slice 2 of the automatic PR stall sweep: settings + kill switch, the shadow pass and its audit log, the
 *   rate limits, and the hard rule that shadow mode makes ZERO GitHub writes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStallSweepSettings, runStallSweep, planStallActions, stallSweepDir, strictGh, strictDrainText, STALL_SWEEP_DEFAULTS } from '../pr-stall-sweep.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { createPrSweepReader } from '../../operations/pr-sweep-io.mjs';
import { assessPrSweep } from '../../operations/pr-sweep-core.mjs';
import { runPrSweep } from '../pr-sweep.mjs';
import { runPrSweepJob } from '../pr-sweep-job.mjs';
import { publishStalledDigest } from '../pr-stall-digest.mjs';
import { sidecarsOf, replay, runOnce, unacknowledged } from '../../operations/needs-you-feed.mjs';

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
  { number: 11, state: 'OPEN', title: 'fixer gone', url: 'u', isDraft: false, headRefOid: HEAD, updatedAt: old, createdAt: old, body: '', labels: [{ name: 'review:changes' }], statusCheckRollup: [] },
  { number: 12, state: 'OPEN', title: 'at the cap', url: 'u', isDraft: false, headRefOid: 'b'.repeat(40), updatedAt: old, createdAt: old, body: '', labels: [{ name: 'status:at-round-limit' }], statusCheckRollup: [] },
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
  it('repository shared ceiling resolves to one with tool provenance', () => {
    const log = vi.fn();
    const result = resolveStallSweepSettings({ env: { WE_POLICY_CASCADE_LOG: '1' }, log });
    expect(result).toMatchObject({ value: { maxActionsPerPrHead: 1 }, sources: { maxActionsPerPrHead: 'tool' }, errors: [] });
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('maxActionsPerPrHead=1 (tool)');
  });
  it.each([3, Number.MAX_SAFE_INTEGER])('shared ceiling validator accepts %s without changing its safe-integer bound', cap => {
    expect(resolveStallSweepSettings({ env: {}, read: file({ maxActionsPerPrHead: cap }), log }))
      .toMatchObject({ value: { maxActionsPerPrHead: cap }, sources: { maxActionsPerPrHead: 'tool' }, errors: [] });
  });
  it('shared ceiling validator rejects values above the safe-integer bound', () => {
    const result = resolveStallSweepSettings({ env: {}, read: file({ maxActionsPerPrHead: Number.MAX_SAFE_INTEGER + 1 }), log });
    expect(result.value.maxActionsPerPrHead).toBe(1);
    expect(result.errors.join(' ')).toContain('maxActionsPerPrHead');
  });
  it('digest defaults to true in both the standard and the repository settings', () => {
    expect(STALL_SWEEP_DEFAULTS.digest).toBe(true);
    expect(resolveStallSweepSettings({ env: {}, read: file({}), log })).toMatchObject({ value: { digest: true }, sources: { digest: 'standard' } });
    const repo = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/pr-stall-sweep.json'), 'utf8'));
    expect(repo.prStallSweep.digest).toBe(true);
  });
  it('R452: repository settings keep the shared ceiling at one and allow two red-team restarts per head, then needs-you', () => {
    const repo = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/pr-stall-sweep.json'), 'utf8'));
    expect(repo.prStallSweep.maxActionsPerPrHead).toBe(1);
    expect(repo.prStallSweep.maxRedTeamRestartsPerHead).toBe(2);
  });
  it.each([['false', false], ['0', false], ['true', true], ['1', true]])('parses WE_PR_STALL_SWEEP_DIGEST=%s as %s', (raw, value) => {
    expect(resolveStallSweepSettings({ env: { WE_PR_STALL_SWEEP_DIGEST: raw }, read: file({ digest: !value }), log }))
      .toMatchObject({ value: { digest: value }, sources: { digest: 'env' }, errors: [] });
  });
  it.each(['yes', '', 'FALSE', '2'])('rejects invalid digest environment value %j', raw => {
    const result = resolveStallSweepSettings({ env: { WE_PR_STALL_SWEEP_DIGEST: raw }, read: file({ digest: false }), log });
    expect(result.value.digest).toBe(false);
    expect(result.errors.join(' ')).toMatch(/digest/);
  });
  it.each([null, 'false', 0, {}, []])('rejects invalid digest file value %j', digest => {
    const result = resolveStallSweepSettings({ env: {}, read: file({ digest }), log });
    expect(result.value.digest).toBe(true);
    expect(result.errors.join(' ')).toMatch(/digest/);
  });
  it.each(Object.keys(STALL_SWEEP_DEFAULTS))('validates the %s setting and uses its closed fallback', key => {
    const standard = STALL_SWEEP_DEFAULTS[key];
    // The cascade flattens map leaves: the empty stateLanes standard is represented by an absent map.
    const effective = value => key === 'stateLanes' && value === undefined ? {} : value;
    const defaults = resolveStallSweepSettings({ env: {}, read: file({}), log });
    expect(effective(defaults.value[key])).toEqual(standard);
    // Exercise the real cascade validator, including leaves of map settings.
    const invalid = typeof standard === 'object'
      ? Object.fromEntries((key === 'stateLanes' ? ['fixing'] : Object.keys(standard)).map(leaf => [leaf, 'invalid-setting-value']))
      : 'invalid-setting-value';
    const result = resolveStallSweepSettings({ env: {}, read: file({ [key]: invalid }), log });
    expect(effective(result.value[key])).toEqual(key === 'maxRedTeamRestartsPerHead' ? 0 : standard);
    expect(result.errors.join(' ')).toContain(key);
  });
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
  it.each(['repo read', 'platform read', 'env mode', 'repo mode', 'platform mode', 'repo block', 'platform block'])
    ('an unreadable-settings pass leaves stalled items and suppression open: %s', async failure => {
      const dir = auditDir(), path = join(dir, '..', 'needs-you-events.jsonl');
      const item = { lane: 'operator', repo: REPO, pr: 1, head: HEAD, state: 'needs-decision:note' };
      const notify = vi.fn(() => ({ ok: true }));
      const options = { feedPath: path, stateDir: dir, env: {}, now: NOW, notify };
      publishStalledDigest({ items: [item] }, options);
      const files = [path, sidecarsOf(path).state, join(dir, 'digest-state.json')];
      const before = files.map(file => readFileSync(file, 'utf8'));
      const settings = resolveStallSweepSettings({
        env: { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'prefs.json'), ...(failure === 'env mode' ? { WE_PR_STALL_SWEEP_MODE: 'typo' } : {}) },
        read: file => {
          const layer = String(file).endsWith('pr-stall-sweep.json') ? 'repo' : 'platform';
          if (failure === `${layer} read`) throw new Error('settings temporarily unreadable');
          return JSON.stringify({ prStallSweep: failure === `${layer} block` ? false
            : { mode: failure === `${layer} mode` ? {} : 'shadow', digest: false } });
        }, log: () => {},
      });
      expect(settings.value.mode).toBe('off');
      const report = await runPrSweep({ ...base, notify,
        stallSweep: args => runStallSweep({ ...args, dir, settings,
          read: () => { throw new Error('unreadable settings must prevent a PR read'); } }),
        stallDigest: (pass, opts) => publishStalledDigest(pass, { ...opts, feedPath: path }) });
      expect(report.errors.length).toBeGreaterThan(0);
      expect(unacknowledged({ path })).toMatchObject([{ kind: 'stalled', pr: 1 }]);
      expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
      expect(settings.settingsUnreadable).toBe(true);
      // Recovery on the same head neither republishes nor repeats the delivered alert.
      const recovered = publishStalledDigest({ items: [item] }, options);
      expect(recovered.lines).toEqual([]);
      expect(notify).toHaveBeenCalledOnce();
    });
  it('a queue poll keeps stalled suppression when the producer settings fail closed', async () => {
    const dir = auditDir(), path = join(dir, '..', 'needs-you-events.jsonl');
    publishStalledDigest({ items: [{ lane: 'operator', repo: REPO, pr: 1, head: HEAD, state: 'needs-decision:note' }] },
      { feedPath: path, stateDir: dir, env: {}, now: NOW, notify: () => ({ ok: true }) });
    const result = await runOnce({ now: NOW, env: { WE_PR_STALL_SWEEP_MODE: 'typo' }, liveGate: false, log: () => {},
      settings: { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: path }, allowPrimary: { value: true } },
      exec: () => JSON.stringify({ ready: [{ repo: REPO, number: 1, head: HEAD }] }) });
    expect(result.lines).toEqual([]);
    expect(JSON.parse(readFileSync(sidecarsOf(path).state, 'utf8')).openKeys).toEqual([`${REPO}#1@${HEAD}:stalled`]);
    expect(unacknowledged({ path })).toMatchObject([{ kind: 'stalled', pr: 1 }]);
  });
  it.each([
    { mode: 'off', digest: true },
    { mode: 'shadow', digest: false },
  ])('a disabled producer clears published stalls and releases keys before its next due pass: %j', async config => {
    const dir = auditDir(), path = join(dir, '..', 'needs-you-events.jsonl');
    const key = `${REPO}#1@${HEAD}:stalled`;
    publishStalledDigest({ items: [{ lane: 'operator', repo: REPO, pr: 1, head: HEAD, state: 'needs-decision:note' }] },
      { feedPath: path, stateDir: dir, env: {}, notify: () => ({ ok: true }) });
    expect(JSON.parse(readFileSync(sidecarsOf(path).state, 'utf8')).openKeys).toEqual([key]);
    expect(unacknowledged({ path })).toHaveLength(1);
    const report = await runPrSweep({ ...base,
      stallSweep: args => runStallSweep({ ...args, dir, settings: shadow(config), state: { lastRunAt: NOW },
        read: () => { throw new Error('disabled/not-due sweep must not read'); } }),
      stallDigest: (pass, options) => publishStalledDigest(pass, { ...options, feedPath: path }) });
    expect(report.errors).toEqual([]);
    expect(JSON.parse(readFileSync(sidecarsOf(path).state, 'utf8')).openKeys).toEqual([]);
    expect(unacknowledged({ path })).toEqual([]);
    expect(replay({ path }).at(-1)).toMatchObject({ kind: 'cleared', was: 'stalled', pr: 1 });
  });
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
  it('a pass with items publishes the operator digest; a skipped pass does not', async () => {
    const stallDigest = vi.fn(() => ({ lines: ['x'], fresh: [1], notified: true, errors: [] }));
    const report = await runPrSweep({ ...base, stallDigest, stallSweep: async () => ({ mode: 'shadow', state: {}, items: [], act: [], dir: '/tmp/pr-stall-sweep', digest: true }) });
    expect(stallDigest).toHaveBeenCalledOnce(); expect(report.stallSweep.digest).toEqual({ published: 1, alerted: 1, notified: true });
    expect(stallDigest.mock.calls[0][1]).toMatchObject({ stateDir: '/tmp/pr-stall-sweep', enabled: true });
    const skipped = vi.fn();
    await runPrSweep({ ...base, stallDigest: skipped, stallSweep: async () => ({ mode: 'shadow', skipped: 'not-due', state: {} }) });
    expect(skipped).not.toHaveBeenCalled();
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

describe('stand-down routing default', () => {
  it('the repo file sends a stood-down fixer to the operator digest (auto would route it to the tooling check)', () => {
    const s = resolveStallSweepSettings({ env: {}, log: () => {} });
    expect(s.value.stateLanes).toMatchObject({ 'system:fix-stood-down': 'operator' });
  });
});


describe('pending red-team watchdog in the shadow sweep', () => {
  const prHead = `${REPO}#11@${HEAD}`;
  const pendingPr = (patch = {}) => ({ ...PRS[0], labels: [{ name: 'red-team:pending' }], ...patch });
  const owner = { host: 'watchdog-host', pidNamespace: 'watchdog-ns', pid: 12345, pidStart: 'owner-start' };
  const statusFor = (patch = {}) => ({ repo: REPO, pr: 11, head: HEAD, ...owner, startedAt: new Date(NOW - 120 * 60_000).toISOString(), status: 'running', ...patch });
  const restartRecord = (minutesAgo, patch = {}) => ({ ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
    phase: 'would-do', lane: 'system', action: 'restart-red-team', prHead,
    key: `${prHead}:red-team-pending:restart-1`, ...patch });
  const seed = (dir, records) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  const sweep = async ({ prs = [pendingPr()], status = null, alive = false, dir = auditDir(), ...options } = {}) => {
    const { gh, calls } = fakeGh({ prs });
    const log = vi.fn();
    const readRedTeamStatus = vi.fn(() => status);
    const probe = { host: owner.host, namespace: owner.pidNamespace, isAlive: vi.fn(() => alive),
      readPidStart: vi.fn(() => owner.pidStart) };
    const out = await runStallSweep({ now: NOW, env: {}, settings: shadow({ maxActionsPerPrHead: 3 }), gh, read: reader(gh),
      dir, log, readRedTeamStatus, probe, ...options,
      // Advance the assessment clock together with the sweep clock on repeated passes.
      read: options.read ?? (input => ({ ...reader(gh)(input), now: options.now ?? NOW })) });
    return { out, dir, calls, log, readRedTeamStatus, probe };
  };

  it.each([0, 1, 2])('sweep uses configured restart cap %s and escalates at the ceiling', async cap => {
    const dir = auditDir();
    if (cap) seed(dir, Array.from({ length: cap }, (_, n) => restartRecord(120 + n * 60,
      { key: `${prHead}:red-team-pending:restart-${n + 1}` })));
    const { out } = await sweep({ dir, settings: shadow({ maxRedTeamRestartsPerHead: cap }) });
    expect(out.act).toEqual([]);
    expect(out.items).toMatchObject([{ lane: 'operator', action: 'red-team-restart-exhausted', command: expect.any(String) }]);
    expect(out.items[0].reason).toMatch(cap === 0 ? /disabled.*maxRedTeamRestartsPerHead=0.*operator/ : /exhausted.*operator/);
  });
  it.each(['would-do', 'intent'])('R452: a prior ordinary action at the shared ceiling does not hold the restart (prior %s)', async phase => {
    const dir = auditDir();
    seed(dir, [restartRecord(120, { phase, action: 'ask-review-daemon', key: `${prHead}:daemon` })]);
    const { out, calls } = await sweep({ dir, settings: shadow({ maxActionsPerPrHead: 1 }) });
    expect(out.incomplete).toBe(false);
    expect(out.held).toEqual([]);
    expect(out.act).toMatchObject([{ action: 'restart-red-team' }]);
    expect(lines(dir).filter(r => r.phase === 'would-do' && r.action === 'restart-red-team')).toHaveLength(1);
    expectReadOnly(calls);
  });
  it('pending over 60 minutes with no live run or result logs would restart-red-team in shadow', async () => {
    const { out, dir, calls, log, readRedTeamStatus } = await sweep();
    expect(out.act).toMatchObject([{ lane: 'system', action: 'restart-red-team', prHead,
      key: `${prHead}:red-team-pending:restart-1` }]);
    expect(readRedTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, pr: 11, head: HEAD }));
    expect(log.mock.calls.map(([line]) => line).join('\n'))
      .toContain(`pr-stall-sweep (shadow) would restart-red-team ${prHead} [system]:`);
    expect(lines(dir).filter(r => r.phase === 'would-do')).toMatchObject([{ action: 'restart-red-team', mode: 'shadow' }]);
    expectReadOnly(calls);
  });
  it('a red-team-pending row with a liveJob yields no watchdog action even at 300 minutes', async () => {
    const pendingAt = new Date(NOW - 300 * 60_000).toISOString();
    const prs = [pendingPr({ updatedAt: pendingAt, createdAt: pendingAt })];
    const { gh } = fakeGh({ prs });
    const read = vi.fn(input => ({ ...reader(gh)(input),
      liveJobs: [{ repo: REPO, pr: 11, kind: 'red-team' }] }));
    const { out, readRedTeamStatus, probe } = await sweep({ prs, read });
    expect(read).toHaveBeenCalledOnce();
    expect(assessPrSweep(read.mock.results[0].value).prs).toMatchObject([
      { waitingOn: 'red-team-pending', ageMinutes: 300, liveJob: 'red-team', stalled: false },
    ]);
    expect(out.incomplete).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
    expect(readRedTeamStatus).not.toHaveBeenCalled();
    expect(probe.isAlive).not.toHaveBeenCalled();
  });
  it.each(['queued', 'running'])('a live %s owner is probed and never restarted even after 120 minutes', async status => {
    const { out, probe } = await sweep({ status: statusFor({ status }), alive: true });
    expect(probe.isAlive).toHaveBeenCalledWith(owner.pid);
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('an owner on another host waits before the stale deadline and escalates after it', async () => {
    const ninetyMinutesAgo = new Date(NOW - 90 * 60_000).toISOString();
    const status = statusFor({ host: 'another-host', startedAt: ninetyMinutesAgo });
    const young = await sweep({ status, prs: [pendingPr({ updatedAt: ninetyMinutesAgo, createdAt: ninetyMinutesAgo })] });
    expect(young.out.items).toEqual([]);
    expect(young.out.act).toEqual([]);
    expect(young.probe.isAlive).not.toHaveBeenCalled();
    const stale = await sweep({ status, now: NOW + 30 * 60_000 });
    expect(stale.out.act).toEqual([]);
    expect(stale.out.items).toMatchObject([{ lane: 'operator', action: 'red-team-owner-unknown',
      reason: expect.stringMatching(/run age.*120.*ownership could not be proven.*needs-you/) }]);
    expect(stale.probe.isAlive).not.toHaveBeenCalled();
  });
  it.each([undefined, 'unreadable', new Date(NOW + 1).toISOString()])('sweep escalates unknown-owner run timestamp %j at pending deadline without restarting', startedAt => {
    const at = new Date(NOW - 120 * 60_000).toISOString();
    return sweep({ status: statusFor({ host: 'remote', startedAt }),
      prs: [pendingPr({ updatedAt: at, createdAt: at })] }).then(({ out }) => {
      expect(out.incomplete).toBe(false);
      expect(out.act).toEqual([]);
      expect(out.records.filter(r => r.phase === 'operator')).toMatchObject([
        { lane: 'operator', action: 'red-team-owner-unknown', reason: expect.stringMatching(/pending age.*120.*needs-you/) },
      ]);
    });
  });
  it('a finished real result with its label still pending is published instead of restarted', async () => {
    const { out, calls, log } = await sweep({ status: statusFor({ status: 'finished', result: { status: 'ran', findings: [] } }) });
    expect(out.act).toMatchObject([{ lane: 'system', action: 'publish-red-team-result', prHead }]);
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain(`would publish-red-team-result ${prHead}`);
    expectReadOnly(calls);
  });
  it('finished without a ran result restarts rather than publishing', async () => {
    const { out } = await sweep({ status: statusFor({ status: 'finished', result: { status: 'failed' } }) });
    expect(out.act).toMatchObject([{ action: 'restart-red-team' }]);
  });
  it('a status read error fails closed with no action or daemon fallback', async () => {
    const readRedTeamStatus = vi.fn(() => { throw new Error('status unreadable'); });
    const { out, dir } = await sweep({ readRedTeamStatus });
    expect(readRedTeamStatus).toHaveBeenCalledOnce();
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
    expect(lines(dir).filter(r => r.phase === 'would-do')).toEqual([]);
  });
  it('an explicitly unreadable status also waits', async () => {
    const { out } = await sweep({ status: { unreadable: true } });
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('a young pending head does nothing', async () => {
    const young = new Date(NOW - 59 * 60_000).toISOString();
    const { out } = await sweep({ prs: [pendingPr({ updatedAt: young, createdAt: young })] });
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('spaces restart attempts using the latest same-head would-do or intent audit record', async () => {
    for (const phase of ['would-do', 'intent']) {
      const dir = auditDir();
      seed(dir, [restartRecord(90, { action: 'ask-review-daemon', key: `${prHead}:daemon` }), restartRecord(30, { phase })]);
      const { out } = await sweep({ dir });
      expect(out.items).toEqual([]);
      expect(out.act).toEqual([]);
    }
  });
  it('allows exactly two spaced restarts then emits an exhausted operator item on the same head', async () => {
    const dir = auditDir();
    const first = await sweep({ dir });
    expect(first.out.act).toMatchObject([{ action: 'restart-red-team', key: `${prHead}:red-team-pending:restart-1` }]);
    const tooSoon = await sweep({ dir, now: NOW + 59 * 60_000 });
    expect(tooSoon.out.items).toEqual([]);
    const second = await sweep({ dir, now: NOW + 60 * 60_000 });
    expect(second.out.act).toMatchObject([{ action: 'restart-red-team', key: `${prHead}:red-team-pending:restart-2` }]);
    const exhausted = await sweep({ dir, now: NOW + 120 * 60_000 });
    expect(exhausted.out.act).toEqual([]);
    expect(exhausted.out.items).toMatchObject([{ lane: 'operator', action: 'red-team-restart-exhausted' }]);
    expect(exhausted.out.items[0].reason).toMatch(/2/);
    expect(exhausted.out.items[0].reason).toMatch(/300/);
    expect(lines(dir).filter(r => r.phase === 'would-do' && r.action === 'restart-red-team')).toHaveLength(2);
    expect(lines(dir).filter(r => r.phase === 'operator')).toMatchObject([{ action: 'red-team-restart-exhausted' }]);
  });
  it.each(['would-do', 'intent'])('counts two prior %s restarts as exhausted and gives the operator age evidence', async phase => {
    const dir = auditDir();
    seed(dir, [restartRecord(150, { phase }), restartRecord(70, { phase, key: `${prHead}:red-team-pending:restart-2` })]);
    const { out } = await sweep({ dir });
    expect(out.act).toEqual([]);
    expect(out.items).toMatchObject([{ lane: 'operator', action: 'red-team-restart-exhausted' }]);
    expect(out.items[0].reason).toMatch(/2/);
    expect(out.items[0].reason).toMatch(/180/);
  });
  it('ignores other heads, actions and non-spending audit phases when deriving restart count and spacing', async () => {
    const dir = auditDir();
    const otherHead = `${REPO}#11@${'b'.repeat(40)}`;
    seed(dir, [restartRecord(90), restartRecord(5, { prHead: otherHead, key: `${otherHead}:restart-1` }),
      restartRecord(5, { action: 'ask-review-daemon', key: `${prHead}:daemon` }),
      restartRecord(5, { phase: 'would-skip', key: 'held' }), restartRecord(5, { phase: 'operator', key: 'operator' })]);
    const { out } = await sweep({ dir });
    expect(out.items).toMatchObject([{ action: 'restart-red-team', key: `${prHead}:red-team-pending:restart-2` }]);
    expect(out.act).toEqual(out.items);
    expect(out.held).toEqual([]);
  });
  it.each(['restart-red-team', 'publish-red-team-result'])('disabling %s yields an operator item in the sweep', async action => {
    const { out } = await sweep({ settings: shadow({ systemActions: { ...STALL_SWEEP_DEFAULTS.systemActions, [action]: false } }),
      status: action === 'publish-red-team-result' ? statusFor({ status: 'finished', result: { status: 'ran' } }) : null });
    expect(out.act).toEqual([]);
    expect(out.items).toMatchObject([{ lane: 'operator', action }]);
  });
  it('mode off reads no red-team evidence, probes no owners, and writes no audit', async () => {
    const { out, dir, calls, readRedTeamStatus, probe } = await sweep({ settings: shadow({ mode: 'off' }) });
    expect(out.skipped).toBe('off');
    expect(readRedTeamStatus).not.toHaveBeenCalled();
    expect(probe.isAlive).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(lines(dir)).toEqual([]);
  });
  it('a restart storm holds extra PRs under both sweep and hour caps', async () => {
    const prs = Array.from({ length: 8 }, (_, i) => pendingPr({ number: 11 + i }));
    const dir = auditDir();
    const first = await sweep({ prs, dir });
    expect(first.out.act).toHaveLength(3);
    expect(first.out.act.every(i => i.action === 'restart-red-team')).toBe(true);
    expect(first.out.held).toHaveLength(5);
    expect(first.out.held.every(i => i.held === 'per-sweep cap')).toBe(true);
    const second = await sweep({ prs, dir, now: NOW + 15 * 60_000 });
    expect(second.out.act).toHaveLength(3);
    const third = await sweep({ prs, dir, now: NOW + 30 * 60_000 });
    expect(third.out.act).toEqual([]);
    expect(third.out.held).toHaveLength(2);
    expect(third.out.held.every(i => i.held === 'per-hour cap')).toBe(true);
    expect(lines(dir).filter(r => r.phase === 'would-do')).toHaveLength(6);
  });
  it('a proven-dead local owner restarts before the unknown-owner stale deadline', async () => {
    const at = new Date(NOW - 90 * 60_000).toISOString();
    const { out, probe } = await sweep({ status: statusFor(), alive: false,
      prs: [pendingPr({ updatedAt: at, createdAt: at })] });
    expect(probe.isAlive).toHaveBeenCalledWith(owner.pid);
    expect(out.incomplete).toBe(false);
    expect(out.act).toMatchObject([{ action: 'restart-red-team' }]);
  });
  it('a PID in another namespace is unknown and waits before the stale deadline', async () => {
    const at = new Date(NOW - 90 * 60_000).toISOString();
    const { out, probe } = await sweep({ status: statusFor({ pidNamespace: 'other-ns', startedAt: at }),
      prs: [pendingPr({ updatedAt: at, createdAt: at })] });
    expect(probe.isAlive).not.toHaveBeenCalled();
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('uses the newest restart timestamp even when audit lines are out of chronological order', async () => {
    const dir = auditDir();
    seed(dir, [restartRecord(30), restartRecord(90, { action: 'ask-review-daemon', key: `${prHead}:daemon` })]);
    const { out } = await sweep({ dir });
    expect(out.incomplete).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
});

describe('watchdog restart budgets', () => {
  const limits = { maxActionsPerSweep: 10, maxActionsPerHour: 20, maxActionsPerPrHead: 3, maxRedTeamRestartsPerHead: 2 };
  const prHead = `${REPO}#11@${HEAD}`;
  const restart = n => ({ lane: 'system', action: 'restart-red-team', prHead, key: `${prHead}:restart-${n}` });
  const record = (item, phase = 'would-do') => ({ ...item, phase, ts: new Date(NOW - 90 * 60_000).toISOString() });
  it.each([0, 1, 2])('configured cap %s admits exactly that many restarts per head', cap => {
    const result = planStallActions([restart(1), restart(2), restart(3)], {
      now: NOW, limits: { ...limits, maxRedTeamRestartsPerHead: cap },
    });
    expect(result.act).toEqual([restart(1), restart(2)].slice(0, cap));
    expect(result.held).toEqual([restart(1), restart(2), restart(3)].slice(cap)
      .map(it => ({ ...it, held: expect.stringMatching(/restart per-head cap.*operator/) })));
  });
  it('a prior daemon nudge still permits the bounded restart allowance', () => {
    const history = [record({ prHead, action: 'ask-review-daemon', key: 'daemon' })];
    expect(planStallActions([restart(1)], { now: NOW, limits, history })).toEqual({ act: [restart(1)], held: [] });
  });
  it.each(['would-do', 'intent'])('R452: a second restart is not held by the shared one-action head cap after a prior %s', phase => {
    expect(planStallActions([restart(2)], { now: NOW, limits: { ...limits, maxActionsPerPrHead: 1 },
      history: [record(restart(1), phase)] })).toEqual({ act: [restart(2)], held: [] });
  });
  it('caps its own action bucket at two including actions planned in this pass', () => {
    const result = planStallActions([restart(1), restart(2), restart(3)], { now: NOW, limits });
    expect(result.act).toEqual([restart(1), restart(2)]);
    expect(result.held).toHaveLength(1);
    expect(result.held[0].key).toBe(restart(3).key);
  });
  it('the two-restart head cap is lifetime, including old months', () => {
    const history = [1, 2].map(n => ({ ...record(restart(n)), ts: '2026-01-01T00:00:00Z' }));
    const result = planStallActions([restart(3)], { now: NOW, limits, history });
    expect(result.act).toEqual([]);
    expect(result.held).toHaveLength(1);
  });
  it('restart items still spend the common per-sweep and per-hour budgets', () => {
    const items = [restart(1), { ...restart(1), prHead: 'other-head', key: 'other-restart' }];
    const perSweep = planStallActions(items, { now: NOW, limits: { ...limits, maxActionsPerSweep: 1 } });
    expect(perSweep.act).toHaveLength(1);
    expect(perSweep.held).toMatchObject([{ held: 'per-sweep cap' }]);
    const history = [{ ...record({ prHead: 'third-head', key: 'prior', action: 'tooling-card' }), ts: new Date(NOW - 60_000).toISOString() }];
    const perHour = planStallActions(items, { now: NOW, limits: { ...limits, maxActionsPerHour: 2 }, history });
    expect(perHour.act).toHaveLength(1);
    expect(perHour.held).toMatchObject([{ held: 'per-hour cap' }]);
  });
  it('different PR heads receive separate restart buckets', () => {
    const other = { ...restart(1), prHead: `${REPO}#12@${HEAD}`, key: 'other' };
    expect(planStallActions([other], { now: NOW, limits, history: [record(restart(1)), record(restart(2))] }).act).toEqual([other]);
  });
  it('publication uses only the ordinary ceiling and remains idempotent', () => {
    const publish = { ...restart(1), action: 'publish-red-team-result', key: `${prHead}:publish` };
    expect(planStallActions([publish], { now: NOW, limits,
      history: [record(restart(1)), record(restart(2))] })).toEqual({ act: [publish], held: [] });
    expect(planStallActions([publish], { now: NOW, limits, history: [record(publish)] })).toEqual({ act: [], held: [] });
    expect(planStallActions([publish], { now: NOW, limits: { ...limits, maxActionsPerPrHead: 1 },
      history: [record({ prHead, action: 'ask-review-daemon', key: 'nudge' }), record(restart(1)), record(restart(2))] }))
      .toEqual({ act: [], held: [{ ...publish, held: 'per-PR-head cap' }] });
  });
});

describe('watchdog action settings defaults and provenance', () => {
  it.each(['publish-red-team-result', 'restart-red-team'])('%s is enabled in both standard and persisted repo settings', action => {
    expect(STALL_SWEEP_DEFAULTS.systemActions[action]).toBe(true);
    const repo = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/pr-stall-sweep.json'), 'utf8'));
    expect(repo.prStallSweep.systemActions[action]).toBe(true);
  });
  it.each(['publish-red-team-result', 'restart-red-team'])('a tool-layer %s switch resolves with provenance', action => {
    const log = vi.fn();
    const read = path => String(path).endsWith('pr-stall-sweep.json')
      ? JSON.stringify({ prStallSweep: { systemActions: { [action]: false } } }) : '{}';
    const result = resolveStallSweepSettings({ env: { WE_POLICY_CASCADE_LOG: '1' }, read, log });
    expect(result.value.systemActions[action]).toBe(false);
    expect(result.sources[`systemActions.${action}`]).toBe('tool');
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain(`systemActions.${action}=false (tool)`);
  });
});


describe('restart budget settings cascade', () => {
  const resolve = (tool = {}, platform = {}, env = {}) => {
    resetCascadeLogForTest();
    const log = vi.fn();
    const result = resolveStallSweepSettings({ env: { WE_POLICY_CASCADE_LOG: '1', ...env }, log,
      read: path => JSON.stringify({ prStallSweep: String(path).endsWith('pr-stall-sweep.json') ? tool : platform }) });
    return { ...result, logged: log.mock.calls.map(([line]) => line).join('\n') };
  };
  it('defaults to two in the standard, resolved settings and persisted repository settings', () => {
    expect(STALL_SWEEP_DEFAULTS.maxRedTeamRestartsPerHead).toBe(2);
    expect(JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/pr-stall-sweep.json'), 'utf8'))
      .prStallSweep.maxRedTeamRestartsPerHead).toBe(2);
    expect(resolve()).toMatchObject({ value: { maxRedTeamRestartsPerHead: 2 }, sources: { maxRedTeamRestartsPerHead: 'standard' },
      logged: expect.stringContaining('maxRedTeamRestartsPerHead=2 (standard)') });
  });
  it.each([0, 1, 2])('valid cap %s resolves and logs provenance at every override layer', cap => {
    const setting = { maxRedTeamRestartsPerHead: cap };
    for (const [result, source] of [[resolve({}, setting), 'platform'], [resolve(setting), 'tool'],
      [resolve({ maxRedTeamRestartsPerHead: 2 }, { maxRedTeamRestartsPerHead: 1 },
        { WE_PR_STALL_SWEEP_MAX_RED_TEAM_RESTARTS_PER_HEAD: String(cap) }), 'env']]) {
      expect(result.value.maxRedTeamRestartsPerHead).toBe(cap);
      expect(result.sources.maxRedTeamRestartsPerHead).toBe(source);
      expect(result.logged).toContain(`maxRedTeamRestartsPerHead=${cap} (${source})`);
    }
  });
  it.each(['off', -1, 3, 0.5, 9007199254740992, null, false, '1', {}, []])('invalid layer cap %j disables restarts with layer provenance', invalid => {
    const tool = resolve({ maxRedTeamRestartsPerHead: invalid }, { maxRedTeamRestartsPerHead: 2 });
    expect(tool.value.maxRedTeamRestartsPerHead).toBe(0);
    expect(tool.sources.maxRedTeamRestartsPerHead).toBe('tool');
    expect(tool.logged).toContain('maxRedTeamRestartsPerHead=0 (tool)');
    expect(tool.errors.join(' ')).toContain('maxRedTeamRestartsPerHead');
    const platform = resolve({}, { maxRedTeamRestartsPerHead: invalid });
    expect(platform.value.maxRedTeamRestartsPerHead).toBe(0);
    expect(platform.sources.maxRedTeamRestartsPerHead).toBe('platform');
    expect(platform.logged).toContain('maxRedTeamRestartsPerHead=0 (platform)');
    expect(platform.errors.join(' ')).toContain('maxRedTeamRestartsPerHead');
  });
  it.each(['off', '-1', '3', '0.5', 'NaN', 'Infinity', '', ' ', 'false', '9007199254740992'])('invalid env cap %j disables restarts with env provenance', raw => {
    const result = resolve({ maxRedTeamRestartsPerHead: 2 }, {}, { WE_PR_STALL_SWEEP_MAX_RED_TEAM_RESTARTS_PER_HEAD: raw });
    expect(result.value.maxRedTeamRestartsPerHead).toBe(0);
    expect(result.sources.maxRedTeamRestartsPerHead).toBe('env');
    expect(result.logged).toContain('maxRedTeamRestartsPerHead=0 (env)');
    expect(result.errors.join(' ')).toContain('maxRedTeamRestartsPerHead');
  });
});
