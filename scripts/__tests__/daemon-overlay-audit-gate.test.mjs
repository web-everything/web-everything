// @vitest-environment node
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const fixture = vi.hoisted(() => ({ sha: '', fileSafety: undefined, unreadableAudit: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, readFileSync(path, ...args) {
    if (String(path).endsWith('/daemon-rebuild-settings.json')) return JSON.stringify({ overlaySafety: fixture.fileSafety || {} });
    if (fixture.unreadableAudit && String(path).endsWith('/audits.jsonl')) throw Object.assign(Error('audit denied'), { code: 'EACCES' });
    return fs.readFileSync(path, ...args);
  } };
});
vi.mock('../lib/daemon-rebuild.mjs', async importOriginal => ({
  ...await importOriginal(), previewOverlayConflict: vi.fn(async () => ({ ok: true, clean: true, candSha: fixture.sha, files: [], conflicting: [] })),
}));
import { main, replaceRegistration } from '../daemon-overlay.mjs';
import { runDaemonLoadOverlay, overlaySafetySettings } from '../lib/daemon-load-overlay.mjs';
import { addOverlay, readOverlays, recordEdgeResolution } from '../lib/daemon-overlays.mjs';
import { directionFor, isLoosening } from '../lib/settings-safe-direction.mjs';
import { QUESTION_HASH } from '../operations/codex-audit.mjs';
let home, clone, base, stdout, stderr;
const ref = 'lane/audited';
beforeEach(() => {
  fixture.fileSafety = undefined;
  fixture.unreadableAudit = false;
  home = mkdtempSync(join(tmpdir(), 'overlay-audit-gate-'));
  clone = join(home, 'clone'); mkdirSync(clone);
  const git = args => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: clone, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['commit', '--allow-empty', '-qm', 'base']); base = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', base]);
  git(['commit', '--allow-empty', '-qm', 'candidate']); fixture.sha = git(['rev-parse', 'HEAD']);
  vi.stubEnv('HOME', home); vi.stubEnv('WE_DAEMON_OVERLAY_DIR', join(home, 'overlays'));
  vi.stubEnv('WE_DAEMON_OVERLAY_STACK_BASES', '{}'); vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', '');
  vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', join(home, 'preferences.json'));
  stdout = ''; stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(s => { stdout += s; return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(s => { stderr += s; return true; });
});
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const cli = async (args = []) => {
  await main(['add', `--clone=${clone}`, `--ref=${ref}`, '--pr=7490', '--json', ...args], { pruneStaleOverlayRecords: () => {} });
  return { code: process.exitCode || 0, data: JSON.parse(stdout), stderr };
};
const load = (options = {}) => runDaemonLoadOverlay({ clone, ref, pr: 7490, env: process.env, log: { error: () => {} }, ...options,
  versions: null, rebuild: async () => ({ moved: false, reason: 'up-to-date' }), installed: () => ({ inHead: true }) });
function evidence(verdict = 'NOT WEAKENED') {
  const dir = join(home, 'workspace/.operations/coordination'); mkdirSync(dir, { recursive: true });
  const findings = verdict === 'WEAKENED' ? ['accepted'] : [];
  writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ head: fixture.sha, base, verdict, findings, questionHash: QUESTION_HASH, at: new Date().toISOString() }) + '\n');
  if (verdict === 'WEAKENED') writeFileSync(join(dir, 'ruled-weakened.jsonl'), JSON.stringify({ ref, sha: fixture.sha,
    ruling: 'R12', findings, actor: 'operator', quote: 'approved', at: new Date().toISOString() }) + '\n');
}
it('add without evidence is refused by default in CLI and loader', async () => {
  expect(await cli([`--expected-sha=${fixture.sha}`])).toMatchObject({ code: 3, data: { conflictCheck: { reason: 'no-audit-evidence' } } });
  expect(stderr).toContain(fixture.sha); expect(stderr).toContain('no NOT WEAKENED canonical audit record');
  expect(await load()).toMatchObject({ registered: false, refused: true, reason: 'no-audit-evidence' });
  expect(readOverlays(clone)).toEqual([]);
});
it('canonical NOT WEAKENED admits the candidate in CLI and loader', async () => {
  evidence(); expect(await cli()).toMatchObject({ code: 0 });
  expect(await load()).toMatchObject({ registered: true });
});
it('valid waiver admits a WEAKENED candidate in CLI and loader', async () => {
  evidence('WEAKENED'); expect(await cli()).toMatchObject({ code: 0 });
  expect(await load()).toMatchObject({ registered: true });
});
it('environment warn cannot loosen default refusal', async () => {
  vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', 'warn');
  expect(overlaySafetySettings().auditEvidence).toBe('refuse');
  expect(await cli()).toMatchObject({ code: 3 });
});
it('environment refuse tightens file warn and enum direction is tightest first', async () => {
  fixture.fileSafety = { auditEvidence: 'warn' };
  expect(overlaySafetySettings().auditEvidence).toBe('warn');
  vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', 'refuse');
  expect(overlaySafetySettings().auditEvidence).toBe('refuse');
  expect(directionFor('overlaySafety', 'auditEvidence')).toEqual({ kind: 'safety', safe: 'enum:refuse,warn' });
  expect(isLoosening(directionFor('overlaySafety', 'auditEvidence'), 'refuse', 'warn')).toBe(true);
  expect(isLoosening(directionFor('overlaySafety', 'auditEvidence'), 'warn', 'refuse')).toBe(false);
  expect(await cli()).toMatchObject({ code: 3 });
});
it('--check reports wouldRegister false and no-audit-evidence without writing', async () => {
  expect(await cli(['--check'])).toMatchObject({ code: 3, data: { check: { reason: 'no-audit-evidence' }, wouldRegister: false } });
  expect(readOverlays(clone)).toEqual([]);
});
it('file warn logs missing evidence and proceeds, invalid file or env fails closed', async () => {
  fixture.fileSafety = { auditEvidence: 'warn' };
  expect(await cli()).toMatchObject({ code: 0 }); expect(stderr).toContain('WARNING');
  fixture.fileSafety.auditEvidence = 'off'; expect(overlaySafetySettings().auditEvidence).toBe('refuse');
  fixture.fileSafety.auditEvidence = 'warn'; vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', 'off');
  expect(overlaySafetySettings().auditEvidence).toBe('refuse');
});

