import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
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
  assert.equal(result.auditEvidence, 'off');
  assert.equal(result.auditEvidenceSource, 'env');
  assert.equal(overlaySafetySettings({ WE_OVERLAY_AUDIT_EVIDENCE: 'unknown' }, { readSettings: () => null }).auditEvidence, 'refuse');
});

test('gate accepts audit or waiver and logs explicit overrides; warn/off are explicit policies', () => {
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
    for (const mode of ['warn', 'off']) assert.equal(run({ env: { ...env, WE_OVERLAY_AUDIT_EVIDENCE: mode } }), true);
    const dir = join(home, 'workspace/.operations/coordination');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ head: sha, base: 'b'.repeat(40), verdict: 'NOT WEAKENED' }) + '\n');
    assert.equal(run({}), true);
    writeFileSync(join(dir, 'audits.jsonl'), '');
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), JSON.stringify({ ref: 'lane/fix', sha, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' }) + '\n');
    assert.equal(run({}), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a raced replacement restores the registered SHA and registration identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-restore-sha-'));
  const root = join(home, 'clone');
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: join(home, 'state'), WE_OVERLAY_AUDIT_EVIDENCE: 'off' };
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
