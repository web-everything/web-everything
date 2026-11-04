import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_SETTINGS_PATH, GUARD_FLOOR, resolveAuditSettings } from '../audit-settings.mjs';

const file = audit => () => JSON.stringify({ audit });
const full = (over = {}) => ({ verdict: { mode: 'model' }, preExisting: { mode: 'block', baseRecheckMax: 3 }, releaseStage: 'prerelease',
  raceBlockPaths: [], guardFloorPaths: [], priorQuestionHashes: [], recheck: { max: 1 }, cards: { requireOnMain: true, requirePayBy: true }, ...over });
const resolve = (audit, env = {}) => resolveAuditSettings({ fileRead: file(audit), platform: null, env, log: () => {} });
const STRICT = { verdictMode: 'shadow', preExistingMode: 'block', releaseStage: 'prod', recheckMax: 0, baseRecheckMax: 0, requireOnMain: true, requirePayBy: true };

describe('audit settings (R528)', () => {
  it('reads today\'s choices from the checked-in file in the running checkout', () => {
    expect(AUDIT_SETTINGS_PATH).toMatch(/scripts\/settings\/codex-audit\.json$/);
    const r = resolveAuditSettings({ platform: null, env: {}, log: () => {} });
    expect(r.value).toMatchObject({ verdictMode: 'model', preExistingMode: 'block', releaseStage: 'prerelease', recheckMax: 1, baseRecheckMax: 3, requireOnMain: true, requirePayBy: true });
    expect(r.value.raceBlockPaths).toEqual(GUARD_FLOOR);
  });
  it('unreadable or non-object files resolve to the strictest option everywhere', () => {
    for (const read of [() => { throw new Error('x'); }, () => 'not json', () => '[]', () => '{"audit":[]}', () => '{}']) {
      const r = resolveAuditSettings({ fileRead: read, platform: null, env: {}, log: () => {} });
      expect(r.value).toMatchObject(STRICT);
      expect(r.value.guardFloorPaths).toEqual(GUARD_FLOOR);
    }
  });
  it('an invalid value resolves to that setting\'s strictest option, not a lower layer', () => {
    const r = resolve(full({ verdict: { mode: 'bogus' }, releaseStage: 'dev', recheck: { max: 9 }, preExisting: { mode: 'x', baseRecheckMax: -1 }, cards: { requireOnMain: 'no', requirePayBy: 0 } }));
    expect(r.value).toMatchObject(STRICT);
  });
  it('an explicit empty object at a setting fails closed with a warning, never reads as omitted (PR #6381 red team)', () => {
    const r = resolveAuditSettings({ fileRead: () => JSON.stringify({ audit: { releaseStage: {} } }), platform: null, env: {}, log: () => {} });
    expect(r.value.releaseStage).toBe('prod');
    expect(r.sources.releaseStage).toBe('strictest');
    expect(r.warnings.join()).toMatch(/releaseStage/);
    const all = resolve(full({ verdict: { mode: {} }, releaseStage: {}, recheck: { max: {} }, preExisting: { mode: {}, baseRecheckMax: {} }, cards: { requireOnMain: {}, requirePayBy: {} } }));
    expect(all.value).toMatchObject(STRICT);
    expect(all.warnings.length).toBeGreaterThanOrEqual(7);
  });
  it('a non-object where a section belongs fails closed for every setting under it', () => {
    for (const bad of ['shadow', null, [], 3, true, '']) {
      const r = resolve(full({ verdict: bad, preExisting: bad, recheck: bad, cards: bad }));
      expect(r.value).toMatchObject({ ...STRICT, releaseStage: 'prerelease' });
      expect(r.warnings.length).toBeGreaterThanOrEqual(6);
    }
  });
  it('an empty section is an omitted section (defaults), not a malformed one', () => {
    const r = resolve({ verdict: {}, preExisting: {}, recheck: {}, cards: {} });
    expect(r.value).toMatchObject({ verdictMode: 'model', preExistingMode: 'block', recheckMax: 1, baseRecheckMax: 3, releaseStage: 'prerelease' });
    expect(r.warnings).toEqual([]);
  });
  it('a malformed tool entry is not hidden by a valid platform value beneath it', () => {
    const r = resolveAuditSettings({ fileRead: file({ releaseStage: {}, verdict: 'x' }), platform: { releaseStage: 'prerelease', verdict: { mode: 'computed' } }, env: {}, log: () => {} });
    expect(r.value).toMatchObject({ releaseStage: 'prod', verdictMode: 'shadow' });
  });
  it('a non-object platform layer fails closed instead of reading as omitted', () => {
    for (const plat of ['prerelease', ['x'], 7, false]) {
      const r = resolveAuditSettings({ fileRead: file({}), platform: plat, env: {}, log: () => {} });
      expect(r.value).toMatchObject(STRICT);
      expect(r.warnings).toEqual(['audit platform preference is not an object; every setting resolves to its strictest option']);
    }
  });
  it('a bad platform layer is reported once, with no false per-list warnings, and accepts no hashes', () => {
    const r = resolveAuditSettings({ fileRead: file({}), platform: 'x', env: {}, log: () => {} });
    expect(r.warnings).toHaveLength(1);
    expect(r.value.priorQuestionHashes).toEqual([]);
    expect(r.sources.priorQuestionHashes).toBe('strictest');
    expect(r.value.raceBlockPaths).toEqual(GUARD_FLOOR);
  });
  it('an unreadable tool file accepts no platform hashes', () => {
    const r = resolveAuditSettings({ fileRead: () => { throw new Error('x'); }, platform: { priorQuestionHashes: ['deadbeef'] }, env: {}, log: () => {} });
    expect(r.value.priorQuestionHashes).toEqual([]);
    expect(r.sources.priorQuestionHashes).toBe('strictest');
  });
  describe('platform preferences read from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-settings-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const prefs = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
    const fromDisk = (prefsPath, audit = {}) => resolveAuditSettings({ fileRead: file(audit), env: { WE_PLATFORM_PREFERENCES_FILE: prefsPath }, log: () => {} });
    it('an unreadable or corrupt platform file fails closed instead of reading as unset', () => {
      for (const p of [dir, prefs('truncated.json', '{"audit":{"releaseStage":"prod"} ')]) {
        const r = fromDisk(p);
        expect(r.value).toMatchObject(STRICT);
        expect(r.warnings.join()).toMatch(/platform preference unreadable/);
      }
    });
    it('an explicit "audit": null in the platform file fails closed (as the same null in the tool file does)', () => {
      expect(fromDisk(prefs('null.json', '{"audit":null}')).value).toMatchObject(STRICT);
    });
    it('a valid platform file still supplies values the tool file omits', () => {
      const r = fromDisk(prefs('ok.json', '{"audit":{"recheck":{"max":0}}}'));
      expect(r.value).toMatchObject({ recheckMax: 0, verdictMode: 'model' });
      expect(r.warnings).toEqual([]);
    });
  });
  it('misspelled keys are named in a warning instead of vanishing silently', () => {
    const r = resolve(full({ verdicts: { mode: 'shadow' }, ReleaseStage: 'prod', recheck: { max: 1, Max: 0 }, $note: 'ok' }));
    for (const k of ['"verdicts"', '"ReleaseStage"', '"recheck.Max"']) expect(r.warnings.join()).toContain(k);
    expect(r.warnings.join()).toMatch(/unknown setting/);
    expect(r.warnings.join()).not.toMatch(/\$note/);
    expect(resolve(full()).warnings).toEqual([]);
  });
  it('empty-object path lists and hashes warn instead of vanishing silently', () => {
    const r = resolve(full({ raceBlockPaths: {}, guardFloorPaths: {}, priorQuestionHashes: {} }));
    expect(r.value.raceBlockPaths).toEqual(GUARD_FLOOR);
    expect(r.value.guardFloorPaths).toEqual(GUARD_FLOOR);
    expect(r.value.priorQuestionHashes).toEqual([]);
    expect(r.warnings.join()).toMatch(/raceBlockPaths.*guardFloorPaths.*priorQuestionHashes/s);
  });
  it('allow resolves to block with a warning', () => {
    const r = resolve(full({ preExisting: { mode: 'allow', baseRecheckMax: 3 } }));
    expect(r.value.preExistingMode).toBe('block');
    expect(r.warnings.join()).toMatch(/allow/);
  });
  it('prove is honoured from the file', () => {
    expect(resolve(full({ preExisting: { mode: 'prove', baseRecheckMax: 3 } })).value.preExistingMode).toBe('prove');
  });
  it('env can tighten but never relax', () => {
    const base = full({ verdict: { mode: 'computed' }, releaseStage: 'prod', preExisting: { mode: 'prove', baseRecheckMax: 3 }, recheck: { max: 2 }, cards: { requireOnMain: true, requirePayBy: true } });
    const tight = resolve(base, { WE_AUDIT_VERDICT_MODE: 'shadow', WE_AUDIT_PREEXISTING_MODE: 'block', WE_AUDIT_RECHECK_MAX: '0' });
    expect(tight.value).toMatchObject({ verdictMode: 'shadow', preExistingMode: 'block', recheckMax: 0 });
    expect(tight.sources.verdictMode).toBe('env');
    const loose = resolve(full({ releaseStage: 'prod', verdict: { mode: 'shadow' }, preExisting: { mode: 'block', baseRecheckMax: 1 } }),
      { WE_AUDIT_RELEASE_STAGE: 'prerelease', WE_AUDIT_VERDICT_MODE: 'computed', WE_AUDIT_PREEXISTING_MODE: 'allow', WE_AUDIT_BASE_RECHECK_MAX: '3',
        WE_AUDIT_CARDS_REQUIRE_PAY_BY: 'false' });
    expect(loose.value).toMatchObject({ releaseStage: 'prod', verdictMode: 'shadow', preExistingMode: 'block', baseRecheckMax: 1, requirePayBy: true });
    expect(loose.sources.releaseStage).toBe('file');
    expect(loose.warnings.length).toBeGreaterThanOrEqual(4);
  });
  it('env cannot relax a file value that is already invalid-strict, or garbage env is ignored', () => {
    const r = resolve(full({ releaseStage: 'nope' }), { WE_AUDIT_RELEASE_STAGE: 'prerelease', WE_AUDIT_RECHECK_MAX: 'abc' });
    expect(r.value.releaseStage).toBe('prod');
    expect(r.value.recheckMax).toBe(1);
  });
  it('path lists only add to the built-in floor; bad lists leave the floor', () => {
    const r = resolve(full({ raceBlockPaths: ['custom/**'] }), { WE_AUDIT_GUARD_FLOOR_PATHS: '["env/**"]' });
    expect(r.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'custom/**']);
    expect(r.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'env/**']);
    const bad = resolve(full({ raceBlockPaths: 'x' }), { WE_AUDIT_RACE_BLOCK_PATHS: '{' });
    expect(bad.value.raceBlockPaths).toEqual(GUARD_FLOOR);
  });
  it('prior question hashes have no env route and bad lists are empty', () => {
    expect(resolve(full({ priorQuestionHashes: ['abcdef0123456789'] }), { WE_AUDIT_PRIOR_QUESTION_HASHES: '["deadbeefdeadbeef"]' }).value.priorQuestionHashes).toEqual(['abcdef0123456789']);
    expect(resolve(full({ priorQuestionHashes: ['zz'] })).value.priorQuestionHashes).toEqual([]);
  });
  it('is read from the running checkout, not the cwd or a candidate path argument in env', () => {
    const r = resolveAuditSettings({ platform: null, env: { WE_AUDIT_SETTINGS_PATH: '/tmp/evil.json' }, log: () => {} });
    expect(r.value.releaseStage).toBe('prerelease');
  });
});
