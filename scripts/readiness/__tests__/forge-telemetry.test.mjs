// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {execFile} from 'node:child_process';
import {readForgeTelemetry, main} from '../forge-telemetry.mjs';
import {parseTelemetry, formatTelemetry, stableActiveRunIds} from '../forge-exec-run.mjs';

const A = 'r-' + 'a'.repeat(32), B = 'r-' + 'b'.repeat(32);
const base = {sampledAtET: '2026-11-03T15:00:00.000-05:00', cores: 4, loadPerCore: 0.5, memFreePct: 50, recent: []};
describe('Forge failureTail telemetry', () => {
  const recent={runId:A,startedAtET:base.sampledAtET,stageMs:{install:1234,run:0},code:97};
  const sample=fields=>({...base,activeRuns:0,recent:[{...recent,...fields}]});
  it.each([{}, {prewarmed:false}, {failureTail:'npm ci failed'}, {failureTail:'é'.repeat(256),prewarmed:true}])
  ('accepts legacy entries and optional bounded tails: %j', fields => {
    const value=sample(fields);
    expect(parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it('keeps 50 maximal failure tails inside the 64 KiB telemetry budget', () => {
    const rec=i=>({...recent,runId:'r-'+String(i).padStart(32,'0'),failureTail:'x'.repeat(512)});
    const value={...base,activeRuns:0,recent:Array.from({length:50},(_,i)=>rec(i))};
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(65536);
    expect(()=>parseTelemetry(JSON.stringify(value))).not.toThrow();
  });
  it.each([
    ['oversize ASCII', {failureTail:'x'.repeat(513)}],
    ['oversize UTF-8', {failureTail:'é'.repeat(257)}],
    ['non-string', {failureTail:42}], ['null', {failureTail:null}],
    ['unknown key', {failureTail:'failed',extra:true}],
    ['success', {failureTail:'failed',code:0}], ['running', {failureTail:'failed',code:null}],
  ])('rejects %s with invalid telemetry schema', (_name,fields) => {
    expect(()=>parseTelemetry(JSON.stringify(sample(fields)))).toThrow('Invalid telemetry schema');
  });
  it('preserves failureTail through the SSH reader and JSON formatter; strips controls in terminal output', async () => {
    const value=sample({failureTail:'npm ci failed\nreason\x00'});
    const read=()=>readForgeTelemetry({exec:(_cmd,_args,_options,callback)=>callback(null,JSON.stringify(value),'')});
    expect(await read()).toEqual(value);
    let output='';
    await main(['--json'],{read,write:text=>{output=text;}});
    expect(JSON.parse(output)).toEqual(value);
    await main([],{read,write:text=>{output=text;}});
    expect(output).toContain('\nfailureTail:\nnpm ci failed\nreason\n');
    expect(output).not.toContain('\x00');
  });
});
describe('Forge disk/prune telemetry wire schema', () => {
  it.each([
    {diskUsedPct: 100},
    {prune: {consecutiveRefused: 469, lastRefusal: 'Invalid reserved lock evidence'}},
    {diskUsedPct: 35, prune: {consecutiveRefused: 0, lastRefusal: ''}},
  ])('accepts independently available disk/prune evidence: %j', fields => {
    const sample = {...base, activeRuns: 0, ...fields};
    expect(parseTelemetry(JSON.stringify(sample))).toEqual(sample);
  });
  it.each([
    {diskUsedPct: -1}, {diskUsedPct: 101}, {diskUsedPct: '100'}, {diskUsedPct: null},
    {prune: null}, {prune: {consecutiveRefused: -1, lastRefusal: ''}},
    {prune: {consecutiveRefused: 1.5, lastRefusal: ''}},
    {prune: {consecutiveRefused: 3}},
    {prune: {consecutiveRefused: 3, lastRefusal: 1}},
    {prune: {consecutiveRefused: 3, lastRefusal: 'x'.repeat(201)}},
    {prune: {consecutiveRefused: 3, lastRefusal: '', extra: true}},
  ])('rejects malformed disk/prune evidence: %j', fields => {
    expect(() => parseTelemetry(JSON.stringify({...base, activeRuns: 0, ...fields}))).toThrow('Invalid telemetry schema');
  });
});
describe('R518 telemetry activeRunIds', () => {
  it('accepts a sample without the field (older Forge)', () => {
    expect(parseTelemetry(JSON.stringify({...base, activeRuns: 1}))).toEqual({...base, activeRuns: 1});
  });
  it('accepts activeRunIds matching the count', () => {
    expect(parseTelemetry(JSON.stringify({...base, activeRuns: 2, activeRunIds: [A, B]})).activeRunIds).toEqual([A, B]);
  });
  it.each([
    ['count mismatch', {activeRuns: 1, activeRunIds: [A, B]}],
    ['bad id', {activeRuns: 1, activeRunIds: ['x']}],
    ['duplicate', {activeRuns: 2, activeRunIds: [A, A]}],
    ['not an array', {activeRuns: 0, activeRunIds: null}],
    ['unknown extra key', {activeRuns: 0, activeRunIds: [], extra: 1}],
  ])('rejects %s', (_l, extra) => {
    expect(() => parseTelemetry(JSON.stringify({...base, ...extra}))).toThrow('Invalid telemetry schema');
  });
});

describe('R518 stable active-run listing (audit: one listing can miss a prepared->running rename)', () => {
  const listing = (...rounds) => { let i = 0; return async () => rounds[Math.min(i++, rounds.length - 1)]; };
  it('returns the ids when two consecutive listings agree', async () => {
    expect(await stableActiveRunIds(listing([A + '.running'], [A + '.running']))).toEqual({stable: true, ids: [A], count: 1});
  });
  it('a listing that missed the renamed run is not trusted: it retries until two agree', async () => {
    expect(await stableActiveRunIds(listing([], [A + '.running'], [A + '.running']))).toEqual({stable: true, ids: [A], count: 1});
  });
  it('never stabilising omits the list and never reports a false zero (union count, at least 1)', async () => {
    let n = 0;
    expect(await stableActiveRunIds(async () => (n++ % 2 ? [A + '.running'] : []), 4)).toEqual({stable: false, ids: undefined, count: 1});
  });
  it('a run seen in every listing still counts when another run keeps the listing unstable', async () => {
    let n = 0;
    const r = await stableActiveRunIds(async () => [A + '.running', ...(n++ % 2 ? [B + '.running'] : [])], 4);
    expect(r.stable).toBe(false);
    expect(r.count).toBe(2);
  });
});

const deploy = {forgeSetSha:'a'.repeat(40),setDigest:'b'.repeat(64),hostTier:1};
describe('S0 deploy telemetry schema', () => {
  it.each([undefined,{draining:false},{draining:true},deploy,{...deploy,draining:true},
    {...deploy,forgeSetSha:null,setDigest:null},{...deploy,forgeSetSha:'A'.repeat(40),setDigest:'B'.repeat(64)},
    {...deploy,hostTier:Number.MAX_SAFE_INTEGER}])('accepts old and new deploy blocks: %j', block => {
    const value = {...base,activeRuns:0,...(block === undefined ? {} : {deploy:block})};
    expect(parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it.each([null,[],{},true,{draining:1},{...deploy,draining:null},{...deploy,extra:1},
    {forgeSetSha:deploy.forgeSetSha}, {...deploy,forgeSetSha:42},{...deploy,forgeSetSha:'a'.repeat(39)},
    {...deploy,forgeSetSha:'g'.repeat(40)},{...deploy,setDigest:false},{...deploy,setDigest:'b'.repeat(63)},
    {...deploy,setDigest:'g'.repeat(64)},{...deploy,hostTier:0},{...deploy,hostTier:-1},
    {...deploy,hostTier:1.5},{...deploy,hostTier:'1'},{...deploy,hostTier:Number.MAX_SAFE_INTEGER+1}])
  ('rejects malformed or unknown deploy fields: %j', block => {
    expect(() => parseTelemetry(JSON.stringify({...base,activeRuns:0,deploy:block}))).toThrow('Invalid telemetry schema');
  });
  it('prints exactly one short deploy line only for a non-null SHA', () => {
    const value = {...base,activeRuns:0};
    const legacy = formatTelemetry(value);
    expect(formatTelemetry({...value,deploy:{draining:true}})).toBe(legacy);
    expect(formatTelemetry({...value,deploy:{...deploy,forgeSetSha:null}})).toBe(legacy);
    expect(formatTelemetry({...value,deploy})).toBe(legacy+'\ndeploy '+deploy.forgeSetSha);
  });
});

describe('Forge telemetry cancellation', () => {
  it('passes the polling signal to the executor and aborting kills its child and rejects', async () => {
    const controller = new AbortController();
    let child, exited;
    const pending = readForgeTelemetry({signal: controller.signal, exec: (file, args, options, callback) => {
      expect(file).toBe('ssh');
      expect(options.signal).toBe(controller.signal);
      // Exercise execFile cancellation with a local child instead of contacting Forge.
      child = execFile(process.execPath, ['-e', 'process.stdin.resume()'], options, callback);
      exited = new Promise(resolve => child.once('exit', resolve));
      return child;
    }});
    const rejected = expect(pending).rejects.toThrow('forge-unreachable');
    controller.abort();
    await rejected;
    expect(child.killed).toBe(true);
    await exited;
  });
});
