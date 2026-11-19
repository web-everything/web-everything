import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { appendEntry, readStore, storePath, validateEntry } from '../ruled-weakened-store.mjs';
import { createPrototypeLoader, loadRuledWeakened } from '../prototype-load-io.mjs';
import { readyEvidence } from '../prototype-load.mjs';
import { resolveOperation } from '../run.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { RULED_WEAKENED_ADD_EFFECT, finishRuledWeakenedAdd } from '../ruled-weakened-add.mjs';
import { op } from '../registry.mjs';

const SHA = 'a'.repeat(40);
const at = '2026-11-17T12:00:00.000Z';
const entry = (over = {}) => ({ ref: 'lane/fix', sha: SHA, ruling: 'R12+R13', findings: [' first ', 'second'], actor: 'operator', quote: 'approved findings', at, ...over });
const record = { ref: 'lane/fix', sha: SHA, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12+R13', auditDisclosed: entry().findings };
const input = { branch: record.ref, sha: SHA };
const gate = (entries) => readyEvidence([record], input, entries);
let home, path, env;
beforeEach(() => {
  home = fs.mkdtempSync(join(process.env.TMPDIR, 'ruled-weakened-'));
  env = { HOME: home, WE_PLATFORM_PREFERENCES_FILE: join(home, 'preferences.json') };
  path = storePath(env);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
const union = (opts = {}) => loadRuledWeakened({ fs, env, ...opts });
const append = (e = entry(), opts = {}) => appendEntry(e, { path, fs, now: () => at, ...opts });

describe('ops ruled-weakened evidence', () => {
  const requests = (...rows) => {
    const file = join(home, 'workspace/.operations/handoff/waiver-requests.jsonl');
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.appendFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const withdrawn = (over = {}) => ({ ref: 'lane/fix (description)', sha: SHA.toUpperCase(), ruling: 'WITHDRAWN', at: '2026-11-18T12:00:00Z', ...over });
  it('revokes a recorded waiver after a later WITHDRAWN, matching bare ref and case-insensitive sha', () => {
    append();
    expect(gate(union())).not.toBeNull();
    requests(withdrawn());
    expect(union()).toEqual([]);
    expect(gate(union())).toBeNull();
  });
  it('keeps waivers newer than WITHDRAWN and admits a later store re-approval over revoked settings', () => {
    append();
    requests(withdrawn({ at: '2026-11-16T12:00:00Z' }));
    expect(gate(union())).not.toBeNull();
    requests(withdrawn());
    append(entry(), { now: () => '2026-11-19T12:00:00Z' });
    expect(union({ platform: [{ ...entry(), at: undefined }], tool: [{ ...entry(), at: undefined }] }))
      .toEqual([expect.objectContaining({ layer: 'ops', at: '2026-11-19T12:00:00.000Z' })]);
  });
  it('does not revoke for another ref, sha or ruling', () => {
    append();
    requests(withdrawn({ ref: 'lane/other' }), withdrawn({ sha: 'b'.repeat(40) }), withdrawn({ ruling: 'APPROVED' }));
    expect(gate(union())).not.toBeNull();
  });
  it.each([undefined, 'not-a-date', 0])('revokes all matching layers when WITHDRAWN has unusable at: %s', at => {
    append();
    requests(withdrawn({ at }));
    expect(union({ platform: [entry()], tool: [entry()] })).toEqual([]);
  });
  it('revokes at equal timestamps and revokes undated platform/tool waivers even for older WITHDRAWN', () => {
    append();
    requests(withdrawn({ at }));
    expect(union()).toEqual([]);
    requests(withdrawn({ at: '2026-11-16T12:00:00Z' }));
    for (const layer of ['platform', 'tool']) expect(union({ [layer]: [{ ...entry(), at: undefined }] })).toEqual([]);
  });
  it('ignores malformed request lines with warnings while still applying valid revocations', () => {
    append();
    requests('{bad', 'null', '{}', withdrawn());
    const warn = vi.fn();
    expect(union({ warn })).toEqual([]);
    expect(warn.mock.calls.map(([s]) => s)).toEqual([1, 2, 3].map(i => expect.stringContaining(`line ${i}:`)));
  });
  it('fails closed for an unreadable request log, including platform/tool waivers, with a recovery warning', () => {
    append();
    const file = requests();
    fs.rmSync(file);
    fs.mkdirSync(file);
    const warn = vi.fn();
    expect(union({ platform: [entry()], tool: [entry()], warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Restore log readability'));
  });
  it('fails closed for a request log exceeding 16 MiB and asks the operator to archive it', () => {
    append();
    requests(' '.repeat(16 * 1024 * 1024));
    const warn = vi.fn();
    expect(union({ warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/16 MiB.*archive/i));
  });
  it('matches through the loader merge only with the same ref, full sha and verbatim ordered findings', () => {
    append();
    expect(gate(union())).toMatchObject({ ruledWeakened: { layer: 'ops' } });
    for (const change of [{ ref: 'lane/other' }, { sha: 'b'.repeat(40) }, { findings: ['first', 'second'] }, { findings: ['second', ' first '] }, { ruling: 'R99' }]) {
      fs.writeFileSync(path, JSON.stringify(entry(change)) + '\n');
      expect(gate(union())).toBeNull();
    }
    fs.writeFileSync(path, JSON.stringify(entry({ sha: SHA.slice(0, 7) })) + '\n');
    expect(gate(union({ warn: vi.fn() }))).toBeNull();
  });
  it('appends one line in one append write, preserving the first line byte for byte and rejecting missing ruling', () => {
    const appendFileSync = vi.fn(fs.appendFileSync.bind(fs));
    const io = { ...fs, appendFileSync };
    const first = append(entry(), { fs: io });
    const bytes = fs.readFileSync(path);
    append(entry({ ruling: 'R14' }), { fs: io });
    expect(fs.readFileSync(path).subarray(0, bytes.length)).toEqual(bytes);
    expect(fs.readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
    expect(appendFileSync.mock.calls[0]).toEqual([path, JSON.stringify(first) + '\n', { encoding: 'utf8', flag: 'a' }]);
    expect(() => append(entry({ ruling: undefined }))).toThrow(/ruling/);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
  });
  it('appends to an unterminated valid row without changing existing bytes and keeps both entries readable', () => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    const first = entry();
    const bytes = Buffer.from(JSON.stringify(first));
    fs.writeFileSync(path, bytes);
    expect(readStore({ path, fs }).entries).toEqual([first]);
    const appendFileSync = vi.fn(fs.appendFileSync.bind(fs));
    const second = append(entry({ ruling: 'R14' }), { fs: { ...fs, appendFileSync } });
    expect(fs.readFileSync(path).subarray(0, bytes.length)).toEqual(bytes);
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(appendFileSync).toHaveBeenCalledWith(path, `\n${JSON.stringify(second)}\n`, { encoding: 'utf8', flag: 'a' });
    const warn = vi.fn();
    expect(readStore({ path, fs, warn })).toEqual({ entries: [first, second], error: null });
    expect(warn).not.toHaveBeenCalled();
  });
  it('refuses to append when the existing record separator cannot be read', () => {
    const appendFileSync = vi.fn();
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const io = { ...fs, appendFileSync, readFileSync: () => { throw error; } };
    expect(() => append(entry(), { fs: io })).toThrow('permission denied');
    expect(appendFileSync).not.toHaveBeenCalled();
  });
  it('treats missing store as empty and unreadable store as no waiver with an operator-visible reason', () => {
    expect(readStore({ path, fs })).toEqual({ entries: [], error: null });
    fs.mkdirSync(path, { recursive: true });
    const got = readStore({ path, fs });
    expect(got.entries).toEqual([]);
    expect(got.error).toMatch(/EISDIR|directory/i);
    const warn = vi.fn();
    expect(gate(union({ warn }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(got.error));
    expect(gate(union({ tool: [entry()], warn }))).toMatchObject({ ruledWeakened: { layer: 'tool' } });
  });
  it('skips malformed lines with line numbers without granting wildcards or losing valid rows', () => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    const rows = ['{broken', ...['sha', 'ref', 'findings', 'ruling'].map(key => JSON.stringify(entry({ [key]: undefined }))), JSON.stringify(entry())];
    fs.writeFileSync(path, rows.join('\n') + '\n');
    const warn = vi.fn();
    const loaded = readStore({ path, fs, warn });
    expect(loaded.entries).toEqual([entry()]);
    expect(warn.mock.calls.map(([s]) => s)).toEqual([1, 2, 3, 4, 5].map(i => expect.stringContaining(`line ${i}:`)));
    expect(gate(union({ warn }))).not.toBeNull();
    fs.writeFileSync(path, rows.slice(0, -1).join('\n'));
    expect(gate(union({ warn }))).toBeNull();
  });
  it('preserves a valid optional carry fingerprint through append, read and the ops waiver union', () => {
    const fingerprint = 'c'.repeat(64);
    const value = append(entry({ fingerprint }));
    const warn = vi.fn();
    expect(readStore({ path, fs, warn })).toEqual({ entries: [value], error: null });
    expect(warn).not.toHaveBeenCalled();
    const liveInput = { ...input, sha: 'b'.repeat(40) };
    const carriedRecord = { ...record, fingerprint };
    expect(readyEvidence([carriedRecord], liveInput, union({ warn }), fingerprint))
      .toMatchObject({ ruledWeakened: { layer: 'ops' } });
    expect(readyEvidence([carriedRecord], liveInput, union({ warn }), 'd'.repeat(64))).toBeNull();
  });
  it.each([null, undefined, 'd'.repeat(64)])('a fingerprint-bearing store entry cannot authorize another sha without an exact live match: %s', liveFp => {
    const fingerprint = 'c'.repeat(64);
    append(entry({ fingerprint }));
    const liveInput = { ...input, sha: 'b'.repeat(40) };
    expect(readyEvidence([{ ...record, fingerprint }], liveInput, union(), liveFp)).toBeNull();
    expect(readyEvidence([{ ...record, sha: liveInput.sha, fingerprint }], liveInput, union(), liveFp)).toBeNull();
  });
  it('a store entry without a fingerprint cannot authorize another sha even when readiness carries', () => {
    append();
    const fingerprint = 'c'.repeat(64);
    expect(readyEvidence([{ ...record, fingerprint }], { ...input, sha: 'b'.repeat(40) }, union(), fingerprint)).toBeNull();
  });
  it('malformed optional fingerprints remain unreadable and grant no waiver', () => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    for (const fingerprint of [null, true, 12, '', 'c'.repeat(63), 'z'.repeat(64)]) {
      fs.writeFileSync(path, JSON.stringify(entry({ fingerprint })) + '\n');
      const warn = vi.fn();
      expect(readStore({ path, fs, warn })).toEqual({ entries: [], error: null });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(gate(union({ warn }))).toBeNull();
    }
  });
  it('rejects unknown fields in validation and append without writing', () => {
    for (const extra of [{ fingerprint: 'invalid' }, { unexpected: true }]) {
      const value = entry(extra);
      expect(validateEntry(value)).toBe(false);
      expect(() => append(value)).toThrow(/invalid ruled-weakened entry/);
    }
    expect(fs.existsSync(path)).toBe(false);
  });
  it('unions all layers and retains tool then platform precedence for ref+sha+ruling duplicates', () => {
    append();
    const platform = entry({ ref: 'lane/platform' }), tool = entry({ ref: 'lane/tool' });
    const entries = union({ platform: [platform], tool: [tool] });
    expect(entries.map(e => e.layer)).toEqual(['tool', 'platform', 'ops']);
    for (const e of entries) expect(readyEvidence([{ ...record, ref: e.ref }], { ...input, branch: e.ref }, entries)).toMatchObject({ ruledWeakened: { layer: e.layer } });
    expect(union({ platform: [entry()], tool: [entry({ sha: SHA.toUpperCase() })] })).toHaveLength(1);
    expect(union({ platform: [entry()] })[0].layer).toBe('platform');
  });
  it('fails closed with a reason for an unreadable store while keeping platform/tool waivers', () => {
    fs.mkdirSync(path, { recursive: true });
    const result = readStore({ path, fs });
    expect(result.entries).toEqual([]);
    expect(result.error).toMatch(/EISDIR|directory/i);
    const warn = vi.fn();
    expect(gate(union({ warn }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(result.error));
    expect(gate(union({ warn, platform: [entry()] }))).toMatchObject({ ruledWeakened: { layer: 'platform' } });
    expect(gate(union({ warn, tool: [entry()] }))).toMatchObject({ ruledWeakened: { layer: 'tool' } });
  });
  it('treats a missing store as empty without a warning', () => {
    const warn = vi.fn();
    expect(readStore({ path, fs, warn })).toEqual({ entries: [], error: null });
    expect(warn).not.toHaveBeenCalled();
  });
  it('treats a missing store as empty and an unreadable store as no waiver with a reason, preserving settings', () => {
    expect(readStore({ path, fs })).toEqual({ entries: [], error: null });
    fs.mkdirSync(path, { recursive: true });
    const result = readStore({ path, fs });
    expect(result.entries).toEqual([]);
    expect(result.error).toMatch(/EISDIR|directory/i);
    const warn = vi.fn();
    expect(gate(union({ warn }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(result.error));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Restore store readability'));
    expect(gate(union({ platform: [entry()], warn }))).toMatchObject({ ruledWeakened: { layer: 'platform' } });
    expect(gate(union({ tool: [entry()], warn }))).toMatchObject({ ruledWeakened: { layer: 'tool' } });
  });
  it('rejects incomplete provenance, invalid rulings and non-string evidence', () => {
    for (const change of [{ actor: '' }, { quote: ' ' }, { at: 'yesterday' }, { ruling: 'approved' }, { ruling: ['R12'] }, { findings: [' '] }, { sha: [SHA] }, { ref: '' }]) expect(validateEntry(entry(change))).toBe(false);
  });
  it('reads the ops path through the loader injected fs and HOME', () => {
    append();
    const readFileSync = vi.fn((p, encoding) => fs.readFileSync(p, encoding));
    createPrototypeLoader({ fs: { ...fs, readFileSync }, env, settings: {} });
    expect(readFileSync).toHaveBeenCalledWith(path, 'utf8');
  });
});

describe('declared ruled-weakened-add writer', () => {
  const argv = () => [`--ref=lane/fix`, `--sha=${SHA}`, '--ruling=R12+R13', '--finding= first ', '--finding=second', '--actor=operator', '--quote=approved findings'];
  it('registers the CLI operation, preserves repeated finding order and prints the appended entry as one JSON line', async () => {
    const wiring = resolveOperation('ruled-weakened-add', { cli: true });
    const parsed = parseOperationArgv(wiring.declaration, argv());
    expect(parsed.ok).toBe(true);
    expect(parsed.input.finding).toEqual(entry().findings);
    const out = await runOperationCli({ ...wiring, argv: argv(), store: createMemoryRunStore(), newRunId: () => 'waiver-test', sinks: { [RULED_WEAKENED_ADD_EFFECT]: e => append(e) } });
    const finished = finishRuledWeakenedAdd(out);
    expect(finished.code).toBe(0);
    expect(finished.lines).toHaveLength(1);
    expect(finished.lines[0]).not.toMatch(/[\r\n]/);
    expect(finished.lines.map(line => JSON.parse(line))).toEqual([entry()]);
    expect(`${finished.lines[0]}\n`).toBe(fs.readFileSync(path, 'utf8'));
    expect(readStore({ path, fs }).entries).toEqual([entry()]);
  });
  it('rejects missing or invalid ruling with a nonzero result and message, without writing', async () => {
    const wiring = resolveOperation('ruled-weakened-add', { cli: true });
    for (const flags of [argv().filter(s => !s.startsWith('--ruling=')), argv().map(s => s.startsWith('--ruling=') ? '--ruling=approved' : s)]) {
      const out = await runOperationCli({ ...wiring, argv: flags, store: createMemoryRunStore(), newRunId: () => 'waiver-reject', sinks: { [RULED_WEAKENED_ADD_EFFECT]: e => append(e) } });
      expect(out.code).not.toBe(0);
      expect(out.lines.join(' ')).toMatch(/ruling/);
    }
    expect(fs.existsSync(path)).toBe(false);
  });
  it('allows repeatable only on ordinary array fields and leaves scalar last-wins parsing unchanged', () => {
    expect(() => op('bad', { input: { field: { type: 'string', repeatable: true } } })).toThrow(/repeatable/);
    const wiring = resolveOperation('ruled-weakened-add', { cli: true });
    expect(parseOperationArgv(wiring.declaration, [...argv(), '--actor=last']).input.actor).toBe('last');
  });
});
