import { describe, it, expect } from 'vitest';
import { readMarkerSnapshot, validateLandingMarker } from '../verify-marker-validator.mjs';

const sha = 'a'.repeat(40), key = 'b'.repeat(64), treeHash = 'c'.repeat(64);
const gatePlan = { command: 'npm run test:unit', mode: 'full', selectionMode: 'pr', deltaBase: null };
const inputs = { headSha: sha, policyKey: key, gatePlan, treeHash, cleanTree: true };
const record = () => ({ v: 2, writer: 'verify-lane', runId: 'own-run', sha, status: 'green', exitCode: 0,
  policyKey: key, policyInputs: null, gatePlan, treeHash });

describe('local marker landing evidence', () => {
  it('complete own-run evidence passes without a timestamp requirement', () => {
    expect(validateLandingMarker(record(), inputs)).toMatchObject({ ok: true });
  });
  it.each([
    ['invalid:exit-status', { exitCode: 1, v: undefined }],
    ['invalid:exit-status', { exitCode: '0' }],
    ['invalid:exit-status', { status: 'running', exitCode: 0 }],
    ['invalid:record', { status: 'infrastructure-failure', infrastructure: [] }],
    ['invalid:version', { v: null }],
    ['invalid:writer', { writer: 'shared' }],
    ['invalid:schema', { runId: '' }],
    ['stale:producer-key-null', { policyKey: null }],
    ['stale:gate-mismatch', { gatePlan: null }],
    ['stale:other-head', { sha: 'd'.repeat(40) }],
    ['stale:tree-mismatch', { treeHash: null }],
  ])('consistency-before-version-and-schema: %s %j', (reason, patch) => {
    const rec = { ...record(), ...patch };
    if (patch.v === undefined && Object.hasOwn(patch, 'v')) delete rec.v;
    expect(validateLandingMarker(rec, inputs)).toMatchObject({ ok: false, reason });
  });
  it('missing differs from explicit null; well-formed legacy is stale', () => {
    const missing = record(); delete missing.policyKey;
    expect(validateLandingMarker(missing, inputs).reason).toBe('invalid:schema');
    const legacy = record(); delete legacy.v;
    expect(validateLandingMarker(legacy, inputs).reason).toBe('stale:legacy');
  });
  it.each([
    undefined, null, true, 'invalid', [], {},
    { baseSha: true }, { baseSha: {} }, { baseSha: [] }, { baseSha: null },
    { baseSha: '' }, { baseSha: 'invalid' }, { baseSha: 'a'.repeat(39) },
    { baseSha: 'a'.repeat(41) }, { baseSha: 'g'.repeat(40) },
  ])('red-preexisting refuses malformed authority evidence: %j', redCauseEvidence => {
    const red = { ...record(), status: 'red', exitCode: 1, redCause: 'pre-existing-on-main', redCauseEvidence };
    expect(validateLandingMarker(red, inputs)).toMatchObject({ ok: false, status: 'red', reason: 'verify-red' });
  });
  it('red-preexisting needs the same key, plan, exact head and clean tree', () => {
    const red = { ...record(), status: 'red', exitCode: 1, redCause: 'pre-existing-on-main', redCauseEvidence: { baseSha: sha } };
    expect(validateLandingMarker(red, inputs).ok).toBe(true);
    expect(validateLandingMarker(red, { ...inputs, policyKey: null }).reason).toBe('stale:consumer-key-unavailable');
    expect(validateLandingMarker(red, { ...inputs, policyKey: 'e'.repeat(64) }).reason).toBe('stale:key-mismatch');
    expect(validateLandingMarker(red, { ...inputs, cleanTree: false }).reason).toBe('stale:tree-mismatch');
  });
});

describe('bounded local snapshots, initial and label-time reader contract', () => {
  const limit = 1024 * 1024;
  function virtual(size, short = false, payload = null) {
    const calls = []; let returned = 0;
    return { calls, total: () => returned, io: {
      openSync: () => 1, closeSync: () => {},
      readFileSync: () => { throw new Error('unbounded read forbidden'); },
      readSync: (_fd, buffer, offset, length, position) => {
        calls.push({ position, length });
        expect(position + length).toBeLessThanOrEqual(limit + 1);
        const n = Math.max(0, Math.min(length, size - position, short ? 4093 : length));
        if (payload) payload.copy(buffer, offset, position, position + n);
        else buffer.fill(32, offset, offset + n);
        returned += n; return n;
      },
    } };
  }
  it.each([false, true])('oversized-input-never-reads-past-budget (short reads=%s)', short => {
    const port = virtual(Number.MAX_SAFE_INTEGER, short);
    const snapshot = readMarkerSnapshot('fixture-marker', { io: port.io });
    expect(port.total()).toBe(limit + 1);
    expect(snapshot.record.corrupt).toBe(true);
    expect(snapshot.detail).toMatch(/rerun|re-run/i);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(limit);
  });
  it('accepts exactly 1 MiB JSON and refuses the sentinel byte', () => {
    const json = JSON.stringify(record());
    const payload = Buffer.from(json + ' '.repeat(limit - Buffer.byteLength(json)));
    const port = virtual(payload.length, true, payload);
    const snapshot = readMarkerSnapshot('fixture-marker', { io: port.io });
    expect(snapshot.record).toEqual(record());
    expect(snapshot.source).toBe('local');
    expect(snapshot.bytesDigest).toMatch(/^[a-f0-9]{64}$/);
    const oversized = virtual(limit + 1);
    expect(readMarkerSnapshot('fixture-marker', { io: oversized.io }).record.corrupt).toBe(true);
  });
  it.each(['[]', 'null', '1', '{"sha":'])('torn and non-object JSON refuses: %s', text => {
    const payload = Buffer.from(text), port = virtual(payload.length, false, payload);
    expect(readMarkerSnapshot('fixture-marker', { io: port.io }).record.corrupt).toBe(true);
  });
  it('read errors refuse; only ENOENT is absence', () => {
    for (const code of ['EACCES', 'ENOENT']) {
      const snapshot = readMarkerSnapshot('fixture-marker', { io: { openSync() { throw Object.assign(new Error('private text'), { code }); } } });
      expect(snapshot.record).toEqual(code === 'ENOENT' ? null : { corrupt: true });
      expect(snapshot.detail || '').not.toContain('private text');
    }
  });
});
