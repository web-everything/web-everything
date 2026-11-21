import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEntries, recordWaivers } from '../ruled-weakened-record.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { findingsHash, readStore } from '../ruled-weakened-store.mjs';
import { readyEvidence } from '../prototype-load.mjs';
import { pruneStore } from '../ruled-weakened-prune.mjs';

const sha = 'a'.repeat(40), head = 'b'.repeat(40), ref = 'lane/a';
const FP = 'c'.repeat(64);
const now = '2026-11-19T12:00:00.000Z';
const request = { ref, sha, ruling: 'UNTRUSTED', findings: ['Verbatim. ', 'second finding'] };
const approval = { ref, sha, ruling: 'R123', findingsHash: findingsHash(request.findings) };
const audit = { head: sha, base: head, questionHash: QUESTION_HASH, verdict: 'WEAKENED', at: now, findings: ['Verbatim. ', 'second finding'] };
const options = overrides => ({ approvals: [approval], requests: [request], rulings: '**R123**', entries: [],
  latestAudit: () => audit, headOf: () => sha, carries: () => false, now, ...overrides });

describe('bounded approved waiver selection', () => {
  it('preserves carry proof when first recorded at the exact head', () => {
    const result = recordEntries(options({ carries: () => FP }));
    expect(result.entries[0]).toMatchObject({ sha, fingerprint: FP });
  });
  it('records only current heads with approval ruling and verbatim latest audit findings', () => {
    const result = recordEntries(options({ requests: [request, { ...request, sha: head }],
      approvals: [approval, { ...approval, sha: head }] }));
    expect(result.counts).toMatchObject({ added: 1, 'skipped-not-head': 1 });
    expect(result.entries).toEqual([{ ref, sha, ruling: 'R123', findings: audit.findings,
      actor: 'record-waivers', quote: 'R123', at: now }]);
  });
  it('accepts same-diff carry only when callback explicitly proves it', () => {
    const carries = vi.fn(() => FP);
    expect(recordEntries(options({ headOf: () => head, carries })).entries[0])
      .toMatchObject({ sha, fingerprint: FP, findings: audit.findings });
    expect(carries).toHaveBeenCalledWith({ ref, sha, ruling: 'R123' }, head);
    for (const value of [null, undefined, false, true, 'not-a-fingerprint', 'c'.repeat(63)])
      expect(recordEntries(options({ headOf: () => head, carries: () => value })).counts.added).toBe(0);
  });
  it('deduplicates stored tuples and repeated requests case-insensitively by sha', () => {
    expect(recordEntries(options({ entries: [{ ...approval, sha: sha.toUpperCase() }] })).counts)
      .toMatchObject({ added: 0, 'skipped-duplicate': 1 });
    expect(recordEntries(options({ requests: [request, request] })).counts)
      .toMatchObject({ added: 1, 'skipped-duplicate': 1 });
    expect(recordEntries(options({ entries: [{ ...approval, ruling: 'R124' }] })).counts.added).toBe(1);
  });
  it.each(['headOf', 'carries', 'latestAudit'])('lookup error in %s never adds', name => {
    expect(recordEntries(options({ headOf: () => head, carries: () => FP,
      [name]: () => { throw Error('unreadable'); } })).counts.added).toBe(0);
  });
  it('unknown or deleted heads skip without calling carry', () => {
    const carries = vi.fn(() => true);
    for (const value of [null, undefined, 'bad'])
      expect(recordEntries(options({ headOf: () => value, carries })).counts['skipped-not-head']).toBe(1);
    expect(carries).not.toHaveBeenCalled();
  });
  it('WITHDRAWN applies to the bare ref regardless of request order or sha case', () => {
    expect(recordEntries(options({ requests: [request,
      { ref: `${ref} (description)`, sha: sha.toUpperCase(), ruling: 'WITHDRAWN' }] })).counts.added).toBe(0);
  });
  it('an approval for findings A does not cover a sha whose audit says B', () => {
    const swapped = { ...audit, findings: ['a different, unapproved finding'] };
    const result = recordEntries(options({ latestAudit: () => swapped }));
    expect(result.entries).toEqual([]);
    expect(result.counts['skipped-invalid']).toBe(1);
    expect(recordEntries(options({ requests: [{ ...request, findings: undefined }] })).counts.added).toBe(0);
  });
  it.each([undefined, '0'.repeat(64)])('missing or mismatched approval findingsHash %s grants nothing', hash => {
    expect(recordEntries(options({ approvals: [{ ...approval, findingsHash: hash }] })).counts)
      .toMatchObject({ added: 0, 'skipped-invalid': 1 });
  });
  it('a replacement request for the same ref and sha needs its own approval findingsHash', () => {
    const findings = ['replacement finding'];
    const replacement = { ...request, findings };
    const cfg = { requests: [replacement], latestAudit: () => ({ ...audit, findings }) };
    expect(recordEntries(options(cfg)).counts).toMatchObject({ added: 0, 'skipped-invalid': 1 });
    expect(recordEntries(options({ ...cfg, approvals: [{ ...approval, findingsHash: findingsHash(findings) }] })).counts.added).toBe(1);
  });
  it.each([
    ['foreign question', { questionHash: 'foreign' }],
    ['non-WEAKENED verdict', { verdict: 'NOT WEAKENED' }],
    ['wrong head', { head }],
    ['missing timestamp', { at: undefined }],
    ['invalid timestamp', { at: 'invalid' }],
    ['missing base', { base: undefined }],
    ['symbolic base', { base: 'origin/main' }],
    ['base equals head', { base: sha }],
    ['contradictory findings', { findings: ['NOT WEAKENED'] }],
  ])('rejects a noncanonical audit: %s', (_, changes) => {
    const value = { ...audit, ...changes };
    expect(recordEntries(options({ latestAudit: () => value,
      requests: [{ ...request, findings: value.findings }],
      approvals: [{ ...approval, findingsHash: findingsHash(value.findings) }] })).counts)
      .toMatchObject({ added: 0, 'skipped-invalid': 1 });
  });
  it('missing approval never trusts the request ruling', () => {
    expect(recordEntries(options({ approvals: [], requests: [{ ...request, ruling: 'R123' }] })).counts.added).toBe(0);
  });
  it('preserves approved suffixed R-numbers supported by the handoff recorder', () => {
    expect(recordEntries(options({ approvals: [{ ...approval, ruling: 'R123a+R456' }], rulings: '**R123a** **R456**' })).entries[0].ruling).toBe('R123a+R456');
  });
  it.each(['R4', 'made-up', 'R123+R456', 'R123ab', 'R123A'])('unrecorded or invalid ruling %s never adds', ruling => {
    expect(recordEntries(options({ approvals: [{ ...approval, ruling }] })).counts.added).toBe(0);
  });
  it.each([null, { head, findings: ['wrong sha'] }, { head: sha, findings: [] }])('missing/incomplete audit %j never adds', value => {
    expect(recordEntries(options({ latestAudit: () => value })).counts.added).toBe(0);
  });
  it('normalizes descriptive refs and accepts uppercase exact heads', () => {
    expect(recordEntries(options({ requests: [{ ...request, ref: `${ref} (PR: description)` }],
      headOf: () => sha.toUpperCase() })).entries[0].ref).toBe(ref);
  });
});

