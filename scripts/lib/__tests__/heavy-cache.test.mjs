import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY, HEAVY, identityOf, validHeavy, makeEntry, loadBounds, whyNotReuse, mayReuse,
  readHeavyPinned, loadHeavyStore, saveHeavyStore } from '../heavy-cache.mjs';
import { markPrSnapshotDirty } from '../pr-snapshot-store.mjs';
import { LISTED_FILES_CAP } from '../red-main-quarantine.mjs';

// Deterministic seeded rows; each property case changes exactly one field.
let seed = 1701;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const row = () => ({ number: next() + 1, headRefOid: next().toString(16).padStart(40, 'a'),
  baseRefOid: next().toString(16).padStart(40, 'b'), baseRefName: 'main', updatedAt: '2026-11-25T12:00:00Z', labelsComplete: true });
const heavy = () => ({ body: 'body', files: [{ path: 'src/a.mjs' }] });
const stamp = Date.parse('2026-11-25T12:00:00Z');
const bounds = () => loadBounds({ heavyBackstopSeconds: 3600, heavySettleSeconds: 1 });
const invalid = field => [undefined, null, '', ...(field === 'number' ? ['1', 0, -1, 1.5, NaN] : [123]),
  ...(['headRefOid','baseRefOid'].includes(field) ? ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40)] : []),
  ...(field === 'updatedAt' ? ['NaN','2026-11-25','2026-11-25T12:00:00.000Z'] : [])];

const badHeavy = () => [null, ...[null, undefined, 1, {}, []].map(body => ({...heavy(),body})),
  ...[null, {}, [null], [{}], [{path:''}], [{path:1}], [new (class File {path='a';})()],
    Array.from({length:LISTED_FILES_CAP}, () => ({path:'a'}))].map(files => ({body:'',files}))];

const storeFile = (dir, repo) => join(dir, `heavy-${createHash('sha256').update(repo.toLowerCase()).digest('hex')}.json`);
let snapshotDir;
beforeEach(() => {
 snapshotDir = mkdtempSync(join(process.env.TMPDIR, 'heavy-isolated-'));
 vi.stubEnv('WE_PR_SNAPSHOT_DIR', snapshotDir);
 vi.stubEnv('WE_PR_SNAPSHOT', '1');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(snapshotDir, {recursive:true,force:true}); });
