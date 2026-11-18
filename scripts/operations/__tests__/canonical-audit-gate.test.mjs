import { describe, it, expect } from 'vitest';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { cardHash } from '../audit-base-repro.mjs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// The audit writer (codex-audit-io.mjs) reads the settings beside its own script; the gate must read the
// same file, never <target repo>/scripts/settings (a sibling repo has none).
const WRITER_SETTINGS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', 'prototype-load.json');

const sha = 'a'.repeat(40), base = 'b'.repeat(40), other = 'c'.repeat(40);
const ref = 'lane/audit-gate';
const green = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
const weak = { ...green, verdict: 'WEAKENED', findings: ['missing guard'] };
const waiver = { ref, sha, ruling: 'R123', findings: weak.findings };
function fixture({ records = [green], auditText, tool = {}, writerSettings, targetSettings, platform = {}, resolved = sha, fetchMain = () => {}, ancestor = () => true, readOverride, liveFingerprint = () => null, execOverride, auditAt = '/fixture-home/audit.jsonl', opsStore } = {}) {
  const reads = [], calls = [];
  const env = { HOME: '/fixture-home', WE_PLATFORM_PREFERENCES_FILE: '/fixture-prefs' };
  const enoent = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
  const readFile = (path) => {
    reads.push(path);
    if (readOverride) return readOverride(path);
    if (path === WRITER_SETTINGS) return writerSettings === null ? enoent() : writerSettings ?? JSON.stringify({ auditRecordPath: '~/audit.jsonl', ...tool });
    if (path === '/repo/scripts/settings/prototype-load.json' && targetSettings) return JSON.stringify(targetSettings);
    if (path === '/fixture-prefs') return JSON.stringify({ prototypeLoad: platform });
    if (path === '/fixture-home/workspace/.operations/coordination/ruled-weakened.jsonl' && opsStore !== undefined) return opsStore;
    if (path === auditAt) return auditText ?? records.map(r => JSON.stringify(r)).join('\n');
    const error = new Error('missing'); error.code = 'ENOENT'; throw error;
  };
  const result = checkCanonicalAuditForOpen({ repo: '/repo', ref, sha: 'aaaaaaa', env, readFile, fetchMain, ancestor, liveFingerprint,
    exec: (cmd, args) => { calls.push([cmd, args]); return execOverride ? execOverride(args, resolved) : resolved; } });
  return { result, reads, calls };
}
describe('canonical audit before opening a PR', () => {
  it('allows NOT WEAKENED on the exact resolved head and expands the configured path', () => {
    const { result, reads, calls } = fixture();
    expect(result).toMatchObject({ ok: true, sha, record: green });
    expect(reads).toContain('/fixture-home/audit.jsonl');
    expect(calls[0][1]).toEqual(['-C', '/repo', 'rev-parse', '--verify', '--end-of-options', 'aaaaaaa^{commit}']);
  });
  it('refuses missing evidence and names the exact command', () => {
    const { result } = fixture({ records: [] });
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-missing' });
    expect(result.message).toContain(`no canonical codex-audit record for ${sha}`);
    expect(result.message).toContain(`node scripts/operations/run.mjs codex-audit --base=origin/main --head=${sha}`);
  });
  it('refuses unwaived WEAKENED with precise remediation', () => {
    const { result } = fixture({ records: [weak] });
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    expect(result.message).toContain('no ruledWeakened waiver matches ref+sha+findings');
  });
  it.each(['tool', 'platform'])('allows an exact ref+full sha+findings waiver from %s', layer => {
    expect(fixture({ records: [weak], [layer]: { ruledWeakened: [waiver] } }).result).toMatchObject({ ok: true, record: weak });
  });
  it.each([
    ['wrong ref', { ref: 'lane/elsewhere' }], ['wrong sha', { sha: other }],
    ['short sha', { sha: sha.slice(0, 7) }], ['different findings', { findings: ['different guard'] }],
  ])('refuses a waiver with %s', (_name, over) => {
    expect(fixture({ records: [weak], tool: { ruledWeakened: [{ ...waiver, ...over }] } }).result)
      .toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it('refuses a green record for another head even with an identical fingerprint', () => {
    const fp = 'd'.repeat(64);
    expect(fixture({ records: [{ ...green, head: other, fingerprint: fp }], liveFingerprint: () => fp }).result)
      .toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
  });
  it('R995: a failed live-fingerprint lookup refuses and never falls back to an older exact-head pass', () => {
    const fp = 'd'.repeat(64);
    const records = [{ ...green, fingerprint: fp }, { ...weak, head: other, fingerprint: fp, at: '2026-11-17T01:00:00Z' }];
    const result = fixture({ records, liveFingerprint: false,
      execOverride: (args, resolved) => { if (args.includes('diff')) throw new Error('diff failed'); return resolved; } }).result;
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
    expect(result.message).toMatch(/cannot verify newer WEAKENED audits/);
    expect(result.message).toMatch(/codex-audit --base=origin\/main --head=/);
  });
  it('allows an audited local head before first branch publication', () => {
    const { result, calls } = fixture({
      records: [green, { ...green, head: other, fingerprint: 'd'.repeat(64) }], liveFingerprint: false,
      execOverride: (args, resolved) => {
        if (args.includes('fetch') && args.some(a => String(a).includes(ref))) throw new Error("couldn't find remote ref");
        if (args.includes('diff')) return 'diff --git a/docs/test.md b/docs/test.md\n+local documentation\n';
        return resolved;
      },
    });
    expect(result).toMatchObject({ ok: true, sha, record: green });
    expect(calls.some(([, args]) => args.includes('fetch') && args.some(a => String(a).includes(ref)))).toBe(false);
    expect(calls.some(([, args]) => args.includes('diff') && args.at(-1) === sha)).toBe(true);
  });
  it('a newer WEAKENED on another head with the same fingerprint hides an older pass', () => {
    const fp = 'd'.repeat(64);
    const records = [{ ...green, fingerprint: fp }, { ...weak, head: other, fingerprint: fp, at: '2026-11-17T01:00:00Z' }];
    expect(fixture({ records, liveFingerprint: evidence => { expect(evidence).toEqual(records); return fp; } }).result)
      .toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it('an exact-head waiver cannot hide a newer carried WEAKENED record', () => {
    const fp = 'd'.repeat(64);
    const records = [{ ...weak, fingerprint: fp }, { ...weak, head: other, fingerprint: fp, at: '2026-11-17T01:00:00Z' }];
    expect(fixture({ records, tool: { ruledWeakened: [waiver] }, liveFingerprint: () => fp }).result)
      .toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it.each(['before', 'after'])('refuses a truncated JSON line %s a valid pass and names recovery', position => {
    const lines = [JSON.stringify(green), '{"head":'];
    if (position === 'before') lines.reverse();
    const { result } = fixture({ auditText: lines.join('\n') });
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
    expect(result.message).toContain('audit record file has an unreadable/truncated line');
    expect(result.message).toContain(`Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${sha}`);
  });
  it('allows blank lines around valid JSON audit evidence', () => {
    expect(fixture({ auditText: `\r\n  \r\n${JSON.stringify(green)}\r\n\t\n` }).result)
      .toMatchObject({ ok: true, record: green });
  });
  it.each([
    ['invalid timestamp', { at: 'not-a-date' }],
    ['missing timestamp', { at: undefined }],
    ['contradictory findings', { findings: ['NOT WEAKENED'] }],
    ['hidden contradictory findings', { findings: ['\u001b[31mＮＯＴ ＷＥＡＫＥＮＥＤ\u001b[0m'] }],
    ['malformed findings', { findings: 'missing guard' }],
  ])('refuses %s negative evidence alongside an older pass', (_name, malformed) => {
    const { result } = fixture({ records: [green, { ...weak, at: '2026-11-17T01:00:00Z', ...malformed }] });
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
    expect(result.message).toContain('malformed');
    expect(result.message).toContain(`codex-audit --base=origin/main --head=${sha}`);
  });
  it.each(['before', 'after', 'carried', 'waived'])('malformed evidence refuses in the %s path', path => {
    const malformed = { ...weak, at: 'invalid', ...(path === 'carried' ? { head: other, fingerprint: 'd'.repeat(64) } : {}) };
    const records = path === 'before' ? [malformed, green] : [green, malformed];
    expect(fixture({ records, tool: path === 'waived' ? { ruledWeakened: [waiver] } : {}, liveFingerprint: () => 'd'.repeat(64) }).result)
      .toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
  });
  it.each([
    null, [], { ...weak, head: 'short' }, { ...weak, base: null },
    { ...weak, questionHash: QUESTION_HASH + '\n' }, { ...weak, fingerprint: 'not-a-fingerprint' },
    { ...weak, findings: [null] }, { ...weak, verdict: 'unknown' },
  ])('refuses malformed JSON record %j rather than falling back to a pass', record => {
    expect(fixture({ records: [green, record] }).result).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
  });
  it('the latest canonical WEAKENED supersedes an older green audit', () => {
    expect(fixture({ records: [green, { ...weak, at: '2026-11-17T01:00:00Z' }] }).result.reason).toBe('canonical-audit-weakened');
  });
  it('a newer green canonical audit supersedes WEAKENED', () => {
    expect(fixture({ records: [weak, { ...green, at: '2026-11-17T01:00:00Z' }] }).result.ok).toBe(true);
  });
  it('failed main fetch refuses green evidence', () => {
    expect(fixture({ fetchMain: () => { throw new Error('offline'); } }).result.ok).toBe(false);
  });
  it('an audit base outside origin/main refuses', () => {
    expect(fixture({ ancestor: () => false }).result.ok).toBe(false);
  });
  it('unreadable audit evidence or settings fails closed', () => {
    expect(fixture({ readOverride: () => { throw new Error('unreadable'); } }).result.reason).toBe('canonical-audit-missing');
  });
  describe('operator ops-store waivers (ruled-weakened-add), the same layer prototype-load reads', () => {
    const opsEntry = { ...waiver, actor: 'operator', at: '2026-11-17T02:00:00Z', quote: 'waive it' };
    it('admits WEAKENED with an exact ops-store waiver', () => {
      expect(fixture({ records: [weak], opsStore: `${JSON.stringify(opsEntry)}\n` }).result).toMatchObject({ ok: true, record: weak });
    });
    it.each([['wrong sha', { sha: other }], ['missing quote', { quote: undefined }], ['different findings', { findings: ['other'] }]])(
      'an ops-store entry with %s grants nothing', (_name, over) => {
        expect(fixture({ records: [weak], opsStore: `${JSON.stringify({ ...opsEntry, ...over })}\n` }).result)
          .toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
      });
    it.each([['unset', undefined], ['blank', '  ']])('an %s HOME resolves ~ via the OS home, never a relative path', (_name, value) => {
      const reads = [];
      const record = JSON.stringify(green);
      const result = checkCanonicalAuditForOpen({ repo: '/repo', ref, sha, env: { HOME: value, WE_PLATFORM_PREFERENCES_FILE: '/fixture-prefs' },
        fetchMain: () => {}, ancestor: () => true, liveFingerprint: () => null, exec: () => sha, warn: () => {},
        readFile: path => { reads.push(path); if (path === WRITER_SETTINGS) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
          if (path === '/fixture-prefs') return '{}'; if (path === join(homedir(), 'audit.jsonl')) return record;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
      expect(result).toMatchObject({ ok: true, record: green });
      expect(reads.every(p => p.startsWith('/'))).toBe(true);
    });
    it('a malformed ops-store line grants nothing', () => {
      expect(fixture({ records: [weak], opsStore: '{"ref":\n' }).result).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    });
  });
  describe('settings come from the audit writer, not the target checkout (sibling repos)', () => {
    it('admits audited evidence for a target checkout that has no scripts/settings file', () => {
      const { result, reads } = fixture();
      expect(result).toMatchObject({ ok: true, record: green });
      expect(reads).toContain(WRITER_SETTINGS);
      expect(reads).not.toContain('/repo/scripts/settings/prototype-load.json');
    });
    it("ignores the target checkout's own settings file (its path and waivers)", () => {
      const { result } = fixture({ records: [weak],
        targetSettings: { auditRecordPath: '/elsewhere.jsonl', ruledWeakened: [waiver] } });
      expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    });
    it('uses the writer default record path when the writer settings file is absent', () => {
      expect(fixture({ writerSettings: null, auditAt: '/fixture-home/workspace/.operations/coordination/audits.jsonl' }).result)
        .toMatchObject({ ok: true, record: green });
    });
    it('resolves a relative auditRecordPath against the audited checkout, like the writer', () => {
      expect(fixture({ tool: { auditRecordPath: 'records/audit.jsonl' }, auditAt: '/repo/records/audit.jsonl' }).result)
        .toMatchObject({ ok: true, record: green });
    });
    it('ignores a platform auditRecordPath the writer never consults', () => {
      expect(fixture({ platform: { auditRecordPath: '/platform.jsonl' } }).result).toMatchObject({ ok: true, record: green });
    });
    it.each([['malformed JSON', '{not json'], ['blank path', JSON.stringify({ auditRecordPath: ' ' })],
      ['non-string path', JSON.stringify({ auditRecordPath: 7 })], ['JSON null', 'null'], ['JSON array', '[]']])('refuses unreadable writer settings: %s', (_name, text) => {
      expect(fixture({ writerSettings: text }).result).toMatchObject({ ok: false, reason: 'canonical-audit-missing' });
    });
  });
  it('a short unresolved source fails closed before any evidence read', () => {
    const { result, reads } = fixture({ resolved: 'aaaaaaa' });
    expect(result.ok).toBe(false); expect(reads).toEqual([]);
  });
});


describe('R1053 additive audit records', () => {
  const entry = { line: 'x.mjs:2 unsafe return', key: 'x.mjs|X|B2',
    base: { sha: base, path: 'x.mjs', line: 2, quote: 'return unsafe();' }, relation: 'SAME', cardHash: cardHash('x.mjs|X|B2') };
  const scoped = { ...green, modelVerdict: 'WEAKENED', findingKeys: [], preExisting: [entry] };
  it.each([
    { key: undefined }, { key: 2 }, { key: 'x.mjs|X|Z9' }, { key: 'x.mjs|X|B2|extra' }, { key: '|X|B2' },
    { base: undefined }, { base: { ...entry.base, sha: 'bad' } }, { base: { ...entry.base, sha: `${base}\n` } }, { base: { ...entry.base, path: '' } },
    { base: { ...entry.base, path: 2 } }, { base: { ...entry.base, line: 0 } }, { base: { ...entry.base, line: 1.5 } },
    { base: { ...entry.base, line: '2' } }, { base: { ...entry.base, quote: '' } }, { base: { ...entry.base, quote: 2 } },
    { relation: 'WORSENED' }, { cardHash: 'a'.repeat(64) }, { cardHash: 'bad' }, { line: 2 },
  ])('rejects malformed entry fields even behind an older green record: %j', patch => {
    const malformed = { ...entry, ...patch };
    if (typeof patch.key === 'string') malformed.cardHash = cardHash(patch.key);
    const result = fixture({ records: [green, { ...scoped, preExisting: [malformed] }] }).result;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('malformed record');
  });
  it.each(['modelVerdict', 'findingKeys', 'preExisting'])('rejects partial additive fields missing %s', field => {
    const record = { ...scoped }; delete record[field];
    expect(fixture({ records: [green, record] }).result.message).toContain('malformed record');
  });
  it.each([null, 'key', [2]])('rejects malformed findingKeys %j', findingKeys => {
    expect(fixture({ records: [green, { ...scoped, findingKeys }] }).result.message).toContain('malformed record');
  });
  it('a7 admits mixed old and new records', () => {
    expect(fixture({ records: [green, scoped] }).result).toMatchObject({ ok: true, record: scoped });
  });
  it.each([null, {}, ['text'], [{ line: 2 }]])('refuses malformed preExisting %j', preExisting => {
    expect(fixture({ records: [green, { ...scoped, preExisting }] }).result.ok).toBe(false);
  });
  it.each(['invalid', null, 'WEAKENED\n'])('refuses invalid modelVerdict %j', modelVerdict => {
    expect(fixture({ records: [green, { ...scoped, modelVerdict }] }).result.ok).toBe(false);
  });
  it('scans retained pre-existing text for disguised contradictory verdicts', () => {
    expect(fixture({ records: [green, { ...scoped, preExisting: [{ ...entry, line: 'x.mjs:2 finding\nWEAKENED' }] }] }).result.ok).toBe(false);
  });
});
