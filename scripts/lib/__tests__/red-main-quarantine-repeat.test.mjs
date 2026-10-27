// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSafetyNet, addEntries, validateQuarantineList } from '../red-main-quarantine.mjs';
import { runSafetyNet, resolveQuarantineSettings, readTouchedFiles } from '../red-main-quarantine-io.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../conveyor/health-smells-notify-list.mjs';
import smell from '../../conveyor/health-smells/red-main-quarantined-test.mjs';
const now = Date.parse('2026-10-27T12:00:00Z');
const file = 'scripts/lib/__tests__/example.test.mjs';
const failure = { complete: true, files: [file], tests: [{ file, name: 'fails' }] };
const rows = [1, 2].map((n) => ({ databaseId: n, headSha: String(n).repeat(40), status: 'completed', conclusion: 'failure', createdAt: `2026-10-27T10:0${n}:00Z`, updatedAt: `2026-10-27T10:1${n}:00Z`, jobFailures: { integration: failure } }));
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'repeat-quarantine-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const plan = (o = {}) => planSafetyNet({ status: 'red', firstRedSha: rows[0].headSha, failedJobs: ['integration'], jobFailures: { integration: failure }, repeatRuns: rows, latestRunId: 2, touchedFiles: () => [], now, ...o });
const proof = { kind: 'repeat-failed', runIds: [1, 2], shas: rows.map((r) => r.headSha), count: 2 };
describe('R157 repeat failure quarantine', () => {
  it('twice-fails-untouched adds with 24h expiry, owner card, audit event and live notice', () => {
    let list = { version: 1, entries: [] }; let events;
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: rows, failing: { runId: 2, jobs: ['integration'] } },
      touchedFiles: () => [], readJobs: () => ({ failed: [{ id: 10, name: 'integration' }], jobs: [] }), readLog: () => failure,
      readList: () => ({ ok: true, list }), write: ({ change }) => { const r = change(list); list = r.list; events = r.events; return r; }, log: () => {} });
    expect(out).toMatchObject({ applied: true, mode: 'quarantine', plan: { action: 'add' } });
    expect(list.entries[0]).toMatchObject({ test: file, proof, expiresAt: now + 86400000 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'card-owed', test: file, expiresAt: now + 86400000 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'quarantine-added', proof }));
    expect(smell.evaluate({ mainCiRuns: {} }, { now, quarantineSafetyNet: () => out })).toEqual([expect.objectContaining({ breach: true, subject: `quarantine:${file}` })]);
  });
  it('planner records distinct run proof', () => expect(plan()).toMatchObject({ action: 'add', entries: [{ test: file, proof }] }));
  it('once => none', () => expect(plan({ repeatRuns: [rows[1]] })).toMatchObject({ action: 'none', why: expect.any(String) }));
  it('duplicate run ids do not count twice', () => expect(plan({ repeatRuns: [rows[1], rows[1]] }).action).toBe('none'));
  it('touched file between runs => none', () => expect(plan({ touchedFiles: () => [file] }).action).toBe('none'));
  it('touchedFiles unknown => none', () => expect(plan({ touchedFiles: () => null }).action).toBe('none'));
  it('touchedFiles throws => none', () => expect(plan({ touchedFiles: () => { throw Error('unknown'); } }).action).toBe('none'));
  it('missing sha => none', () => expect(plan({ repeatRuns: [{ ...rows[0], headSha: null }, rows[1]] }).action).toBe('none'));
  it('different failed file => none', () => expect(plan({ repeatRuns: [{ ...rows[0], jobFailures: {} }, rows[1]] }).action).toBe('none'));
  it('latest failing run must be in evidence', () => expect(plan({ latestRunId: 9 }).action).toBe('none'));
  it('setting off falls back to requireProvenFlake behaviour', () => {
    expect(plan({ settings: { repeatFailureProof: false } }).action).toBe('none');
    expect(plan({ settings: { repeatFailureProof: false }, flakeProof: { integration: { kind: 'rerun-passed', runId: 3, attempt: 2 } } }).action).toBe('add');
  });
  it('configured count must be met', () => expect(plan({ settings: { repeatFailureCount: 3 } }).action).toBe('none'));
  it('validates repeat proof and refuses malformed persisted evidence', () => {
    const added = addEntries(null, { tests: [file], brokenSha: rows[0].headSha, actor: 'operator', owner: 'operator', reason: 'repeat', proof, now });
    expect(added.ok).toBe(true);
    for (const bad of [{ ...proof, count: 3 }, { ...proof, runIds: [1, 1] }, { ...proof, shas: [null, rows[1].headSha] }, { ...proof, kind: 'guess' }, { ...proof, runIds: [0, 2] }]) {
      expect(validateQuarantineList({ ...added.list, entries: [{ ...added.list.entries[0], proof: bad }] }).ok).toBe(false);
    }
  });
  it('notify-list contains the quarantine smell', () => expect(NOTIFY_EVEN_IN_SHADOW.has('red-main-quarantined-test')).toBe(true));
  it('bounded history refuses oversize evidence with an operator-visible why', () => {
    expect(plan({ repeatRuns: Array(101).fill(rows[0]) })).toMatchObject({ action: 'none', why: expect.stringMatching(/bound|limit|cap/) });
  });
});
describe('repeat settings cascade', () => {
  it.each([['repeatFailureProof', true, false, 'on', true, 'REPEAT_FAILURE_PROOF'], ['repeatFailureCount', 2, 3, '4', 4, 'REPEAT_FAILURE_COUNT']])('%s resolves standard, platform, tool and env with provenance', (key, standard, override, raw, value, suffix) => {
    const path = join(temp(), 'settings.json'); const base = { file: path, env: {}, platform: null };
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { [key]: standard }, sources: { [key]: 'standard' } });
    expect(resolveQuarantineSettings({ ...base, platform: { [key]: override } })).toMatchObject({ value: { [key]: override }, sources: { [key]: 'platform' } });
    writeFileSync(path, JSON.stringify({ redMainQuarantine: { [key]: override } }));
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { [key]: override }, sources: { [key]: 'tool' } });
    expect(resolveQuarantineSettings({ ...base, env: { [`WE_RED_MAIN_QUARANTINE_${suffix}`]: raw } })).toMatchObject({ value: { [key]: value }, sources: { [key]: 'env' } });
    const invalid = resolveQuarantineSettings({ ...base, env: { [`WE_RED_MAIN_QUARANTINE_${suffix}`]: 'garbage' } });
    expect(invalid.sources[key]).toBe('tool'); expect(invalid.invalid.join(' ')).toContain(key);
  });
});
describe('git touched-files seam', () => {
  it('uses bounded argv diff and refuses invalid sha or unreadable output', () => {
    const run = vi.fn((args) => args[0] === 'diff' ? `${file}\0` : '');
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toEqual([file]);
    expect(run).toHaveBeenCalledWith(['diff', '--name-only', '-z', rows[0].headSha, rows[1].headSha, '--'], expect.any(Object));
    expect(readTouchedFiles('--bad', rows[1].headSha, { run })).toBeNull(); expect(run).toHaveBeenCalledTimes(3);
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: () => { throw Error('timeout'); } })).toBeNull();
  });
  it('detects a file changed and reverted between endpoint trees', () => {
    const middle = 'a'.repeat(40);
    const run = vi.fn((args) => {
      if (args[0] === 'rev-list') return `${rows[1].headSha} ${middle}\n${middle} ${rows[0].headSha}\n`;
      if (args[0] === 'diff' && args[3] === rows[0].headSha && args[4] === rows[1].headSha) return '';
      return args[0] === 'diff' ? `${file}\0` : '';
    });
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toEqual([file]);
  });
  it('oversized commit history fails closed for operator repair', () => {
    const run = (args) => args[0] === 'rev-list' ? Array(101).fill(`${rows[1].headSha} ${rows[0].headSha}`).join('\n') : '';
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toBeNull();
  });
  it('non-ancestor commits and incomplete diff output fail closed', () => {
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: (args) => { if (args[0] === 'merge-base') throw Error('not ancestor'); return ''; } })).toBeNull();
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: () => 'unterminated' })).toBeNull();
  });

});
