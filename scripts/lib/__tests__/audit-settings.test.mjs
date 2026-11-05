import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_SETTINGS_PATH, GUARD_FLOOR, resolveAuditSettings } from '../audit-settings.mjs';
import { resolvePriorQuestionHashes } from '../../operations/codex-audit.mjs';

const HASH_A = Object.freeze({ hash: 'a'.repeat(64), acceptUntil: '2026-12-01T00:00:00.000Z' });
const HASH_B = Object.freeze({ hash: 'b'.repeat(64), acceptUntil: '2026-12-02T00:00:00.000Z' });

const file = audit => () => JSON.stringify({ audit });
const full = (over = {}) => ({ verdict: { mode: 'model' }, preExisting: { mode: 'block', baseRecheckMax: 3 }, releaseStage: 'prerelease',
  raceBlockPaths: [], guardFloorPaths: [], priorQuestionHashes: [], recheck: { max: 1 }, cards: { requireOnMain: true, requirePayBy: true }, ...over });
const resolve = (audit, env = {}) => resolveAuditSettings({ fileRead: file(audit), platform: null, env, log: () => {} });
const STRICT_PATHS = [...GUARD_FLOOR, '**'];
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
      expect(r.value.guardFloorPaths).toEqual(STRICT_PATHS);
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
    expect(r.value.raceBlockPaths).toEqual(STRICT_PATHS);
  });
  it('an unreadable tool file accepts no platform hashes', () => {
    const r = resolveAuditSettings({ fileRead: () => { throw new Error('x'); }, platform: { priorQuestionHashes: [HASH_A] }, env: {}, log: () => {} });
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
    it('an explicitly configured platform file that is missing fails closed instead of reading as unset (PR #6381 judge)', () => {
      // A relative path resolves against the process cwd, which the auditor does not control: it fails closed too,
      // even when a file of that name exists relative to the cwd.
      for (const missing of [join(dir, 'missing.json'), join(dir, 'no-such-dir', 'prefs.json'), 'package.json', './package.json']) {
        const r = fromDisk(missing, full({ preExisting: { mode: 'prove', baseRecheckMax: 3 } }));
        expect(r.value).toMatchObject(STRICT);
        expect(r.value.guardFloorPaths).toEqual(STRICT_PATHS);
        expect(r.warnings.join()).toMatch(/platform preference unreadable/);
      }
      // A configured file that exists is read normally (the check is about absence, not about being configured).
      expect(fromDisk(prefs('present.json', '{}'), full()).value.releaseStage).toBe('prerelease');
    });
    it('platform path lists are unioned with the tool file lists, never replaced by them (PR #6381 judge)', () => {
      const r = fromDisk(prefs('lists.json', '{"audit":{"raceBlockPaths":["plat-race/**"],"guardFloorPaths":["plat-guard/**"]}}'),
        full({ raceBlockPaths: ['tool-race/**'], guardFloorPaths: ['tool-guard/**'] }));
      expect(r.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'plat-race/**', 'tool-race/**']);
      expect(r.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'plat-guard/**', 'tool-guard/**']);
      expect(r.sources.guardFloorPaths).toBe('file');
      const platOnly = fromDisk(prefs('plat-only.json', '{"audit":{"guardFloorPaths":["plat-guard/**"]}}'), full());
      expect(platOnly.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'plat-guard/**']);
      expect(platOnly.sources.guardFloorPaths).toBe('platform');
      // An invalid platform list still fails closed even when the tool list is valid.
      const bad = fromDisk(prefs('bad-list.json', '{"audit":{"guardFloorPaths":[""]}}'), full({ guardFloorPaths: ['tool-guard/**'] }));
      expect(bad.value.guardFloorPaths).toEqual(STRICT_PATHS);
    });
  });
  it('env preExisting mode allow resolves to block, even over a file prove (PR #6381 judge)', () => {
    for (const fileMode of ['prove', 'block']) {
      const r = resolve(full({ preExisting: { mode: fileMode, baseRecheckMax: 3 } }), { WE_AUDIT_PREEXISTING_MODE: 'allow' });
      expect(r.value.preExistingMode).toBe('block');
      expect(r.sources.preExistingMode).toBe('env');
      expect(r.warnings.join()).toMatch(/allow resolves to block/);
    }
  });
  it('misspelled keys are named in a warning instead of vanishing silently', () => {
    const r = resolve(full({ verdicts: { mode: 'shadow' }, ReleaseStage: 'prod', recheck: { max: 1, Max: 0 }, $note: 'ok' }));
    for (const k of ['"verdicts"', '"ReleaseStage"', '"recheck.Max"']) expect(r.warnings.join()).toContain(k);
    expect(r.warnings.join()).toMatch(/unknown setting/);
    expect(r.warnings.join()).not.toMatch(/\$note/);
    expect(resolve(full()).warnings).toEqual([]);
  });
  it('a key that differs from a setting only by case fails that setting closed, never reads as omitted (PR #6381)', () => {
    const top = resolveAuditSettings({ fileRead: file({ ReleaseStage: 'prod' }), platform: null, env: {}, log: () => {} });
    expect(top.value.releaseStage).toBe('prod');
    expect(top.sources.releaseStage).toBe('strictest');
    expect(top.warnings.join()).toMatch(/releaseStage unreadable or invalid/);
    const all = resolve(full({ releaseStage: 'prerelease', RELEASESTAGE: 'prerelease', recheck: { max: 1, Max: 1 }, Verdict: { mode: 'model' },
      preExisting: { mode: 'block', baseRecheckMax: 3, BaseRecheckMax: 3 }, Cards: 'x' }));
    expect(all.value).toMatchObject({ releaseStage: 'prod', recheckMax: 0, verdictMode: 'shadow', baseRecheckMax: 0 });
    expect(all.sources).toMatchObject({ releaseStage: 'strictest', recheckMax: 'strictest', verdictMode: 'strictest', baseRecheckMax: 'strictest',
      requireOnMain: 'strictest', requirePayBy: 'strictest' });
    expect(all.sources.preExistingMode).toBe('file');
    const plat = resolveAuditSettings({ fileRead: file(full()), platform: { releasestage: 'prod' }, env: {}, log: () => {} });
    expect(plat.value.releaseStage).toBe('prod');
    expect(plat.sources.releaseStage).toBe('strictest');
    const hashes = resolve(full({ priorQuestionHashes: [HASH_A], PriorQuestionHashes: [] }));
    expect(hashes.value.priorQuestionHashes).toEqual([]);
  });
  it.each(['releaseStage ', 'releaseStage\u200B', 'ｒeleaseStage', 'releaſeStage', ' release\tStage'])(
    'a whitespace, invisible or compatibility-form variant %j of a setting key fails it closed (PR #6381)', k => {
      const r = resolveAuditSettings({ fileRead: file({ [k]: 'prerelease' }), platform: null, env: {}, log: () => {} });
      expect(r.value.releaseStage).toBe('prod');
      expect(r.sources.releaseStage).toBe('strictest');
    });
  it('section-level whitespace variants fail the setting closed (PR #6381)', () => {
    for (const audit of [{ verdict: { 'mode ': 'computed' } }, { 'verdict ': { mode: 'computed' } }]) {
      const r = resolveAuditSettings({ fileRead: file(audit), platform: null, env: {}, log: () => {} });
      expect(r.value.verdictMode).toBe('shadow');
      expect(r.sources.verdictMode).toBe('strictest');
    }
  });
  it('empty-object path lists and hashes warn instead of vanishing silently', () => {
    const r = resolve(full({ raceBlockPaths: {}, guardFloorPaths: {}, priorQuestionHashes: {} }));
    expect(r.value.raceBlockPaths).toEqual(STRICT_PATHS);
    expect(r.value.guardFloorPaths).toEqual(STRICT_PATHS);
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
  it('env cannot relax a file value that is already invalid-strict, and an invalid env value resolves to strictest', () => {
    const r = resolve(full({ releaseStage: 'nope' }), { WE_AUDIT_RELEASE_STAGE: 'prerelease', WE_AUDIT_RECHECK_MAX: 'abc' });
    expect(r.value.releaseStage).toBe('prod');
    expect(r.value.recheckMax).toBe(0);
    expect(r.sources.recheckMax).toBe('strictest');
  });
  it.each([
    ['WE_AUDIT_VERDICT_MODE', 'verdictMode', 'bogus'], ['WE_AUDIT_VERDICT_MODE', 'verdictMode', ''],
    ['WE_AUDIT_PREEXISTING_MODE', 'preExistingMode', 'Prove'], ['WE_AUDIT_RELEASE_STAGE', 'releaseStage', 'dev'],
    ['WE_AUDIT_RECHECK_MAX', 'recheckMax', '9'], ['WE_AUDIT_RECHECK_MAX', 'recheckMax', '-1'], ['WE_AUDIT_BASE_RECHECK_MAX', 'baseRecheckMax', '1.5'],
    ['WE_AUDIT_CARDS_REQUIRE_ON_MAIN', 'requireOnMain', 'no'], ['WE_AUDIT_CARDS_REQUIRE_PAY_BY', 'requirePayBy', 'FALSE'],
  ])('an invalid env %s=%j resolves %s to its strictest option (PR #6381)', (name, key, raw) => {
    const r = resolve(full({ preExisting: { mode: 'prove', baseRecheckMax: 3 }, cards: { requireOnMain: true, requirePayBy: true } }), { [name]: raw });
    expect(r.value[key]).toBe(STRICT[key]);
    expect(r.sources[key]).toBe('strictest');
    expect(r.warnings.join()).toMatch(new RegExp(`${name}.*invalid`));
  });
  it('path lists only add to the built-in floor; an invalid list protects every path', () => {
    const r = resolve(full({ raceBlockPaths: ['custom/**'] }), { WE_AUDIT_GUARD_FLOOR_PATHS: '["env/**"]' });
    expect(r.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'custom/**']);
    expect(r.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'env/**']);
    const bad = resolve(full({ raceBlockPaths: 'x' }), { WE_AUDIT_RACE_BLOCK_PATHS: '{' });
    expect(bad.value.raceBlockPaths).toEqual([...GUARD_FLOOR, '**']);
    expect(bad.sources.raceBlockPaths).toBe('strictest');
    for (const raw of ['{', '"x"', '[""]', '[3]', '{}']) {
      const e = resolve(full({ guardFloorPaths: ['custom/**'] }), { WE_AUDIT_GUARD_FLOOR_PATHS: raw });
      expect(e.value.guardFloorPaths, raw).toEqual([...GUARD_FLOOR, '**', 'custom/**']);
    }
  });
  it('the built-in floor and the shipped file hold the guard hooks and the lane lease (PR #6381 red team)', () => {
    for (const p of ['scripts/guard-*', 'scripts/lib/lane-lease.mjs', '.claude/settings.json']) expect(GUARD_FLOOR).toContain(p);
    const shipped = resolveAuditSettings({ platform: null, env: {}, log: () => {} });
    expect(shipped.sources.guardFloorPaths).toBe('file');
    expect(shipped.value.guardFloorPaths).toEqual(expect.arrayContaining(['scripts/guard-*', 'scripts/lib/lane-lease.mjs']));
  });
  it('prior question hashes have no env route and bad lists are empty', () => {
    expect(resolve(full({ priorQuestionHashes: [HASH_A] }), { WE_AUDIT_PRIOR_QUESTION_HASHES: JSON.stringify([HASH_B]) }).value.priorQuestionHashes).toEqual([HASH_A]);
    expect(resolve(full({ priorQuestionHashes: ['zz'] })).value.priorQuestionHashes).toEqual([]);
  });
  // PR #6381 merge with AU1 PR-B: findAudit reads this same key through codex-audit.mjs. Both readers must agree on
  // the record shape and on which layers may set it, or the first real entry is dropped by one of them.
  it.each([
    ['a valid record list', [HASH_A, HASH_B]],
    ['a bare-string list (the old shape)', ['a'.repeat(64)]],
    ['a short hash', [{ hash: 'abcdef12', acceptUntil: '2026-12-01T00:00:00.000Z' }]],
    ['an uppercase hash', [{ hash: 'A'.repeat(64), acceptUntil: '2026-12-01T00:00:00.000Z' }]],
    ['a hash with a trailing newline', [{ hash: `${'a'.repeat(64)}\n`, acceptUntil: '2026-12-01T00:00:00.000Z' }]],
    ['an unparseable acceptUntil', [{ hash: 'a'.repeat(64), acceptUntil: 'soon' }]],
    ['one invalid entry among valid ones', [HASH_A, { hash: 'zz', acceptUntil: '2026-12-01' }]],
    ['an empty list', []],
  ])('the audit resolver and findAudit read %s identically (PR #6381 merge)', (_, list) => {
    const read = () => JSON.stringify({ audit: { priorQuestionHashes: list } });
    const ours = resolveAuditSettings({ fileRead: read, platform: null, env: {}, log: () => {} }).value.priorQuestionHashes;
    expect(ours).toEqual(resolvePriorQuestionHashes({ readFile: read, env: {} }));
  });
  it('platform prior question hashes never widen acceptance, as findAudit ignores them (PR #6381 merge)', () => {
    const platform = { priorQuestionHashes: [HASH_B] };
    const none = resolveAuditSettings({ fileRead: file(full()), platform, env: {}, log: () => {} });
    expect(none.value.priorQuestionHashes).toEqual([]);
    expect(none.warnings.join()).toMatch(/platform preference priorQuestionHashes ignored/);
    const own = resolveAuditSettings({ fileRead: file(full({ priorQuestionHashes: [HASH_A] })), platform, env: {}, log: () => {} });
    expect(own.value.priorQuestionHashes).toEqual([HASH_A]);
    expect(own.sources.priorQuestionHashes).toBe('file');
    // A case or invisible-character variant of the key in the platform layer is ignored the same way.
    const shadow = resolveAuditSettings({ fileRead: file(full()), platform: { PriorQuestionHashes: [HASH_B] }, env: {}, log: () => {} });
    expect(shadow.value.priorQuestionHashes).toEqual([]);
  });
  it('the shipped settings file reads the same prior question hashes through both readers (PR #6381 merge)', () => {
    expect(resolveAuditSettings({ platform: null, env: {}, log: () => {} }).value.priorQuestionHashes).toEqual(resolvePriorQuestionHashes({ env: {} }));
  });
  it('is read from the running checkout, not the cwd or a candidate path argument in env', () => {
    const r = resolveAuditSettings({ platform: null, env: { WE_AUDIT_SETTINGS_PATH: '/tmp/evil.json' }, log: () => {} });
    expect(r.value.releaseStage).toBe('prerelease');
  });
});
