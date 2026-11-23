// Vitest-only: the guarded-registration and add --check tests below need `vi` (spies, env stubs).
import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addOverlay, readOverlays } from '../lib/daemon-overlays.mjs';
import { replaceRegistration } from '../daemon-overlay.mjs';
const sha = 'a'.repeat(40);
test('replace refuses unaudited SHA without changing registrations, even with prototype marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-gate-'));
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'refuse' };
  const root = join(home, 'clone');
  try {
    addOverlay(root, { ref: 'lane/old' }, { env });
    const out = await replaceRegistration({ root, ref: 'lane/new', old: 'lane/old', expectedSha: sha, env,
      auditCheckedBy: 'prototype-load', deps: {
        contain: () => ({ ok: true, contained: true, oldTip: sha, newTip: sha }),
        check: () => ({ ok: true, clean: true, candSha: sha }), tip: () => sha,
      } });
    assert.equal(out.code, 3);
    assert.equal(out.refused, 'no-canonical-audit');
    assert.deepEqual(readOverlays(root, { env }).map(o => o.ref), ['lane/old']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

import { registrationAuditGate } from '../daemon-overlay.mjs';
import { overlaySafetySettings } from '../lib/daemon-load-overlay.mjs';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
test('settings default refuses, tool and environment overrides preserve provenance', () => {
  const readSettings = () => ({ overlaySafety: { auditEvidence: 'warn' } });
  assert.equal(overlaySafetySettings({}, { readSettings: () => null }).auditEvidence, 'refuse');
  assert.equal(overlaySafetySettings({}, { readSettings }).auditEvidenceSource, 'tool');
  const result = overlaySafetySettings({ WE_OVERLAY_AUDIT_EVIDENCE: 'off' }, { readSettings });
  assert.equal(result.auditEvidence, 'warn');
  assert.equal(result.auditEvidenceSource, 'tool');
  assert.equal(overlaySafetySettings({ WE_OVERLAY_AUDIT_EVIDENCE: 'unknown' }, { readSettings: () => null }).auditEvidence, 'refuse');
});

test('gate requires readable main coverage and a canonical audit or matching waiver, and logs overrides', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-gate-modes-'));
  const root = join(home, 'clone');
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'refuse' };
  const run = extra => registrationAuditGate({ root, ref: 'lane/fix', sha, by: 'operator', env, ...extra });
  try {
    for (const unauditedReason of ['', 'short', '         x']) assert.equal(run({ unauditedReason }), false);
    assert.equal(run({ unauditedReason: 'emergency approved' }), true);
    const eventFile = readdirSync(env.WE_DAEMON_OVERLAY_DIR).find(name => name.endsWith('.events.jsonl'));
    const event = JSON.parse(readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, eventFile), 'utf8').trim());
    assert.equal(event.kind, 'unaudited-override');
    assert.equal(event.sha, sha);
    assert.equal(event.reason, 'emergency approved');
    for (const mode of ['warn', 'off']) assert.equal(run({ env: { ...env, WE_OVERLAY_AUDIT_EVIDENCE: mode } }), false);
    const git = args => {
      const result = spawnSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    mkdirSync(root); git(['init', '-q']); git(['commit', '--allow-empty', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', base]);
    git(['commit', '--allow-empty', '-qm', 'head']);
    const tip = git(['rev-parse', 'HEAD']);
    const dir = join(home, 'workspace/.operations/coordination');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ head: tip, base, verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z', findings: [] }) + '\n');
    assert.equal(run({ sha: tip }), true);
    git(['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.equal(run({ sha: tip }), false);
    git(['update-ref', 'refs/remotes/origin/main', base]);
    writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ head: tip, base, verdict: 'WEAKENED', questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z', findings: ['accepted'] }) + '\n');
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), JSON.stringify({ ref: 'lane/fix', sha: tip, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' }) + '\n');
    assert.equal(run({ sha: tip }), true);
    const handoff = join(home, 'workspace/.operations/handoff');
    mkdirSync(handoff);
    const withdrawal = JSON.stringify({ ref: 'lane/fix', sha: tip, ruling: 'WITHDRAWN', at: '2026-11-11T00:00:00Z', reason: 'withdrawn\nby operator' });
    writeFileSync(join(handoff, 'waiver-requests.jsonl'), withdrawal + '\n');
    assert.equal(run({ sha: tip }), false);
    writeFileSync(join(handoff, 'waiver-requests.jsonl'), withdrawal.replace('\\n', '\n') + '\n');
    assert.equal(run({ sha: tip }), false, 'damaged withdrawal must not reinstate the older waiver');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a raced replacement restores the registered SHA and registration identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-restore-sha-'));
  const root = join(home, 'clone');
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'off' };
  const prefs = join(home, 'prefs.json');
  writeFileSync(prefs, JSON.stringify({ overlaySafety: { auditEvidence: 'off' } }));
  env.WE_PLATFORM_PREFERENCES_FILE = prefs;
  const newSha = 'b'.repeat(40);
  try {
    addOverlay(root, { ref: 'lane/old', sha }, { env });
    const before = readOverlays(root, { env })[0];
    assert.equal(before.sha, sha);
    const out = await replaceRegistration({ root, ref: 'lane/new', old: 'lane/old', expectedSha: newSha, env,
      deps: { contain: () => ({ ok: true, contained: true, oldTip: sha, newTip: newSha }),
        check: () => ({ ok: true, clean: true, candSha: newSha }),
        tip: ref => ref === 'lane/new' ? newSha : 'c'.repeat(40) } });
    assert.equal(out.refused, 'replace-raced-restored');
    assert.deepEqual(readOverlays(root, { env }).find(entry => entry.ref === 'lane/old'), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('gate mode table: platform prefs file sets refuse/warn/off, env only tightens, with no evidence', () => {
  // WE_PLATFORM_PREFERENCES_FILE is the policy-cascade's sanctioned platform-layer seam (tests, one-off live
  // proofs). Pinned on purpose: a prefs file CAN set warn/off; the environment variable alone cannot.
  const home = mkdtempSync(join(tmpdir(), 'overlay-gate-table-'));
  const root = join(home, 'clone');
  const { WE_OVERLAY_AUDIT_EVIDENCE: _inherited, ...baseEnv } = process.env;
  void _inherited;
  const prefsFor = (mode) => {
    const file = join(home, `prefs-${mode}.json`);
    writeFileSync(file, JSON.stringify({ overlaySafety: { auditEvidence: mode } }));
    return file;
  };
  const gate = env => registrationAuditGate({ root, ref: 'lane/fix', sha, by: 'operator', readOnly: true,
    env: { ...baseEnv, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), ...env } });
  try {
    const rows = [
      { prefs: 'refuse', expected: false },
      { prefs: 'warn', expected: true },
      { prefs: 'off', expected: true },
      { prefs: 'warn', env: 'refuse', expected: false },
      { prefs: 'off', env: 'refuse', expected: false },
      { prefs: 'off', env: 'warn', expected: true },
      { env: 'off', expected: false },
      { env: 'warn', expected: false },
    ];
    for (const row of rows) {
      const env = {};
      if (row.prefs) env.WE_PLATFORM_PREFERENCES_FILE = prefsFor(row.prefs);
      if (row.env) env.WE_OVERLAY_AUDIT_EVIDENCE = row.env;
      assert.equal(gate(env), row.expected, JSON.stringify(row));
    }
    assert.equal(readdirSync(home).includes('state'), false, 'readOnly gate writes nothing');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('explicit refuse cannot be loosened by environment warn/off', () => {
  for (const mode of ['warn', 'off']) {
    const result = overlaySafetySettings({ WE_OVERLAY_AUDIT_EVIDENCE: mode }, {
      readSettings: () => ({ overlaySafety: { auditEvidence: 'refuse' } }),
    });
    assert.equal(result.auditEvidence, 'refuse');
    assert.equal(result.auditEvidenceSource, 'tool');
  }
});
test('replace check refuses missing evidence without writing overrides or registrations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-preview-'));
  const root = join(home, 'clone');
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'refuse' };
  try {
    addOverlay(root, { ref: 'lane/old' }, { env });
    const before = readdirSync(env.WE_DAEMON_OVERLAY_DIR).map(name => [name, readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, name), 'utf8')]);
    const args = { root, ref: 'lane/new', old: 'lane/old', expectedSha: sha, env, checkOnly: true,
      deps: { contain: () => ({ ok: true, contained: true, oldTip: sha, newTip: sha }),
        check: () => ({ ok: true, clean: true, candSha: sha }) } };
    assert.equal((await replaceRegistration(args)).code, 3);
    assert.equal((await replaceRegistration({ ...args, unauditedReason: 'emergency approved' })).ok, true);
    assert.deepEqual(readdirSync(env.WE_DAEMON_OVERLAY_DIR).map(name => [name, readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, name), 'utf8')]), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

import { vi } from 'vitest';
import * as overlayCli from '../daemon-overlay.mjs';
import { guardedRegister } from '../lib/daemon-load-overlay.mjs';
test('manual guarded registration refuses missing audit before invoking register', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-manual-'));
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'refuse' };
  const check = vi.spyOn(overlayCli, 'stackAwareOverlayCheck').mockResolvedValue({ ok: true, clean: true, candSha: sha });
  const register = vi.fn();
  try {
    const result = await guardedRegister({ root: join(home, 'clone'), ref: 'lane/fix', env, gate: {}, register });
    assert.equal(result.registered, false);
    assert.equal(result.reason, 'no-canonical-audit');
    assert.equal(register.mock.calls.length, 0);
  } finally { check.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});
test('add check refuses missing audit and previews overrides without writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-add-preview-'));
  const priorExit = process.exitCode;
  const env = { HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'refuse', WE_DAEMON_OVERLAY_STACK_BASES: '{}' };
  const output = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
  vi.stubEnv('HOME', env.HOME); vi.stubEnv('WE_DAEMON_OVERLAY_DIR', env.WE_DAEMON_OVERLAY_DIR);
  vi.stubEnv('WE_OVERLAY_AUDIT_EVIDENCE', 'refuse'); vi.stubEnv('WE_DAEMON_OVERLAY_STACK_BASES', '{}');
  try {
    const args = ['add', `--clone=${join(home, 'clone')}`, '--ref=lane/fix', '--pr=12', '--check', '--json'];
    const deps = { pruneStaleOverlayRecords: () => {}, stackAwareOverlayCheck: async () => ({ ok: true, clean: true, candSha: sha }) };
    await overlayCli.main(args, deps);
    assert.equal(process.exitCode, 3);
    assert.equal(JSON.parse(output.pop()).wouldRegister, false);
    await overlayCli.main([...args, '--unaudited-reason=emergency approved'], deps);
    assert.equal(JSON.parse(output.pop()).wouldRegister, true);
    assert.deepEqual(readdirSync(home), []);
  } finally { stdout.mockRestore(); vi.unstubAllEnvs(); process.exitCode = priorExit; rmSync(home, { recursive: true, force: true }); }
});

import { spawnSync } from 'node:child_process';
import { QUESTION_HASH } from '../operations/codex-audit.mjs';