describe('heavy-cache', () => {
  it('P1 every identity field missing, null, empty, wrong-typed or malformed: makeEntry throws and mayReuse is false', () => {
    for (const field of IDENTITY) for (const value of invalid(field)) {
      const r = { ...row(), [field]: value };
      expect(identityOf(r)).toBeNull();
      expect(() => makeEntry(r, heavy(), stamp + 5000)).toThrow(TypeError);
      expect(mayReuse(r, r, stamp + 6000, bounds())).toBe(false);
      delete r[field]; expect(identityOf(r)).toBeNull();
    }
    for (const h of badHeavy()) {
      expect(validHeavy(h)).toBe(false);
      expect(() => makeEntry(row(), h, stamp)).toThrow(TypeError);
    }
    for (const t of [NaN, Infinity, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) expect(() => makeEntry(row(), heavy(), t)).toThrow(TypeError);
    expect(HEAVY).toEqual(['body','files']);
  });
  it('P2 any single identity field mismatched between entry and live row: no reuse', () => {
    const r = row(), e = makeEntry(r, heavy(), stamp + 5000);
    const changes = { number:r.number+1, headRefOid:'c'.repeat(40), baseRefOid:'d'.repeat(40), baseRefName:'other', updatedAt:'2026-11-24T12:00:00Z' };
    for (const field of IDENTITY) expect(whyNotReuse(e, {...r,[field]:changes[field]}, stamp+6000, bounds())).toBe(field === 'baseRefOid' ? 'base-only' : 'identity');
  });
  it('P3 live row is validated too, including null equal to null', () => {
    const r = row(), e = makeEntry(r, heavy(), stamp + 5000);
    for (const field of IDENTITY) for (const value of invalid(field)) {
      const live = {...r,[field]:value};
      expect(whyNotReuse(e, live, stamp+6000, bounds())).toBe('row-invalid');
      expect(mayReuse({...e,[field]:value}, live, stamp+6000, bounds())).toBe(false);
    }
  });
  it('P4 an object not made by makeEntry (spread, JSON round-trip, seeded) is never reused', () => {
    const r = row(), e = makeEntry(r, heavy(), stamp+5000);
    for (const copy of [{...e}, structuredClone(e), JSON.parse(JSON.stringify(e)), {...e,body:'other'}]) expect(whyNotReuse(copy,r,stamp+6000,bounds())).toBe('new');
    const dir = mkdtempSync(join(process.env.TMPDIR,'heavy-cache-'));
    try {
      saveHeavyStore({repo:'owner/name',dir,entries:new Map([[r.number,e]])});
      expect(mayReuse(loadHeavyStore({repo:'owner/name',dir}).entries.get(r.number),r,stamp+6000,bounds())).toBe(true);
      writeFileSync(storeFile(dir,'owner/name'), JSON.stringify({entries:[{...e,repo:'owner/name'},{...e,repo:'owner/name',number:null}]}));
      const loaded = loadHeavyStore({repo:'owner/name',dir});
      expect(loaded.dropped).toBe(1); expect(loaded.entries.size).toBe(1);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('P5 invalid or unbranded bounds and boundary ages refuse reuse', () => {
    const r = row(), e = makeEntry(r,heavy(),stamp+5000);
    for (const field of ['heavyBackstopSeconds','heavySettleSeconds']) for (const value of [undefined,null,NaN,-1,1.5,'3600',field === 'heavyBackstopSeconds' ? 604801 : 301]) {
      const b = loadBounds({heavyBackstopSeconds:3600,heavySettleSeconds:1,[field]:value});
      expect(b).toBeNull(); expect(whyNotReuse(e,r,stamp+6000,b)).toBe('bounds');
    }
    expect(whyNotReuse(e,r,stamp+6000,{backstopMs:3600000,settleMs:1000})).toBe('bounds');
    const b = loadBounds({heavyBackstopSeconds:300,heavySettleSeconds:1});
    for (const age of [-1,300000,301000,NaN]) expect(whyNotReuse(e,r,e.fetchedAtMs+age,b)).toBe('age');
    expect(mayReuse(e,r,e.fetchedAtMs+299000,b)).toBe(true);
    expect(mayReuse(e,r,e.fetchedAtMs,loadBounds({heavyBackstopSeconds:0,heavySettleSeconds:1}))).toBe(false);
  });
  it('P6 settle refuses reads made 0 or 999 ms into updatedAt second', () => {
    const r = row();
    for (const delay of [0,999,1000]) expect(whyNotReuse(makeEntry(r,heavy(),stamp+delay),r,stamp+6000,bounds())).toBe(delay < 1000 ? 'unsettled' : null);
    expect(whyNotReuse(makeEntry(r,heavy(),stamp+5000),{...r,labelsComplete:false},stamp+6000,bounds())).toBe('labels');
  });
  it('P7 readHeavyPinned refuses moved and malformed reads', () => {
    const r = row();
    for (const field of IDENTITY) {
      const other = {...r,...heavy(),[field]: field === 'number' ? r.number+1 : field === 'updatedAt' ? '2026-11-24T12:00:00Z' : field === 'baseRefName' ? 'other' : 'f'.repeat(40)};
      expect(() => readHeavyPinned(r,JSON.stringify(other),stamp+5000)).toThrow('moved');
      for (const value of invalid(field)) expect(() => readHeavyPinned(r,JSON.stringify({...r,...heavy(),[field]:value}),stamp+5000)).toThrow('malformed');
    }
    for (const h of badHeavy().filter(h => !h?.files?.some?.(f => f?.constructor?.name === 'File'))) expect(() => readHeavyPinned(r,JSON.stringify({...r,...h}),stamp+5000)).toThrow('malformed');
    for (const data of ['{', '{}', JSON.stringify({...r,body:'',files:[{}]})]) expect(() => readHeavyPinned(r,data,stamp+5000)).toThrow('malformed');
    expect(mayReuse(readHeavyPinned(r,JSON.stringify({...r,...heavy()}),stamp+5000),r,stamp+6000,bounds())).toBe(true);
  });
  it('P8 entry, identity and file copies are frozen', () => {
    const r = row(), h = heavy(), e = makeEntry(r,h,stamp+5000);
    expect(Object.isFrozen(identityOf(r))).toBe(true); expect(Object.isFrozen(e)).toBe(true);
    expect(() => {e.files[0].path='changed';}).toThrow(TypeError);
    expect(() => {e.files.push({path:'x'});}).toThrow(TypeError);
    h.files[0].path='source changed'; expect(e.files[0].path).toBe('src/a.mjs');
  });
});

describe('heavy store isolation', () => {
  it.each(['disabled', 'under-test', 'fake-gh'])('%s loads empty and saves nothing even with an explicit dir argument', kind => {
    const repo = 'owner/name', r = row(), entries = new Map([[r.number, makeEntry(r, heavy(), stamp + 5000)]]);
    saveHeavyStore({repo, dir:snapshotDir, entries});
    const path = storeFile(snapshotDir, repo), before = readFileSync(path, 'utf8');
    if (kind === 'disabled') vi.stubEnv('WE_PR_SNAPSHOT', '0');
    else {
      vi.stubEnv('WE_PR_SNAPSHOT_DIR', '');
      if (kind === 'fake-gh') {
        vi.stubEnv('VITEST', ''); vi.stubEnv('WE_UNDER_TEST', ''); vi.stubEnv('FAKE_GH_FIXTURE', 'fixture');
      }
    }
    expect(loadHeavyStore({repo, dir:snapshotDir})).toEqual({entries:new Map(), dropped:0});
    saveHeavyStore({repo, dir:snapshotDir, entries:new Map()});
    expect(readFileSync(path, 'utf8')).toBe(before);
    saveHeavyStore({repo:'absent/repo', dir:snapshotDir, entries});
    expect(readdirSync(snapshotDir)).toEqual([path.split('/').at(-1)]);
  });
  it.each(['owner/name', null])('a %s dirty marker drops and counts the store until fresh reads replace it', dirtyRepo => {
    const repo = 'owner/name', r = row();
    const entries = new Map([[r.number, makeEntry(r, heavy(), stamp + 5000)]]);
    saveHeavyStore({repo, entries});
    expect(markPrSnapshotDirty({repo:dirtyRepo, nowMs:stamp+6000})).toBe(true);
    expect(loadHeavyStore({repo})).toEqual({entries:new Map(), dropped:1});
    saveHeavyStore({repo, entries:new Map([[r.number, makeEntry(r, heavy(), stamp+7000)]])});
    expect(loadHeavyStore({repo}).entries.size).toBe(1);
  });
  it('another repo dirty marker does not invalidate this repo', () => {
    const r = row();
    saveHeavyStore({repo:'owner/name', entries:new Map([[r.number, makeEntry(r, heavy(), stamp+5000)]])});
    markPrSnapshotDirty({repo:'other/repo', nowMs:stamp+6000});
    expect(loadHeavyStore({repo:'owner/name'}).entries.size).toBe(1);
  });
  it('formerly colliding slugs persist independently and normalize case', () => {
    const r = row();
    for (const repo of ['a-b/c', 'a/b-c']) saveHeavyStore({repo, entries:new Map([[r.number,makeEntry(r,{...heavy(),body:repo},stamp+5000)]])});
    expect(readdirSync(snapshotDir)).toHaveLength(2);
    for (const repo of ['a-b/c', 'a/b-c']) {
      const loaded = loadHeavyStore({repo:repo.toUpperCase()});
      expect(loaded.entries.get(r.number).body).toBe(repo);
      expect(JSON.parse(readFileSync(storeFile(snapshotDir,repo),'utf8')).entries[0].repo).toBe(repo);
    }
  });
  it('drops and counts foreign and historical unbound records even with identical PR identity', () => {
    const repo = 'owner/name', r = row(), e = makeEntry(r,heavy(),stamp+5000);
    writeFileSync(storeFile(snapshotDir,repo),JSON.stringify({entries:[{...e,repo:'other/repo'},e]}));
    expect(loadHeavyStore({repo})).toEqual({entries:new Map(), dropped:2});
  });
});
