import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY, HEAVY, identityOf, validHeavy, makeEntry, loadBounds, whyNotReuse, mayReuse,
  readHeavyPinned, loadHeavyStore, saveHeavyStore } from '../heavy-cache.mjs';
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
      writeFileSync(join(dir,'heavy-owner-name.json'), JSON.stringify({entries:[e,{...e,number:null}]}));
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
