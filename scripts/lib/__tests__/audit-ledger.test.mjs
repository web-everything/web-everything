import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { evaluateAudit, evaluateAuditFile } from '../audit-ledger.mjs';
import { appendChained, appendGenesis, buildGenesis, sha256Line } from '../audit-ledger-chain.mjs';
import { genesisLine, resealLedger } from './audit-ledger-reseal-fixture.mjs';
import { QUESTION_HASH, findAudit } from '../../operations/codex-audit.mjs';
import { canonicalAuditEvidence, readyEvidence } from '../../operations/prototype-load.mjs';
import { appendEntry, readStore } from '../../operations/ruled-weakened-store.mjs';
import { backfillWaivers } from '../../operations/audit-ledger-waiver-backfill.mjs';
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40), FP = 'd'.repeat(64);
const NOW = Date.parse('2026-11-17T12:00:00Z');
const pass = extra => ({ head: HEAD, base: BASE, questionHash: QUESTION_HASH, fingerprint: FP,
  at: '2026-11-17T11:00:00Z', verdict: 'NOT WEAKENED', findings: [], ...extra });
const weak = extra => pass({ verdict: 'WEAKENED', findings: ['file:1 guard'], ...extra });
function ledger(records, legacy = '') {
  const lines = [JSON.stringify(buildGenesis(Buffer.from(legacy)))];
  records.forEach((r, i) => lines.push(JSON.stringify({ ...r, seq: i + 1, id: `id-${i + 1}`, prev: sha256Line(lines.at(-1)) })));
  return { text: legacy + lines.join('\n') + '\n', lines, hwm: { seq: records.length, lineHash: sha256Line(lines.at(-1)) } };
}
const options = { head: HEAD, liveFp: FP, now: NOW, priorQuestionHashes: [], covers: () => true };
// Rule 9: each side applies a waiver under its own rules, so the legacy side gets the same waiver as a ruled gate.
const legacyGate = w => ({ ruledWeakened: { ruling: 'R1047', findings: w.findings }, record: { sha: w.sha, fingerprint: w.fingerprint ?? FP } });
const withGate = extra => extra.waivers?.length && !extra.ruledWeakened ? { ...extra, ruledWeakened: legacyGate(extra.waivers[0]) } : extra;
const evaluate = (l, extra = {}) => evaluateAudit(l.text, { ...options, hwm: l.hwm, ...withGate(extra) });
let root, path;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'audit-evaluator-')); path = join(root, 'audits.jsonl'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const save = l => { fs.writeFileSync(path, l.text); fs.writeFileSync(join(root, 'audits.hwm.json'), JSON.stringify(l.hwm)); };
describe('R1047 attack table', () => {
  it.each([[weak(), pass({ at: '2099-01-01T00:00:00Z' })], [pass({ at: '2099-01-01T00:00:00Z' }), weak()]])('H1 future pass cannot clear in either order', (...records) => {
    expect(evaluate(ledger(records)).ok).toBe(false);
  });
  it('future WEAKENED blocks', () => expect(evaluate(ledger([pass(), weak({ at: '2099-01-01T00:00:00Z' })])).ok).toBe(false));
  it('H2 identical-line replay does not clear a later WEAKENED', () => {
    const l = ledger([pass(), weak()]); l.text += l.lines[1] + '\n';
    expect(evaluate(l).ok).toBe(false);
  });
  it('H2b fresh id with old prev breaks the chain', () => {
    const l = ledger([pass(), weak()]); l.text += JSON.stringify({ ...JSON.parse(l.lines[1]), id: 'fresh' }) + '\n';
    expect(evaluate(l)).toMatchObject({ ok: false, reason: 'chain-break' });
  });
  it('H3 related-head higher seq vetoes despite earlier at', () => {
    expect(evaluate(ledger([pass(), weak({ head: OTHER, at: '2026-11-01T00:00:00Z' })])).ok).toBe(false);
  });
  it('H3b higher seq pass clears when legacy order agrees', () => {
    expect(evaluate(ledger([weak({ head: OTHER }), pass({ at: '2026-11-17T11:30:00Z' })])).ok).toBe(true);
    expect(evaluate(ledger([weak({ head: OTHER }), pass({ at: '2026-11-01T00:00:00Z' })])).ok).toBe(false); // legacy (main) veto by timestamp stands
  });
  it('H4 missing fp and failed recomputation is blocking unknown', () => {
    expect(evaluate(ledger([pass(), weak({ head: OTHER, fingerprint: null })]), { resolveFingerprint: () => { throw Error('git failed'); } }).ok).toBe(false);
  });
  it('H4b different fp does not veto', () => {
    expect(evaluate(ledger([pass(), weak({ head: OTHER, fingerprint: 'e'.repeat(64) })])).ok).toBe(true);
  });
  it('recomputes a missing related fingerprint', () => {
    expect(evaluate(ledger([pass(), weak({ head: OTHER, fingerprint: null })]), { resolveFingerprint: () => FP }).ok).toBe(false);
  });
  it('unknown live fp cannot rule out another-head negative', () => {
    expect(evaluate(ledger([pass(), weak({ head: OTHER, fingerprint: 'e'.repeat(64) })]), { liveFp: null }).ok).toBe(false);
  });
  it('sole chained WEAKENED supplies evidence with its auditId waiver and readiness disclosure', () => {
    const l = ledger([weak()]);
    const waiver = { ref: 'lane/test', sha: HEAD, ruling: 'R1047', auditId: 'id-1', findings: weak().findings };
    const gate = readyEvidence([{ ref: waiver.ref, sha: HEAD, tests: 'green', audit: 'WEAKENED',
      auditRuling: waiver.ruling, auditDisclosed: waiver.findings }], { branch: waiver.ref, sha: HEAD }, [waiver]);
    expect(gate.ruledWeakened.auditId).toBe('id-1');
    const expected = { ok: true, record: { id: 'id-1', verdict: 'WEAKENED', findings: waiver.findings } };
    expect(evaluate(l, { waivers: [waiver] })).toMatchObject(expected);
    expect(evaluate(l, { ruledWeakened: gate })).toMatchObject(expected);
    save(l);
    expect(evaluateAuditFile({ ledgerPath: path, ...options, ruledWeakened: gate })).toMatchObject(expected);
  });
  it.each([{ auditId: 'different-id' }, { findings: ['file:1 guard '] }, { sha: OTHER }])(
    'sole WEAKENED cannot qualify with a mismatched waiver: %j', mismatch => {
      const waiver = { sha: HEAD, auditId: 'id-1', findings: weak().findings, ...mismatch };
      expect(evaluate(ledger([weak()]), { waivers: [waiver] }).ok).toBe(false);
    });
  it('sole waived WEAKENED still requires coverage and a fingerprint', () => {
    const waivers = [{ sha: HEAD, auditId: 'id-1', findings: weak().findings }];
    expect(evaluate(ledger([weak()]), { waivers, covers: () => false }).ok).toBe(false);
    expect(evaluate(ledger([weak({ fingerprint: null })]), { waivers }).ok).toBe(false);
  });
  it('sole waived WEAKENED cannot authorize a later negative or an untrusted record', () => {
    const waivers = [{ sha: HEAD, auditId: 'id-1', findings: weak().findings }];
    expect(evaluate(ledger([weak(), weak()]), { waivers }).ok).toBe(false);
    const l = ledger([]); l.text += JSON.stringify({ ...weak(), id: 'id-1' }) + '\n';
    expect(evaluate(l, { waivers }).ok).toBe(false);
  });
  it('a waiver bound to X does not cover later Y', () => {
    const waivers = [{ sha: HEAD, auditId: 'id-2', findings: weak().findings }];
    expect(evaluate(ledger([pass(), weak()]), { waivers }).ok).toBe(true);
    expect(evaluate(ledger([pass(), weak(), weak()]), { waivers }).ok).toBe(false);
  });
  it('rule 9 property: across the fixture matrix v2 never passes where main\'s legacy evaluator refuses', () => {
    const FP2 = 'e'.repeat(64);
    const pieces = [pass(), weak(), pass({ head: OTHER }), weak({ head: OTHER }), pass({ head: OTHER, fingerprint: FP2 }), weak({ head: OTHER, fingerprint: FP2 }),
      pass({ at: '2026-11-17T11:30:00Z' }), weak({ base: OTHER }), pass({ at: '2099-01-01T00:00:00Z' }), weak({ fingerprint: null }), pass({ base: HEAD.toUpperCase() })];
    const waiverSets = [undefined, [{ sha: HEAD, findings: weak().findings }], [{ sha: HEAD, auditId: 'id-1', findings: weak().findings }]];
    let evaluated = 0, passed = 0;
    for (const a of pieces) for (const b of [...pieces, null]) for (const c of [...pieces, null]) for (const waivers of waiverSets) {
      const records = [a, b, c].filter(Boolean), l = ledger(records);
      const extra = waivers ? { waivers } : {}, v2 = evaluate(l, extra);
      const legacy = canonicalAuditEvidence(records, HEAD, () => true, FP, { ...withGate(extra).ruledWeakened ? { ruledWeakened: withGate(extra).ruledWeakened } : {}, now: NOW, priorQuestionHashes: [] });
      evaluated++;
      if (v2.ok) { passed++; expect(legacy.ok, JSON.stringify({ records, waivers })).toBe(true); }
    }
    expect(evaluated).toBeGreaterThan(4000);
    expect(passed).toBeGreaterThan(100);
  });
  it('rule 0: identical commits with differently cased shas are an empty range, never a pass', () => {
    expect(evaluate(ledger([pass({ base: HEAD.toUpperCase() })])).ok).toBe(false);
    expect(evaluate(ledger([pass({ head: HEAD.toUpperCase(), base: HEAD })]), { head: HEAD.toUpperCase() }).ok).toBe(false);
  });
  it('rule 0: an invalid timestamp stays blocked even with a matching waiver', () => {
    const waivers = [{ sha: HEAD, auditId: 'id-1', findings: weak().findings }];
    expect(evaluate(ledger([weak({ at: 'not-a-time' })]), { waivers }).ok).toBe(false);
    expect(evaluate(ledger([weak({ at: '2099-01-01T00:00:00Z' })]), { waivers }).ok).toBe(false);
  });
  it('rule 0: a live-head waiver cannot authorize a carried other-head audit without a binding fingerprint', () => {
    const rec = weak({ head: OTHER });
    const unbound = [{ sha: HEAD, auditId: 'id-1', findings: rec.findings }];
    expect(evaluate(ledger([rec]), { waivers: unbound }).ok).toBe(false);
    expect(evaluate(ledger([rec]), { waivers: [{ ...unbound[0], fingerprint: 'f'.repeat(64) }] }).ok).toBe(false);
    expect(evaluate(ledger([rec]), { waivers: [{ ...unbound[0], fingerprint: FP }] }).ok).toBe(true);
  });
  it('a pass on another related head never clears a related-head WEAKENED; only the live head does', () => {
    const THIRD = 'e'.repeat(40);
    expect(evaluate(ledger([weak({ head: OTHER }), pass({ head: THIRD })])).ok).toBe(false);
    expect(evaluate(ledger([weak({ head: OTHER }), pass({ head: THIRD }), pass({ at: '2026-11-17T11:30:00Z' })])).ok).toBe(true);
  });
  it('chained records without genesis cannot downgrade to legacy ordering', () => {
    const l = ledger([weak(), pass()]);
    const text = l.lines.slice(1).join('\n') + '\n';
    expect(evaluateAudit(text, { ...options })).toMatchObject({ ok: false, reason: 'chain-break' });
    expect(evaluateAudit(text, { ...options, hwm: undefined, hwmPresent: false }).ok).toBe(false);
  });
  it('a reseal does not make earlier chained records waivable without an auditId', () => {
    const first = ledger([weak()]);
    const resealed = [...first.lines, JSON.stringify(genesisLine(Buffer.from(first.text), { actor: 'a', reason: 'r' }).record)];
    const text = resealed.join('\n') + '\n';
    const hwm = { seq: 0, lineHash: sha256Line(resealed.at(-1)) };
    const waivers = [{ sha: HEAD, findings: weak().findings }];
    expect(evaluateAudit(text, { ...options, hwm, ...withGate({ waivers }) }).ok).toBe(false);
  });
  it('a reseal does not promote an unchained pass to trusted legacy evidence', () => {
    const first = ledger([weak()]);
    const stale = JSON.stringify(pass({ at: '2026-11-17T11:30:00Z' }));
    const lines = [...first.lines, stale, JSON.stringify(genesisLine(Buffer.from(`${first.lines.join('\n')}\n${stale}\n`), { actor: 'a', reason: 'r' }).record)];
    const hwm = { seq: 0, lineHash: sha256Line(lines.at(-1)) };
    expect(evaluateAudit(lines.join('\n') + '\n', { ...options, hwm }).ok).toBe(false);
  });
  it('live-head verdicts take precedence over a covered carried pass', () => {
    const l = ledger([pass({ head: OTHER, base: 'e'.repeat(40) }), pass()]);
    expect(evaluate(l, { covers: base => base === 'e'.repeat(40) }).ok).toBe(false);
  });
  it('a waiver without auditId covers only legacy', () => {
    const waivers = [{ sha: HEAD, findings: weak().findings }];
    const legacy = ledger([pass()], JSON.stringify(weak({ base: OTHER })) + '\n');
    expect(evaluate(legacy).ok).toBe(false);
    expect(evaluate(legacy, { waivers }).ok).toBe(true);
    expect(evaluate(ledger([pass(), weak()]), { waivers }).ok).toBe(false);
  });
  it('waiver findings must match byte for byte', () => {
    expect(evaluate(ledger([pass(), weak()]), { waivers: [{ sha: HEAD, auditId: 'id-2', findings: ['file:1 guard '] }] }).ok).toBe(false);
  });
  it('legacy-only pass unchanged including record identity', () => {
    const r = pass({ fingerprint: undefined });
    expect(canonicalAuditEvidence([r], HEAD).record).toBe(r);
    expect(findAudit([r], { head: HEAD, base: BASE, questionHash: QUESTION_HASH })).toBe(r);
    expect(evaluateAudit(JSON.stringify(r), options).ok).toBe(true);
  });
  it.each([pass(), weak()])('stale-writer unchained records never erase chained negatives', r => {
    const l = ledger([weak()]); l.text += JSON.stringify(r) + '\n'; expect(evaluate(l).ok).toBe(false);
  });
  it('unchained WEAKENED blocks even after a later linked pass', () => {
    const l = ledger([pass()]); l.text = l.lines[0] + '\n' + JSON.stringify(weak()) + '\n' + l.lines[1] + '\n';
    expect(evaluate(l).ok).toBe(false);
  });
  it('unchained pass is skipped for linking', () => {
    const l = ledger([weak(), pass()]); l.text = l.lines.slice(0, 2).join('\n') + '\n' + JSON.stringify(pass()) + '\n' + l.lines[2] + '\n';
    expect(evaluate(l).ok).toBe(true);
  });
  it('unparseable unknown line blocks', () => {
    const l = ledger([pass()]); l.text += '{broken\n'; expect(evaluate(l).ok).toBe(false);
  });
  it('truncation fails hwm', () => {
    const l = ledger([weak(), pass()]); l.text = l.lines.slice(0, 2).join('\n') + '\n';
    expect(evaluate(l)).toMatchObject({ ok: false, reason: 'chain-break' });
  });
  it('deleted genesis with hwm cannot downgrade to legacy', () => {
    const l = ledger([pass()]); l.text = l.lines[1] + '\n'; expect(evaluate(l).ok).toBe(false);
  });
  it('rewritten legacy byte fails genesis digest', () => {
    const l = ledger([pass()], JSON.stringify(pass()) + '\n'); l.text = l.text.replace('11:00', '10:00'); expect(evaluate(l).ok).toBe(false);
  });
  it.each(['missing', 'unreadable', 'mismatch'])('adapter fails closed on %s sidecar', kind => {
    const l = ledger([pass()]); save(l);
    if (kind === 'missing') fs.unlinkSync(join(root, 'audits.hwm.json'));
    else fs.writeFileSync(join(root, 'audits.hwm.json'), kind === 'unreadable' ? '{' : JSON.stringify({ seq: 1, lineHash: 'wrong' }));
    expect(evaluateAuditFile({ ledgerPath: path, ...options }).ok).toBe(false);
  });
  it('unreadable ledger refuses and missing pass fingerprint refuses', () => {
    expect(evaluateAuditFile({ ledgerPath: path, ...options }).ok).toBe(false);
    expect(evaluate(ledger([pass({ fingerprint: null })])).ok).toBe(false);
  });
  it('covered chained positive audit carries across rebased heads with identical fingerprints', () => {
    const l = ledger([pass({ head: OTHER })]);
    expect(evaluate(l)).toMatchObject({ ok: true, record: { head: OTHER, fingerprint: FP } });
    save(l);
    expect(evaluateAuditFile({ ledgerPath: path, ...options })).toMatchObject({ ok: true, record: { head: OTHER } });
  });
  it('carried positive audit requires canonical base coverage', () => {
    expect(evaluate(ledger([pass({ head: OTHER })]), { covers: () => false }).ok).toBe(false);
  });
  it.each(['e'.repeat(64), null])('other-head positive audit cannot carry with different or unknown live fingerprint: %s', liveFp => {
    expect(evaluate(ledger([pass({ head: OTHER })]), { liveFp }).ok).toBe(false);
  });
  it('carried positive audit cannot bypass a newer live-head WEAKENED', () => {
    expect(evaluate(ledger([pass({ head: OTHER }), weak()])).ok).toBe(false);
  });
  it('uncovered base cannot qualify', () => expect(evaluate(ledger([pass()]), { covers: () => false }).ok).toBe(false));
  it('current untrusted pass does not hide accepted prior WEAKENED', () => {
    const prior = 'f'.repeat(64);
    const l = ledger([weak({ questionHash: prior }), pass({ at: '2099-01-01T00:00:00Z' })]);
    expect(evaluate(l, { priorQuestionHashes: [{ hash: prior, acceptUntil: '2026-11-20T00:00:00Z' }] }).ok).toBe(false);
  });
  it('trusted current pass replaces accepted prior negative', () => {
    const prior = 'f'.repeat(64);
    expect(evaluate(ledger([weak({ questionHash: prior }), pass()]), { priorQuestionHashes: [{ hash: prior, acceptUntil: '2026-11-20T00:00:00Z' }] }).ok).toBe(true);
  });
  it('concurrent appendChained race stays contiguous and passes', async () => {
    await appendGenesis(path);
    await Promise.all(Array.from({ length: 8 }, () => appendChained(path, pass())));
    const records = fs.readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(evaluateAuditFile({ ledgerPath: path, ...options }).ok).toBe(true);
  });
  it('last reseal genesis re-roots the chain over every prior byte', async () => {
    await appendGenesis(path); await appendChained(path, weak());
    fs.appendFileSync(path, '{corrupt\n');
    await resealLedger(path);
    await appendChained(path, pass());
    // Unknown historical bytes remain negative evidence even though the new chain is valid.
    expect(evaluateAuditFile({ ledgerPath: path, ...options }).reason).toBe('weakened');
  });
});
describe('waiver backfill', () => {
  it('default dry run writes nothing; apply writes only matched', () => {
    save(ledger([weak({ ref: 'lane/test' })]));
    const prefsPath = join(root, 'prefs.json');
    const waivers = [{ ref: 'lane/test', sha: HEAD, findings: weak().findings }, { ref: 'lane/unmatched', sha: OTHER, findings: ['other'] }];
    const original = JSON.stringify({ prototypeLoad: { ruledWeakened: waivers }, untouched: 42 }); fs.writeFileSync(prefsPath, original);
    const report = backfillWaivers({ prefsPath, ledgerPath: path });
    expect(report).toMatchObject({ matched: [{ ref: 'lane/test', auditId: 'id-1' }], unmatched: [{ ref: 'lane/unmatched' }], applied: false });
    expect(fs.readFileSync(prefsPath, 'utf8')).toBe(original);
    expect(backfillWaivers({ prefsPath, ledgerPath: path, apply: true }).applied).toBe(true);
    const updated = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    expect(updated.prototypeLoad.ruledWeakened).toEqual([{ ...waivers[0], auditId: 'id-1' }, waivers[1]]); expect(updated.untouched).toBe(42);
  });
  it('CLI dry-run has no writes and requires explicit paths', () => {
    save(ledger([weak({ ref: 'lane/test' })])); const prefs = join(root, 'prefs.json');
    const original = JSON.stringify({ prototypeLoad: { ruledWeakened: [{ ref: 'lane/test', sha: HEAD, findings: weak().findings }] } }); fs.writeFileSync(prefs, original);
    const cli = 'scripts/operations/audit-ledger-waiver-backfill.mjs';
    expect(JSON.parse(execFileSync(process.execPath, [cli, `--prefs=${prefs}`, `--ledger=${path}`], { encoding: 'utf8' })).applied).toBe(false);
    expect(fs.readFileSync(prefs, 'utf8')).toBe(original);
    execFileSync(process.execPath, [cli, `--prefs=${prefs}`, `--ledger=${path}`, '--apply']);
    expect(JSON.parse(fs.readFileSync(prefs)).prototypeLoad.ruledWeakened[0].auditId).toBe('id-1');
    expect(() => execFileSync(process.execPath, [cli], { stdio: 'pipe' })).toThrow();
  });
});

it('waiver store round-trips auditId and rejects invalid bindings', () => {
  const path = join(root, 'waivers.jsonl');
  const entry = { ref: 'lane/test', sha: HEAD, ruling: 'R1047', findings: ['file:1 guard'], actor: 'test', quote: 'approved', auditId: 'id-1' };
  appendEntry(entry, { path });
  expect(readStore({ path }).entries[0].auditId).toBe('id-1');
  expect(() => appendEntry({ ...entry, auditId: {} }, { path })).toThrow();
});
