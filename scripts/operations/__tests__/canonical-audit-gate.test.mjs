import { describe, it, expect } from 'vitest';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const sha = 'a'.repeat(40), base = 'b'.repeat(40), other = 'c'.repeat(40);
const ref = 'lane/audit-gate';
const green = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
const weak = { ...green, verdict: 'WEAKENED', findings: ['missing guard'] };
const waiver = { ref, sha, ruling: 'R123', findings: weak.findings };
function fixture({ records = [green], auditText, tool = {}, platform = {}, resolved = sha, fetchMain = () => {}, ancestor = () => true, readOverride, liveFingerprint = () => null } = {}) {
  const reads = [], calls = [];
  const env = { HOME: '/fixture-home', WE_PLATFORM_PREFERENCES_FILE: '/fixture-prefs' };
  const readFile = (path) => {
    reads.push(path);
    if (readOverride) return readOverride(path);
    if (path === '/repo/scripts/settings/prototype-load.json') return JSON.stringify({ auditRecordPath: '~/audit.jsonl', ...tool });
    if (path === '/fixture-prefs') return JSON.stringify({ prototypeLoad: platform });
    if (path === '/fixture-home/audit.jsonl') return auditText ?? records.map(r => JSON.stringify(r)).join('\n');
    const error = new Error('missing'); error.code = 'ENOENT'; throw error;
  };
  const result = checkCanonicalAuditForOpen({ repo: '/repo', ref, sha: 'aaaaaaa', env, readFile, fetchMain, ancestor, liveFingerprint,
    exec: (cmd, args) => { calls.push([cmd, args]); return resolved; } });
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
  it('docs-only changes still refuse without canonical evidence (no diff exemption)', () => {
    expect(fixture({ records: [], tool: { docsOnly: true } }).result.reason).toBe('canonical-audit-missing');
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
  it('a short unresolved source fails closed before any evidence read', () => {
    const { result, reads } = fixture({ resolved: 'aaaaaaa' });
    expect(result.ok).toBe(false); expect(reads).toEqual([]);
  });
});