function io(overrides = {}) {
  return { env: { HOME: '/fixture' }, path: '/fixture/store', repo: '.', now: () => now,
    read: file => file.endsWith('rulings.md') ? '**R123**' : JSON.stringify(file.endsWith('waiver-requests.jsonl')
      ? request : file.endsWith('waiver-approvals.jsonl') ? approval : audit),
    readEntries: () => ({ entries: [], error: null }),
    exec: vi.fn((_cmd, args) => ({ status: 0, stdout: args.includes('get-url')
      ? 'https://example.test/team/a.git\n' : `${sha}\trefs/heads/${ref}\n` })),
    fingerprint: () => null,
    append: vi.fn(entry => entry), log: vi.fn(), ...overrides };
}

describe('recorder IO', () => {
  it('pruning repository A preserves repository B waivers with absent or identical branch names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-repositories-'));
    const path = join(dir, 'store.jsonl');
    try {
      const recordIn = (repo, branch) => recordWaivers(io({ repo, path, append: undefined,
        readEntries: () => readStore({ path }),
        read: file => file.endsWith('rulings.md') ? '**R123**' : JSON.stringify(file.endsWith('waiver-requests.jsonl')
          ? { ...request, ref: branch } : file.endsWith('waiver-approvals.jsonl') ? { ...approval, ref: branch } : audit),
        exec: (_cmd, args) => ({ status: 0, stdout: args.includes('get-url')
          ? `https://example.test/team/${repo}.git` : `${sha}\trefs/heads/${branch}\n` }),
      }));
      expect(recordIn('a', ref).counts.added).toBe(1);
      expect(recordIn('b', ref).counts.added).toBe(1);
      expect(recordIn('b', 'lane/frontier-fix').counts.added).toBe(1);
      const [a, ...b] = readStore({ path }).entries;
      expect(a.repository).not.toBe(b[0].repository);
      const exec = (_cmd, args) => ({ status: 0, stdout: args.includes('get-url')
        ? 'https://example.test/team/a.git' : args.includes('ls-remote') ? `${sha}\trefs/heads/${ref}\n` : '' });
      expect(pruneStore({ path, repo: 'a', exec, log: () => {} })).toEqual({ kept: b, dropped: [a] });
      expect(readStore({ path }).entries).toEqual(b);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])('an outdated snapshot upgrades once under the lock and preserves metadata, legacy: %s', legacy => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-upgrade-'));
    try {
      const cfg = io({ path: join(dir, 'store.jsonl'), append: undefined, headOf: () => sha });
      recordWaivers(cfg);
      const [prior] = readStore({ path: cfg.path }).entries;
      if (legacy) {
        delete prior.repository;
        writeFileSync(cfg.path, `${JSON.stringify(prior)}\n`);
      }
      cfg.headOf = () => head;
      cfg.fingerprint = () => FP;
      cfg.now = () => '2026-11-20T12:00:00Z';
      expect(recordWaivers(cfg).counts.added).toBe(1);
      expect(recordWaivers(cfg).counts).toMatchObject({ added: 0, 'skipped-duplicate': 1 });
      expect(readStore({ path: cfg.path }).entries).toEqual([{ ...prior, fingerprint: FP }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])('recording before rebase keeps readiness, including legacy replay: %s', legacy => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-rebase-'));
    try {
      const cfg = io({ path: join(dir, 'store.jsonl'), append: undefined,
        headOf: () => sha, fingerprint: () => legacy ? null : FP });
      const ready = { ref, sha, fingerprint: FP, tests: 'green', audit: 'WEAKENED',
        auditRuling: approval.ruling, auditDisclosed: audit.findings };
      recordWaivers(cfg);
      if (legacy) {
        // Historical rows predate repository ownership as well as carry fingerprints.
        const [stored] = readStore({ path: cfg.path }).entries;
        delete stored.repository;
        writeFileSync(cfg.path, `${JSON.stringify(stored)}\n`);
      }
      expect(readyEvidence([ready], { branch: ref, sha }, readStore({ path: cfg.path }).entries, FP)).not.toBeNull();
      cfg.headOf = () => head;
      cfg.fingerprint = () => FP;
      cfg.readEntries = () => readStore({ path: cfg.path });
      recordWaivers(cfg);
      const entries = readStore({ path: cfg.path }).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].at).toBe(now);
      if (legacy) expect(entries[0]).not.toHaveProperty('repository');
      expect(readyEvidence([ready], { branch: ref, sha: head }, entries, FP)).not.toBeNull();
      expect(readyEvidence([ready], { branch: ref, sha: head }, entries, 'd'.repeat(64))).toBeNull();
      expect(recordWaivers(cfg).counts).toMatchObject({ added: 0, 'skipped-duplicate': 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not upgrade a legacy duplicate on changed code or replacement findings', () => {
    const entries = [{ ref, sha, ruling: approval.ruling, findings: audit.findings,
      actor: 'operator', quote: 'approved', at: now }];
    expect(recordEntries(options({ entries, headOf: () => head, carries: () => null })).entries).toEqual([]);
    expect(recordEntries(options({ entries, headOf: () => head, carries: () => FP,
      latestAudit: () => ({ ...audit, findings: ['replacement'] }) })).entries).toEqual([]);
  });
  it('uses remote current heads, latest ledger audit and appendEntry metadata, printing counts', () => {
    const cfg = io();
    const read = cfg.read;
    cfg.read = file => file.endsWith('audits.jsonl') ? `${JSON.stringify({ ...audit, findings: ['old'] })}\n${JSON.stringify(audit)}` : read(file);
    expect(recordWaivers(cfg).counts.added).toBe(1);
    expect(cfg.exec).toHaveBeenCalledWith('git', ['-C', '.', 'ls-remote', '--heads', 'origin'], expect.objectContaining({ timeout: 30000, maxBuffer: expect.any(Number) }));
    expect(cfg.append).toHaveBeenCalledWith(expect.objectContaining({ findings: audit.findings, actor: 'record-waivers', quote: 'R123', at: now }),
      { path: cfg.path, now, dedupe: true });
    expect(cfg.log.mock.calls[0][0]).toContain('added=1 skipped-not-head=0 skipped-duplicate=0');
  });
  it('uses shared net-diff fingerprints for carry and refuses unknown fingerprints', () => {
    for (const fp of ['c'.repeat(64), null]) {
      const cfg = io({ headOf: () => head, fingerprint: vi.fn(() => fp) });
      expect(recordWaivers(cfg).counts.added).toBe(fp ? 1 : 0);
      if (fp) expect(cfg.append.mock.calls[0][0]).toMatchObject({ sha, fingerprint: fp });
      expect(cfg.fingerprint.mock.calls).toEqual([['.', 'origin/main', sha], ['.', 'origin/main', head]]);
    }
  });
  it('different recorded and current fingerprints refuse recording', () => {
    const cfg = io({ headOf: () => head, fingerprint: vi.fn((repo, base, rev) => rev === sha ? FP : 'd'.repeat(64)) });
    expect(recordWaivers(cfg).counts).toMatchObject({ added: 0, 'skipped-not-head': 1 });
    expect(cfg.append).not.toHaveBeenCalled();
  });
  it('failed origin lookup is cached and never writes', () => {
    const cfg = io({ exec: vi.fn(() => ({ status: 1 })), read: file => file.endsWith('rulings.md') ? '**R123**'
      : file.endsWith('waiver-requests.jsonl') ? `${JSON.stringify(request)}\n${JSON.stringify(request)}`
        : JSON.stringify(file.endsWith('waiver-approvals.jsonl') ? approval : audit) });
    expect(recordWaivers(cfg).counts.added).toBe(0);
    expect(cfg.exec.mock.calls.filter(([, args]) => args.includes('ls-remote'))).toHaveLength(1);
    expect(cfg.append).not.toHaveBeenCalled();
  });
  it('oversized input refuses all writes with archive-and-retry guidance', () => {
    const cfg = io({ read: () => 'x'.repeat(16 * 1024 * 1024 + 1) });
    expect(() => recordWaivers(cfg)).toThrow(/archive old records and retry/);
    expect(cfg.append).not.toHaveBeenCalled();
  });
  it('unreadable inputs or store refuse before any append', () => {
    for (const overrides of [{ read: () => { throw Error('unreadable'); } },
      { readEntries: () => ({ entries: [], error: 'unreadable store' }) }]) {
      const cfg = io(overrides);
      expect(() => recordWaivers(cfg)).toThrow(/unreadable/);
      expect(cfg.append).not.toHaveBeenCalled();
    }
  });
  it('refuses unreadable evidence discovered by the locked dedupe recheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-record-'));
    try {
      const cfg = io({ path: join(dir, 'store.jsonl'), append: undefined });
      writeFileSync(cfg.path, 'invalid store evidence\n');
      expect(() => recordWaivers(cfg)).toThrow(/malformed JSON or invalid entry/);
      expect(readFileSync(cfg.path, 'utf8')).toBe('invalid store evidence\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('replays idempotently through the real locked append even with an outdated initial store read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-record-'));
    try {
      const cfg = io({ path: join(dir, 'store.jsonl'), append: undefined });
      expect(recordWaivers(cfg).counts.added).toBe(1);
      expect(recordWaivers(cfg).counts).toMatchObject({ added: 0, 'skipped-duplicate': 1 });
      expect(readStore({ path: cfg.path }).entries).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
