import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
import assert from 'node:assert/strict';
import { auditEvidenceFor, loadAuditEvidence, describeMissing } from '../overlay-audit-evidence.mjs';
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
test('rejects absent evidence and invalid SHA types, including a trailing newline', () => {
  for (const value of [sha, null, [sha], sha.slice(1), sha + '\n'])
    assert.equal(auditEvidenceFor(value, { auditRecords: [], waivers: [] }).ok, false);
  assert.match(describeMissing(sha), /no NOT WEAKENED canonical audit record and no waiver in ruled-weakened.jsonl/);
});
test('latest record per base decides; another weakened base blocks; waiver covers it', () => {
  const pass = { head: sha.toUpperCase(), base, verdict: 'NOT WEAKENED' };
  const weak = { head: sha, base, verdict: 'WEAKENED' };
  const check = (auditRecords, waivers = []) => auditEvidenceFor(sha, { auditRecords, waivers });
  assert.equal(check([pass, weak]).ok, false);
  assert.equal(check([weak, pass]).kind, 'audit');
  assert.equal(check([pass, { ...weak, base: 'c'.repeat(40) }]).ok, false);
  assert.equal(check([weak], [{ sha }]).kind, 'waiver');
  assert.equal(check([{ ...pass, head: [sha] }]).ok, false);
});
test('missing HOME and missing files never throw or supply evidence', () => {
  assert.deepEqual(loadAuditEvidence({ env: {} }), { auditRecords: [], waivers: [] });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('IO honours HOME, reads both shared ledgers and rejects corrupt evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-evidence-'));
  const dir = join(home, 'workspace/.operations/coordination');
  const env = { HOME: home };
  const waiver = { ref: 'lane/fix', sha, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' };
  try {
    assert.deepEqual(loadAuditEvidence({ env }), { auditRecords: [], waivers: [] });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ head: sha, base, verdict: 'NOT WEAKENED' }) + '\n');
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), JSON.stringify(waiver) + '\n');
    assert.equal(auditEvidenceFor(sha, loadAuditEvidence({ env })).kind, 'audit');
    writeFileSync(join(dir, 'audits.jsonl'), '{broken');
    assert.equal(auditEvidenceFor(sha, loadAuditEvidence({ env })).kind, 'waiver');
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), '{broken');
    assert.equal(auditEvidenceFor(sha, loadAuditEvidence({ env })).ok, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
