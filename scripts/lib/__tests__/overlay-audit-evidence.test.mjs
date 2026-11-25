import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
import assert from 'node:assert/strict';
import { auditEvidenceFor, loadAuditEvidence, describeMissing } from '../overlay-audit-evidence.mjs';
import { QUESTION_HASH } from '../../operations/codex-audit.mjs';
import { loadRuledWeakened } from '../../operations/prototype-load-io.mjs';
import { readyEvidence, canonicalAuditEvidence } from '../../operations/prototype-load.mjs';
import { fileURLToPath } from 'node:url';
const ref = 'lane/fix';
const covers = () => true;
const valid = { questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z', findings: [] };
const waiver = { ref, sha: 'a'.repeat(40), ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' };
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
test('loads tool waivers from the running checkout in the DOM test environment, independent of the candidate cwd', () => {
  const toolPath = join(dirname(fileURLToPath(import.meta.url)), '../../settings/prototype-load.json');
  const reads = [];
  const entry = { ref, sha, ruling: 'R12', findings: ['accepted'] };
  const fs = { readFileSync(path) {
    reads.push(path);
    if (path === toolPath) return JSON.stringify({ ruledWeakened: [entry] });
    throw Object.assign(Error('missing fixture'), { code: 'ENOENT' });
  } };
  const result = loadAuditEvidence({ env: { HOME: '/fixture' }, cwd: '/candidate', fs });
  assert.ok(reads.includes(toolPath), 'reads settings from the running checkout');
  assert.deepEqual(result.waivers, [{ ...entry, layer: 'tool' }]);
});
test('tool and platform settings waivers survive prototype readiness and downstream admission', () => {
  const entry = { ref, sha: sha.toUpperCase(), ruling: 'R12', findings: ['accepted'] };
  const weak = { ...valid, head: sha, base, verdict: 'WEAKENED', findings: ['accepted'] };
  const ready = { ref, sha, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: ['accepted'] };
  for (const layer of ['tool', 'platform']) {
    const env = { HOME: '/fixture', WE_PLATFORM_PREFERENCES_FILE: '/fixture/prefs.json' };
    const files = new Map([
      ['/fixture/prefs.json', JSON.stringify({ prototypeLoad: { ruledWeakened: layer === 'platform' ? [entry] : [] } })],
      ['/fixture/workspace/.operations/coordination/audits.jsonl', JSON.stringify(weak) + '\n'],
    ]);
    let toolEntries = layer === 'tool' ? [entry] : [];
    const fs = { readFileSync(path) {
      if (String(path).endsWith('/scripts/settings/prototype-load.json')) return JSON.stringify({ ruledWeakened: toolEntries });
      if (files.has(path)) return files.get(path);
      throw Object.assign(Error('missing fixture'), { code: 'ENOENT' });
    } };
    const upstream = loadRuledWeakened({ [layer]: [entry], env, fs });
    const readiness = readyEvidence([ready], { branch: ref, sha }, upstream);
    assert.ok(readiness, `${layer}: upstream accepts readiness`);
    assert.equal(canonicalAuditEvidence([weak], sha, covers, null, { ruledWeakened: readiness }).ok, true);
    const check = () => auditEvidenceFor(sha, { ...loadAuditEvidence({ env, fs }), ref, covers });
    assert.equal(check().kind, 'waiver', `${layer}: downstream must preserve the supported ruling`);
    for (const patch of [{ ref: 'lane/other' }, { sha: base }, { ruling: 'bad' }, { findings: ['other'] }, { findings: [] }]) {
      const changed = { ...entry, ...patch };
      if (layer === 'tool') toolEntries = [changed];
      else files.set('/fixture/prefs.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [changed] } }));
      assert.equal(check().ok, false, `${layer}: invalid or mismatched waiver`);
    }
    if (layer === 'tool') toolEntries = [entry];
    else files.set('/fixture/prefs.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [entry] } }));
    const requests = '/fixture/workspace/.operations/handoff/waiver-requests.jsonl';
    for (const body of [JSON.stringify({ ref, sha, ruling: 'WITHDRAWN' }), '{broken']) {
      files.set(requests, body + '\n');
      assert.equal(check().ok, false, `${layer}: withdrawal or damaged log refuses admission`);
    }
    files.delete(requests);
    // A tool entry overrides the same platform/store key even when its findings do not match.
    files.set('/fixture/prefs.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [entry] } }));
    files.set('/fixture/workspace/.operations/coordination/ruled-weakened.jsonl', JSON.stringify(waiver) + '\n');
    toolEntries = [{ ...entry, findings: ['different'] }];
    assert.equal(check().ok, false, 'tool precedence must not fall back to a matching lower-layer waiver');
  }
});
test('rejects absent evidence and invalid SHA types, including a trailing newline', () => {
  for (const value of [sha, null, [sha], sha.slice(1), sha + '\n'])
    assert.equal(auditEvidenceFor(value, { auditRecords: [], waivers: [] }).ok, false);
  assert.match(describeMissing(sha), /no NOT WEAKENED canonical audit record and no waiver in ruled-weakened.jsonl/);
});
test('latest record per base decides; another weakened base blocks; waiver covers it', () => {
  const pass = { ...valid, head: sha.toUpperCase(), base, verdict: 'NOT WEAKENED' };
  const weak = { ...valid, findings: ['accepted'], head: sha, base, verdict: 'WEAKENED' };
  const check = (auditRecords, waivers = []) => auditEvidenceFor(sha, { auditRecords, waivers, ref, covers });
  assert.equal(check([pass, weak]).ok, false);
  assert.equal(check([weak, pass]).kind, 'audit');
  assert.equal(check([pass, { ...weak, base: 'c'.repeat(40) }]).ok, false);
  assert.equal(check([weak], [waiver]).kind, 'waiver');
  assert.equal(check([{ ...pass, head: [sha] }]).ok, false);
});
test('missing HOME and missing files never throw or supply evidence', () => {
  assert.deepEqual(loadAuditEvidence({ env: {} }), { auditRecords: [], waivers: [] });
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// Ledger-only fixtures must not inherit the checkout's real tool/platform waivers.
const loadLedgerEvidence = ({ env }) => loadAuditEvidence({ env, fs: { readFileSync(path, encoding) {
  if (!String(path).startsWith(env.HOME + '/')) throw Object.assign(Error('outside fixture'), { code: 'ENOENT' });
  return readFileSync(path, encoding);
} } });
test('IO honours HOME, reads both shared ledgers and rejects corrupt evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-evidence-'));
  const dir = join(home, 'workspace/.operations/coordination');
  const env = { HOME: home };
  const waiver = { ref: 'lane/fix', sha, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' };
  try {
    assert.deepEqual(loadLedgerEvidence({ env }), { auditRecords: [], waivers: [] });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'audits.jsonl'), JSON.stringify({ ...valid, head: sha, base, verdict: 'NOT WEAKENED' }) + '\n');
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), JSON.stringify(waiver) + '\n');
    assert.equal(auditEvidenceFor(sha, { ...loadLedgerEvidence({ env }), ref, covers }).kind, 'audit');
    writeFileSync(join(dir, 'audits.jsonl'), '{broken');
    assert.equal(auditEvidenceFor(sha, { ...loadLedgerEvidence({ env }), ref, covers }).ok, false);
    writeFileSync(join(dir, 'ruled-weakened.jsonl'), '{broken');
    assert.equal(auditEvidenceFor(sha, { ...loadLedgerEvidence({ env }), ref, covers }).ok, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('canonical acceptance rejects missing/foreign hashes, contradictions, bad/future times, empty diff and uncovered bases', () => {
  const pass = { ...valid, head: sha, base, verdict: 'NOT WEAKENED' };
  for (const patch of [{ questionHash: undefined }, { questionHash: 'foreign' }, { findings: ['WEAKENED'] },
    { at: 'bad' }, { at: '2999-01-01T00:00:00Z' }, { base: sha }]) {
    assert.equal(auditEvidenceFor(sha, { auditRecords: [{ ...pass, ...patch }], covers }).ok, false, JSON.stringify(patch));
  }
  assert.equal(auditEvidenceFor(sha, { auditRecords: [pass], covers: () => false }).ok, false);
  assert.equal(auditEvidenceFor(sha, { auditRecords: [pass], covers: () => { throw Error('unreadable'); } }).ok, false);
});
test('waivers require valid exact ref, SHA and findings and cannot substitute for an audit', () => {
  const weak = { ...valid, head: sha, base, verdict: 'WEAKENED', findings: ['accepted'] };
  const check = (entry, auditRecords = [weak]) => auditEvidenceFor(sha, { ref, covers, auditRecords, waivers: [entry] });
  for (const patch of [{ ref: 'lane/other' }, { sha: base }, { findings: ['other'] }, { actor: '' }, { ruling: 'bad' }])
    assert.equal(check({ ...waiver, ...patch }).ok, false);
  assert.equal(check(waiver, []).ok, false);
  assert.equal(check(waiver).kind, 'waiver');
  assert.equal(check(waiver, [{ ...weak, base: sha }]).ok, false);
});
test('withdrawals and unreadable revocation ledgers revoke stored waivers', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-revocation-'));
  const dir = join(home, 'workspace/.operations');
  const env = { HOME: home };
  try {
    mkdirSync(join(dir, 'coordination'), { recursive: true });
    mkdirSync(join(dir, 'handoff'));
    writeFileSync(join(dir, 'coordination/ruled-weakened.jsonl'), JSON.stringify(waiver) + '\n');
    assert.deepEqual(loadLedgerEvidence({ env }).waivers, [waiver]);
    const ledger = join(dir, 'handoff/waiver-requests.jsonl');
    writeFileSync(ledger, JSON.stringify({ ref, sha, ruling: 'WITHDRAWN' }) + '\n');
    assert.deepEqual(loadLedgerEvidence({ env }).waivers, []);
    const withdrawal = JSON.stringify({ ref, sha, ruling: 'WITHDRAWN', reason: 'withdrawn\nby operator' });
    for (const damaged of [withdrawal.replace('\\n', '\n'), withdrawal.replace('\\n', '\r'), '{broken']) {
      writeFileSync(ledger, damaged + '\n');
      assert.deepEqual(loadLedgerEvidence({ env }).waivers, [], 'damaged revocations cannot restore a waiver');
    }
    writeFileSync(join(dir, 'coordination/audits.jsonl'), JSON.stringify({ ...valid, head: sha, base, verdict: 'NOT WEAKENED' }) + '\n');
    assert.equal(auditEvidenceFor(sha, { ...loadLedgerEvidence({ env }), ref, covers }).kind, 'audit', 'withdrawal damage blocks waivers, while independent passing audits still qualify');
    for (const reason of ['line\rreturn', 'line\u2028separator', '`quoted` "text"', '--withdraw ../path', '\u200bhidden', 'safe' + ' parts']) {
      writeFileSync(ledger, JSON.stringify({ ref, sha, ruling: 'WITHDRAWN', reason }) + '\n');
      assert.deepEqual(loadLedgerEvidence({ env }).waivers, []);
    }
    rmSync(ledger); mkdirSync(ledger);
    assert.deepEqual(loadLedgerEvidence({ env }).waivers, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
