import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as smoke from '../daemon-rebuild/smoke.mjs';
import * as settings from '../settings-files.mjs';
import { checkDaemonEntriesBoot, DAEMON_ENTRIES_ENV } from '../daemon-boot-smoke.mjs';
import scenario from '../../conveyor/soak/breaks/rebuild-adopts-candidate-over-refused-control.mjs';
const dirs = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'smoke-audit-')); dirs.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); dirs.forEach(p => rmSync(p, { recursive: true, force: true })); dirs.length = 0; });
const row = (over = {}) => ({ name: 'daemon-entries-boot', ok: false, entries: [{ entry: 'fixture.mjs', ok: false, kind: 'import failed', errorClass: 'TypeError: fixture', rawError: 'TypeError: fixture' }], ...over });
const boot = (root, runChild) => checkDaemonEntriesBoot({ root, diagnosticsDir: join(root, 'diagnostics'), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs', WE_SMOKE_BOOT_SIGNAL_RETRIES: '0' }, runChild, log: { error() {} } });
it('audit 1: environment zero vetoes an enabled file without enabling a disabled file', () => {
  vi.spyOn(settings, 'readSettingsChecked').mockReturnValue({ value: { enabled: true }, taint: [], duplicates: [] });
  expect(smoke.resolveAdoptNotWorse({}).enabled).toBe(true);
  expect(smoke.resolveAdoptNotWorse({ WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' })).toEqual({ enabled: false, source: 'environment' });
});
it('audit 2: full stack tails and literal delimiters remain distinct producer evidence', async () => {
  const root = temp();
  const runChild = async (_cmd, args) => { const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 10000 }); if (r.status !== 0) throw new Error('fixture child failed'); return r.stdout; };
  for (const [a, b] of [['TypeError: fixture\nframe1\nframe2\ntailA', 'TypeError: fixture\nframe1\nframe2\ntailB'], ['TypeError: fixture | frame', 'TypeError: fixture\nframe']]) {
    const results = [];
    for (const stack of [a, b]) {
      writeFileSync(join(root, 'fixture.mjs'), `const e = new TypeError('fixture'); e.stack = ${JSON.stringify(stack)}; throw e;`);
      results.push({ name: 'daemon-entries-boot', ...await boot(root, runChild) });
    }
    expect(results[0].entries[0].rawError).toBe(a);
    expect(results[1].entries[0].rawError).toBe(b);
    expect(smoke.failsSameChecks([results[0]], [results[1]])).toBe(false);
  }
});
it('audit 3: null classes and malformed child reports cannot establish typed failure', async () => {
  for (const errorClass of [null, 'garbage', 'RangeError: different class', 'TypeError: fixture\nextra']) {
    const bad = row(); bad.entries[0].errorClass = errorClass;
    expect(smoke.failsSameChecks([bad], [bad])).toBe(false);
  }
  const incomplete = row(); incomplete.entries.push(null);
  expect(smoke.failsSameChecks([incomplete], [incomplete])).toBe(false);
  for (const report of [{ error: 'TypeError: fixture' }, { ok: false, error: 42 }, { ok: 'yes' }]) {
    const result = { name: 'daemon-entries-boot', ...await boot(temp(), async () => JSON.stringify(report)) };
    expect(result.ok).toBe(false);
    expect(smoke.failsSameChecks([result], [result])).toBe(false);
  }
});
it('audit 4: system IO errors cannot authorize adoption', () => {
  expect(smoke.failsSameChecks([row()], [row()])).toBe(true);
  for (const text of ['Error: EIO: i/o error, read', 'Error: ENOSPC: no space', 'Error: ECONNRESET']) {
    const bad = row(); Object.assign(bad.entries[0], { errorClass: text, rawError: text });
    expect(smoke.failsSameChecks([bad], [bad])).toBe(false);
  }
});
it('audit 5: skipped reused and budget evidence is refused on both sides', () => {
  for (const flag of ['skipped', 'reused', 'budgetInterrupted', 'budgetSkipped']) {
    expect(smoke.failsSameChecks([row({ [flag]: true })], [row()])).toBe(false);
    expect(smoke.failsSameChecks([row()], [row({ [flag]: true })])).toBe(false);
    const bad = row(); bad.entries[0][flag] = true;
    expect(smoke.failsSameChecks([bad], [bad])).toBe(false);
  }
});
it('audit 6: untyped executed harness failures retain hold backoff but cannot authorize adoption', () => {
  const failed = [{ name: 'tree-stays-clean', ok: false, detail: 'git status --porcelain failed: timed out after 1ms (process group killed)' }];
  expect(smoke.failsSameChecks(failed, failed)).toBe(false);
  expect(smoke.matchesHarnessHold?.(failed, failed)).toBe(true);
  expect(smoke.matchesHarnessHold?.(failed, [{ ...failed[0], budgetInterrupted: true }])).toBe(false);
  const unknown = [{ name: 'unknown', ok: false, detail: 'boom' }];
  expect(smoke.matchesHarnessHold?.(unknown, unknown)).toBe(false);
});
it('audit 8: removing implementation and comment cannot turn regression into expected failure', () => {
  expect(scenario.fixPresent(temp())).toBe(true);
});
