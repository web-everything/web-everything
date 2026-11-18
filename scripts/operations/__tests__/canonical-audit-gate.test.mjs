import { describe, it, expect } from 'vitest';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { createHash } from 'node:crypto';
import { invariantsSection } from '../prototype-load.mjs';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { admitCanonicalAudit } from '../../pr-land.mjs';
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
function fixture({ records = [green], auditText, tool = {}, writerSettings, targetSettings, platform = {}, resolved = sha, fetchMain = () => {}, ancestor = () => true, readOverride, liveFingerprint = () => null, execOverride, auditAt = '/fixture-home/audit.jsonl', opsStore, refName = ref, extra = {} } = {}) {
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
  const result = checkCanonicalAuditForOpen({ repo: '/repo', ref: refName, sha: 'aaaaaaa', env, readFile, fetchMain, ancestor, liveFingerprint,
    exec: (cmd, args) => { calls.push([cmd, args]); return execOverride ? execOverride(args, resolved) : resolved; }, ...extra });
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

  // Scoped (scope=invariants) passes bind to the INVARIANTS block of the backlog card the PR branch names, resolved
  // through the same helper the prototype loader uses. Real records and real card text; admission is not mocked.
  describe('scoped passes at PR admission', () => {
    const itemRef = 'lane/4242-scoped-item';
    const card = '# Item\n\n## Invariants\n\n- Keep the guard.\n\n## Notes\n\nx\n';
    const invariantsHash = createHash('sha256').update(invariantsSection(card)).digest('hex');
    const scopedPass = { ...green, scope: 'invariants', invariantsHash, followUps: [] };
    // readOverride must serve the audit file and settings as well as the card.
    const run = (records, over = {}) => {
      const extra = { invariantsRoot: '/repo', readDir: () => ['4242-scoped-item.md'], ...over.extra };
      return fixture({ records, refName: over.refName ?? itemRef, extra, readOverride: (path) => {
        if (path === '/repo/backlog/4242-scoped-item.md') return over.card ?? card;
        if (path === WRITER_SETTINGS) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
        if (path === '/fixture-prefs') return JSON.stringify({ prototypeLoad: {} });
        if (path === '/fixture-home/audit.jsonl') return records.map(r => JSON.stringify(r)).join('\n');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      } }).result;
    };
    it('a scoped NOT WEAKENED pass with the matching invariants hash is the only record: admitted', () => {
      expect(run([scopedPass])).toMatchObject({ ok: true, sha, record: scopedPass });
    });
    it.each([
      ['wrong hash', { ...scopedPass, invariantsHash: 'f'.repeat(64) }],
      ['missing hash', { ...scopedPass, invariantsHash: undefined }],
    ])('a scoped pass with a %s is not evidence: canonical-audit-missing', (_name, record) => {
      expect(run([record])).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
    });
    it('an open NOT WEAKENED for the same head and base still admits when the scoped pass is unbound', () => {
      const unbound = { ...scopedPass, invariantsHash: 'f'.repeat(64), at: '2026-11-17T01:00:00Z' };
      expect(run([green, unbound])).toMatchObject({ ok: true, sha, record: green });
    });
    it.each([
      ['a card with no INVARIANTS block', { card: '# Item\n\nno section\n' }],
      ['no card for the item', { extra: { readDir: () => [] } }],
      ['several cards for the item', { extra: { readDir: () => ['4242-a.md', '4242-b.md'] } }],
      ['an unreadable backlog directory (never a throw)', { extra: { readDir: () => { throw new Error('EACCES'); } } }],
      ['a repo that is not the WE checkout', { extra: { invariantsRoot: '/elsewhere' } }],
    ])('no trusted invariants (%s) fails closed: the scoped pass is not evidence', (_name, over) => {
      expect(run([scopedPass], over)).toMatchObject({ ok: false, reason: 'canonical-audit-missing', record: null });
    });
    it('a branch that names no item binds to nothing', () => {
      expect(run([scopedPass], { refName: 'lane/r968-no-item' })).toMatchObject({ ok: false, reason: 'canonical-audit-missing' });
    });
    it('a scoped pass never hides an open WEAKENED at admission', () => {
      const w = { ...weak, at: '2026-11-17T00:00:00Z' };
      expect(run([w, { ...scopedPass, at: '2026-11-17T02:00:00Z' }])).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    });
  });

  describe('both PR-open producers hand the branch ref to the gate', () => {
    it('open-pr-io createPrLandRunner passes --ref to the canonical audit check', () => {
      const seen = [];
      const run = createPrLandRunner({ canonicalAudit: (req) => { seen.push(req); return { ok: false, reason: 'canonical-audit-missing', message: 'stop' }; },
        prepGate: () => ({ ok: true }), readPrepBody: () => '', prePrReview: () => ({ action: 'pass' }), dupBornAs: () => [], env: {},
        spawn: () => ({ status: 0, stdout: '{}' }), git: null });
      run({ argv: ['--ref=lane/4242-scoped-item', `--sha=${sha}`, '--title=x', '--body=y'] });
      expect(seen[0]).toMatchObject({ ref: 'lane/4242-scoped-item', sha });
    });
    it('pr-land admitCanonicalAudit forwards the whole request, ref included', () => {
      const seen = [];
      admitCanonicalAudit({ repo: 'r', ref: 'lane/4242-scoped-item', sha }, { check: (req) => { seen.push(req); return { ok: true }; }, refuse: () => { throw new Error('refused'); } });
      expect(seen[0]).toMatchObject({ ref: 'lane/4242-scoped-item' });
    });
  });
});
