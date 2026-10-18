import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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