it('--allow-no-pr does not bypass audit admission', async () => {
  vi.stubEnv('WE_OVERLAY_NO_PR', 'refuse');
  await main(['add', `--clone=${clone}`, `--ref=${ref}`, '--allow-no-pr', '--reason=operator requested', '--json'], { pruneStaleOverlayRecords: () => {} });
  expect(process.exitCode).toBe(3);
  expect(JSON.parse(stdout)).toMatchObject({ conflictCheck: { reason: 'no-audit-evidence' } });
  expect(readOverlays(clone)).toEqual([]);
});

it.each(['weakened', 'malformed', 'unreadable'])('file warn still refuses %s audit evidence in CLI and loader', async kind => {
  fixture.fileSafety = { auditEvidence: 'warn' };
  evidence();
  const ledger = join(home, 'workspace/.operations/coordination/audits.jsonl');
  if (kind === 'weakened') writeFileSync(ledger, JSON.stringify({ head: fixture.sha, base, verdict: 'WEAKENED', findings: ['unwaived'], questionHash: QUESTION_HASH, at: new Date().toISOString() }) + '\n');
  if (kind === 'malformed') writeFileSync(ledger, '{broken\n');
  if (kind === 'unreadable') fixture.unreadableAudit = true;
  expect(await cli()).toMatchObject({ code: 3 });
  expect(await load()).toMatchObject({ registered: false, reason: 'no-audit-evidence' });
  expect(readOverlays(clone)).toEqual([]);
});

it('environment refuse tightens injected loader warn settings', async () => {
  vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', 'refuse');
  expect(await load({ settings: { auditEvidence: 'warn' } })).toMatchObject({ registered: false, reason: 'no-audit-evidence' });
  expect(readOverlays(clone)).toEqual([]);
});

it.each([false, true])('replacement requires new SHA audit evidence before any mutation (check: %s)', async checkOnly => {
  const old = 'lane/old';
  addOverlay(clone, { ref: old });
  const result = await replaceRegistration({ root: clone, ref, old, expectedSha: fixture.sha, env: process.env, checkOnly,
    deps: { contain: () => ({ ok: true, contained: true, oldTip: base, newTip: fixture.sha }),
      check: async () => ({ ok: true, clean: true, candSha: fixture.sha }), tip: r => r === old ? base : fixture.sha } });
  expect(result).toMatchObject({ ok: false, refused: 'no-audit-evidence', code: 3 });
  expect(readOverlays(clone).map(o => o.ref)).toEqual([old]);
});

it('CLI and loader persist the audited candidate SHA, including re-registration', async () => {
  evidence();
  expect(await cli()).toMatchObject({ code: 0 });
  expect(readOverlays(clone)[0].auditedSha).toBe(fixture.sha);
  addOverlay(clone, { ref, auditedSha: base });
  expect(await load()).toMatchObject({ registered: true });
  expect(readOverlays(clone)[0].auditedSha).toBe(fixture.sha);
});

it('loader requires audit evidence for an existing registration edge SHA', async () => {
  evidence();
  addOverlay(clone, { ref });
  recordEdgeResolution(clone, ref, { sha: base, by: 'operator' });
  expect(await load()).toMatchObject({ registered: false, reason: 'no-audit-evidence' });
  expect(readOverlays(clone)[0].auditedSha).toBeUndefined();
});
