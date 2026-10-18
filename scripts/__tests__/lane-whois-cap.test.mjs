import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as attribution from '../lib/lane-transcript-attribution.mjs';
import { whois } from '../lane-whois.mjs';

const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'whois-cap-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const admitted = () => ({ admitted: true });
const quiet = () => {};

describe('transcript backfill admission', () => {
  it('overloaded background transcript scan exits 75 without scanning', () => {
    const root = temp();
    const url = pathToFileURL(resolve('scripts/lane-whois.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import os from 'node:os'; import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      os.userInfo = () => ({ homedir: ${JSON.stringify(root)} });
      cp.execFileSync = (file) => { if (file === 'git') return ''; process.stdout.write('SCAN WORK RAN'); throw Error('unexpected subprocess'); };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(resolve('scripts/lane-whois.mjs'))}, '--scan-transcripts', '--lane=1', '--name=fixture', ${JSON.stringify(`--pool-root=${root}`)}];
      await import(${JSON.stringify(url)});
    `], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, VITEST: 'true', WE_TEST_HOST_LOAD1: '1000000' } });
    expect(child.status, child.stderr).toBe(75);
    expect(child.stderr).toContain('transcript scan deferred: host load');
    expect(child.stdout).not.toContain('SCAN WORK RAN');
  });
  it('host overload defers background transcript scanning before any scan starts', async () => {
    const { cachedTranscriptAttribution } = await import('../lib/lane-transcript-backfill.mjs');
    const scan = vi.fn(); const admission = vi.fn(() => ({ admitted: false, reason: 'overload' }));
    expect(() => cachedTranscriptAttribution('unused', { 1: '/pool/1' }, {
      stateRoot: temp(), scan, admission, log: quiet,
    })).toThrow('transcript scan deferred: overload');
    expect(scan).not.toHaveBeenCalled();
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }));
  });
  it('policy can disable explicit transcript scans before admission or scanning', async () => {
    const { cachedTranscriptAttribution } = await import('../lib/lane-transcript-backfill.mjs');
    const scan = vi.fn(); const admission = vi.fn(admitted);
    expect(() => cachedTranscriptAttribution('unused', { 1: '/pool/1' }, {
      stateRoot: temp(), scan, admission, log: quiet,
      env: { WE_LANE_TRANSCRIPT_EXPLICIT_SCAN: 'false' },
    })).toThrow('explicit transcript scan disabled by policy');
    expect(scan).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled();
  });
  it('routine whois never invokes scanLaneTranscripts', () => {
    const scan = vi.spyOn(attribution, 'scanLaneTranscripts').mockReturnValue(new Map());
    whois({ poolDir: temp(), laneNumbers: [1], exec: () => '[]' });
    expect(scan).not.toHaveBeenCalled();
  });
  it('explicit scan works and permanent cache survives a fresh invocation', async () => {
    const { cachedTranscriptAttribution } = await import(/* @vite-ignore */ String('../lib/lane-transcript-backfill.mjs'));
    const stateRoot = temp();
    const lanes = { 1: join(stateRoot, 'lane-1') };
    const touches = [{ sessionId: 'past', ts: '2026-01-01', tool: 'Edit', path: `${lanes[1]}/docs/a.md` }];
    const scan = vi.fn(() => new Map([['1', touches]]));
    const opts = { stateRoot, scan, admission: admitted, log: quiet };
    expect(cachedTranscriptAttribution('unused', lanes, opts).get('1')).toEqual(touches);
    expect(cachedTranscriptAttribution('unused', lanes, { ...opts, scan: () => { throw Error('rescanned'); } }).get('1')).toEqual(touches);
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('rejects an indented cache over the read limit before publishing it and permits retry', async () => {
    const { cachedTranscriptAttribution } = await import(/* @vite-ignore */ String('../lib/lane-transcript-backfill.mjs'));
    const stateRoot = temp();
    const lanes = { 1: '/pool/lane-1' };
    const touches = Array.from({ length: 90_000 }, () => ({ sessionId: 's', ts: null, tool: 'Edit', path: '/pool/lane-1/a' }));
    const saved = { lane: lanes[1], touches };
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(`${JSON.stringify(saved, null, 2)}\n`)).toBeGreaterThan(8 * 1024 * 1024);
    const opts = { stateRoot, admission: admitted, log: quiet };
    expect(() => cachedTranscriptAttribution('unused', lanes, { ...opts, scan: () => new Map([['1', touches]]) })).toThrow('transcript cache too large');
    expect(readdirSync(join(stateRoot, 'transcripts'))).toEqual([]);
    const scan = vi.fn(() => new Map([['1', []]]));
    expect(cachedTranscriptAttribution('unused', lanes, { ...opts, scan }).get('1')).toEqual([]);
    expect(cachedTranscriptAttribution('unused', lanes, { ...opts, scan }).get('1')).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it.each([
    { extraBytes: 0, char: 'a' },
    { extraBytes: 1, char: 'a' },
    { extraBytes: 1, char: 'é' },
  ])('enforces the serialized byte boundary ($extraBytes extra bytes, $char)', async ({ extraBytes, char }) => {
    const { cachedTranscriptAttribution } = await import(/* @vite-ignore */ String('../lib/lane-transcript-backfill.mjs'));
    const stateRoot = temp();
    const lanes = { 1: '/pool/lane-1' };
    const touches = [{ sessionId: 's', ts: null, tool: 'Edit', path: '' }];
    const limit = 8 * 1024 * 1024;
    const baseBytes = Buffer.byteLength(`${JSON.stringify({ lane: lanes[1], touches }, null, 2)}\n`);
    touches[0].path = char + 'a'.repeat(limit + extraBytes - baseBytes - Buffer.byteLength(char));
    const opts = { stateRoot, admission: admitted, log: quiet, scan: vi.fn(() => new Map([['1', touches]])) };
    if (extraBytes > 0) {
      expect(() => cachedTranscriptAttribution('unused', lanes, opts)).toThrow('transcript cache too large');
      expect(readdirSync(join(stateRoot, 'transcripts'))).toEqual([]);
    } else {
      expect(cachedTranscriptAttribution('unused', lanes, opts).get('1')).toEqual(touches);
      const cacheDir = join(stateRoot, 'transcripts');
      expect(statSync(join(cacheDir, readdirSync(cacheDir)[0])).size).toBe(limit);
      expect(cachedTranscriptAttribution('unused', lanes, opts).get('1')).toEqual(touches);
      expect(opts.scan).toHaveBeenCalledTimes(1);
    }
  });
  it('two concurrent explicit scans refuse the second before its grep starts', async () => {
    const { cachedTranscriptAttribution } = await import(/* @vite-ignore */ String('../lib/lane-transcript-backfill.mjs'));
    const stateRoot = temp();
    let secondRan = false;
    const opts = { stateRoot, admission: admitted, log: quiet };
    cachedTranscriptAttribution('unused', { 1: '/old/lane-1' }, { ...opts, scan: () => {
      const url = pathToFileURL(resolve('scripts/lib/lane-transcript-backfill.mjs')).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { cachedTranscriptAttribution } from ${JSON.stringify(url)}; cachedTranscriptAttribution('unused', {2:'/old/lane-2'}, {stateRoot:${JSON.stringify(stateRoot)}, admission:()=>({admitted:true}), log:()=>{}, scan:()=>{process.stdout.write('SECOND GREP RAN');return new Map([['2',[]]])}});`], { encoding: 'utf8', timeout: 5000 });
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain('busy');
      expect(child.stdout).not.toContain('SECOND GREP RAN');
      expect(() => cachedTranscriptAttribution('unused', { 2: '/old/lane-2' }, { ...opts, scan: () => { secondRan = true; return new Map(); } })).toThrow(/busy/);
      return new Map([['1', []]]);
    } });
    expect(secondRan).toBe(false);
  });
  it('scan failures and corrupt cache refuse instead of recording clear attribution', async () => {
    const { cachedTranscriptAttribution } = await import(/* @vite-ignore */ String('../lib/lane-transcript-backfill.mjs'));
    const stateRoot = temp();
    const opts = { stateRoot, admission: admitted, log: quiet };
    expect(() => cachedTranscriptAttribution('unused', { 1: '/old/1' }, { ...opts, scan: () => { throw Error('truncated'); } })).toThrow('truncated');
    const scan = vi.fn(() => new Map([['1', []]]));
    cachedTranscriptAttribution('unused', { 1: '/old/1' }, { ...opts, scan });
    expect(scan).toHaveBeenCalledTimes(1);
    const cacheDir = join(stateRoot, 'transcripts');
    writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]), '{');
    expect(() => cachedTranscriptAttribution('unused', { 1: '/old/1' }, { ...opts, scan })).toThrow();
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('explicit whois uses the backfill path only when requested', () => {
    const scan = vi.fn(() => new Map());
    whois({ poolDir: temp(), laneNumbers: [1], exec: () => '[]', scanTranscripts: true, transcriptBackfill: scan });
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

it('strict diagnostics refuse truncated subprocess output instead of caching clear attribution', () => {
  const exec = vi.fn(() => { throw Object.assign(Error('truncated'), { code: 'ENOBUFS' }); });
  expect(() => attribution.scanLaneTranscripts('/unused', { 1: '/old/1' }, { exec, strict: true, listFiles: () => ['/fake/a.jsonl'] })).toThrow('truncated');
  expect(exec).toHaveBeenCalledTimes(1);
});
