import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_SETTINGS_ENV, AUDIT_SETTINGS_PATH, GUARD_FLOOR, resolveAuditSettings } from '../audit-settings.mjs';
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
  it.each(['raceBlockPaths', 'guardFloorPaths'])('strict path grammar rejects malformed %s at settings load', key => {
    for (const pattern of ['custom/a+b.mjs', '---a/scripts/x.mjs']) {
      for (const layer of ['file', 'platform', 'env']) {
        expect(() => resolveAuditSettings({
          fileRead: file(full(layer === 'file' ? { [key]: [pattern] } : {})),
          platform: layer === 'platform' ? { [key]: [pattern] } : null,
          env: layer === 'env' ? { [AUDIT_SETTINGS_ENV[key]]: JSON.stringify([pattern]) } : {},
          log: () => {},
        }), `${layer}: ${pattern}`).toThrow(/malformed protected pattern/);
      }
    }
  });

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
    // The default platform chain (read when an override is set, to union its path lists) is faked: only the
    // override file is read from disk, every default-chain file is absent unless `chain` names its body.
    const platformRead = (override, chain = {}) => (p, enc) => {
      if (p === override) return readFileSync(p, enc);
      for (const [suffix, body] of Object.entries(chain)) if (p.endsWith(suffix)) return body;
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    };
    const fromDisk = (prefsPath, audit = {}, chain = {}) => resolveAuditSettings({ fileRead: file(audit),
      env: { WE_PLATFORM_PREFERENCES_FILE: prefsPath }, platformRead: platformRead(prefsPath, chain), log: () => {} });
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
      // A configured file that exists and holds an `audit` object is read normally.
      expect(fromDisk(prefs('present.json', '{"audit":{}}'), full()).value.releaseStage).toBe('prerelease');
    });
    it('an override file with no object "audit" fails closed instead of dropping the platform chain (PR #6381 judge)', () => {
      // A package.json-like file: it parses, but sets no audit preference, so the override would silently replace the
      // whole default platform chain (and its added protected paths) with nothing.
      const chain = { 'delivery-platform-preferences.json': '{"audit":{"guardFloorPaths":["custom/**"]}}' };
      for (const body of ['{"name":"pkg","version":"1.0.0","scripts":{}}', '{}', '{"audit":null}', '{"audit":"prod"}', '{"audit":[]}']) {
        const r = fromDisk(prefs('pkg-like.json', body), full(), chain);
        expect(r.value).toMatchObject(STRICT);
        // Every path is protected; the chain's own addition is kept as well, never dropped.
        expect(r.value.guardFloorPaths).toEqual([...STRICT_PATHS, 'custom/**']);
        expect(r.value.raceBlockPaths).toEqual(STRICT_PATHS);
        expect(r.warnings.join()).toMatch(/platform preference unreadable/);
      }
    });
    it('an override file adds to the default chain path lists, never removes them (PR #6381 judge)', () => {
      const chain = { 'delivery-platform-preferences.json': '{"audit":{"raceBlockPaths":["custom/**"],"guardFloorPaths":["custom/**"]}}' };
      const r = fromDisk(prefs('override.json', '{"audit":{"raceBlockPaths":["other/**"],"guardFloorPaths":["other/**"]}}'), full(), chain);
      expect(r.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'custom/**', 'other/**']);
      expect(r.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'custom/**', 'other/**']);
      expect(r.warnings).toEqual([]);
      // The operator-owned file in the default chain counts too, and an override with no lists keeps the chain lists.
      const op = { [join('.claude', 'platform-preferences.json')]: '{"audit":{"guardFloorPaths":["op/**"]}}' };
      expect(fromDisk(prefs('override-empty.json', '{"audit":{}}'), full(), op).value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'op/**']);
      // An unreadable or invalid default chain still fails closed under an override.
      const broken = fromDisk(prefs('override-2.json', '{"audit":{}}'), full(), { 'delivery-platform-preferences.json': '{"audit":' });
      expect(broken.value).toMatchObject(STRICT);
      expect(broken.warnings.join()).toMatch(/platform preference unreadable/);
      const badList = fromDisk(prefs('override-3.json', '{"audit":{}}'), full(), { 'delivery-platform-preferences.json': '{"audit":{"guardFloorPaths":[""]}}' });
      expect(badList.value.guardFloorPaths).toEqual(STRICT_PATHS);
    });
    it('a later default-chain file adds to an earlier one path lists, never replaces them (PR #6381 self-review)', () => {
      // The reader merges chain files leaf by leaf and an array is one leaf, so the operator file's list replaced the
      // repo file's and the repo file's replaced the legacy file's: protected paths vanished with no warning.
      const chain = { 'delivery-priority-settings.json': '{"audit":{"guardFloorPaths":["legacy/**"]}}',
        'delivery-platform-preferences.json': '{"audit":{"raceBlockPaths":["custom/**"],"guardFloorPaths":["custom/**"]}}',
        [join('.claude', 'platform-preferences.json')]: '{"audit":{"raceBlockPaths":[],"guardFloorPaths":["op/**"]}}' };
      const fromChain = (env = {}, read = platformRead('', chain)) => resolveAuditSettings({ fileRead: file(full()), env, platformRead: read, log: () => {} });
      const plain = fromChain();
      expect(plain.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'custom/**']);
      expect(plain.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'legacy/**', 'custom/**', 'op/**']);
      expect(plain.warnings).toEqual([]);
      // Under an override the same holds: the override adds to every chain file's list.
      const override = prefs('chain-override.json', '{"audit":{"raceBlockPaths":["other/**"]}}');
      const over = fromChain({ WE_PLATFORM_PREFERENCES_FILE: override }, platformRead(override, chain));
      expect(over.value.raceBlockPaths).toEqual([...GUARD_FLOOR, 'custom/**', 'other/**']);
      expect(over.value.guardFloorPaths).toEqual([...GUARD_FLOOR, 'legacy/**', 'custom/**', 'op/**']);
      // An invalid list in a chain file that a later file hides still fails closed.
      const hidden = { ...chain, 'delivery-priority-settings.json': '{"audit":{"guardFloorPaths":[""]}}' };
      expect(fromChain({}, platformRead('', hidden)).value.guardFloorPaths).toEqual(STRICT_PATHS);
    });
    it('an override file may tighten the default chain single-value settings, never loosen them (PR #6381 self-review)', () => {
      const chain = { 'delivery-platform-preferences.json': '{"audit":{"recheck":{"max":0},"releaseStage":"prod","cards":{"requirePayBy":true}}}' };
      const looser = fromDisk(prefs('loose.json', '{"audit":{"recheck":{"max":3},"releaseStage":"prerelease","cards":{"requirePayBy":false}}}'), {}, chain);
      expect(looser.value).toMatchObject({ recheckMax: 0, releaseStage: 'prod', requirePayBy: true });
      // A chain value the override omits still applies; a stricter override value wins.
      const omits = fromDisk(prefs('omits.json', '{"audit":{"verdict":{"mode":"shadow"}}}'), {}, chain);
      expect(omits.value).toMatchObject({ recheckMax: 0, releaseStage: 'prod', verdictMode: 'shadow' });
      const loose = { 'delivery-platform-preferences.json': '{"audit":{"recheck":{"max":2}}}' };
      expect(fromDisk(prefs('tight.json', '{"audit":{"recheck":{"max":1}}}'), {}, loose).value.recheckMax).toBe(1);
      // A malformed chain value fails that setting closed under an override.
      const bad = { 'delivery-platform-preferences.json': '{"audit":{"recheck":{"max":"x"}}}' };
      expect(fromDisk(prefs('any.json', '{"audit":{}}'), {}, bad).value.recheckMax).toBe(0);
    });
    it('a chain preExisting mode allow is the floor block, so an override prove cannot loosen it (PR #6381 policy send-back)', () => {
      // allow resolves to block, so it ranks with block, not below prove: comparing the raw labels let an override's
      // prove pass as tighter than the chain's allow and relax the effective block to prove.
      const chainOf = mode => ({ 'delivery-platform-preferences.json': `{"audit":{"preExisting":{"mode":"${mode}"}}}` });
      const mode = (overrideMode, chainMode) => fromDisk(prefs(`pre-${overrideMode}-${chainMode}.json`,
        `{"audit":{"preExisting":{"mode":"${overrideMode}"}}}`), {}, chainOf(chainMode)).value.preExistingMode;
      expect(mode('prove', 'allow')).toBe('block');
      expect(mode('prove', 'block')).toBe('block');
      expect(mode('allow', 'prove')).toBe('block');
      expect(mode('block', 'allow')).toBe('block');
      // A chain that omits the mode, or sets prove, leaves an override prove in place.
      expect(mode('prove', 'prove')).toBe('prove');
      expect(fromDisk(prefs('pre-omit.json', '{"audit":{"preExisting":{"mode":"prove"}}}'), {}).value.preExistingMode).toBe('prove');
    });
    // PR #6381 judge (R10): a platform key `Audit`, or `audit` with an invisible character, was ignored, so its stricter
    // preferences (releaseStage prod, protected paths) were dropped with no warning. It now fails closed.
    describe('a platform key that only normalises to "audit" fails closed (PR #6381 judge)', () => {
      // Invisible control characters (DEL, C1 controls), format characters and the blank braille cell count too.
      // Built from code points: a raw invisible character in source is refused by check:standards.
      const cp = n => String.fromCodePoint(n);
      const variants = ['Audit', `audit${cp(0x200b)}`, 'AUDIT', `${cp(0x200b)}audit`, `au${cp(0xad)}dit`, `${cp(0xff41)}udit`, ' audit',
        `audit${cp(0x7f)}`, `audit${cp(0x85)}`, `audit${cp(0x9f)}`, `audit${cp(0x2800)}`, `audit${cp(0x600)}`];
      const body = (key, extra = '') => `{${extra}${JSON.stringify(key)}:{"releaseStage":"prod","raceBlockPaths":["custom/**"]}}`;
      const fromChain = chain => resolveAuditSettings({ fileRead: file(full()), env: {}, platformRead: platformRead('', chain), log: () => {} });
      it.each(variants)('the default-chain platform key %j resolves strictest with a warning', key => {
        for (const extra of ['', '"audit":{},']) {
          const r = fromChain({ 'delivery-platform-preferences.json': body(key, extra) });
          expect(r.value).toMatchObject(STRICT);
          expect(r.value.raceBlockPaths).toEqual(STRICT_PATHS);
          expect(r.warnings.join()).toMatch(/platform preference unreadable/);
          expect(r.warnings.join()).toMatch(/variant of "audit"/);
        }
      });
      it.each(variants)('an override file with the key %j beside "audit" resolves strictest with a warning', key => {
        const r = fromDisk(prefs('variant.json', body(key, '"audit":{},')), full());
        expect(r.value).toMatchObject(STRICT);
        expect(r.warnings.join()).toMatch(/variant of "audit"/);
      });
      it('the trusted tool file with a variant key beside "audit" is unreadable, so strictest', () => {
        const r = resolveAuditSettings({ fileRead: () => JSON.stringify({ audit: full(), Audit: { releaseStage: 'prod' } }), platform: null, env: {}, log: () => {} });
        expect(r.value).toMatchObject(STRICT);
      });
      it('a plain "audit" key and unrelated keys still read normally', () => {
        // The tool file sets no releaseStage here, so the platform value is the one that applies.
        const r = resolveAuditSettings({ fileRead: file({}), env: {}, log: () => {},
          platformRead: platformRead('', { 'delivery-platform-preferences.json': '{"audits":{},"auditor":1,"audit":{"releaseStage":"prod"}}' }) });
        expect(r.value.releaseStage).toBe('prod');
        expect(r.sources.releaseStage).toBe('platform');
        expect(r.warnings).toEqual([]);
      });
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
  it('a scalar names the layer it came from: file, platform or built-in (PR #6381 send-back)', () => {
    const plat = resolveAuditSettings({ fileRead: () => JSON.stringify({ audit: {} }), platform: { releaseStage: 'prod', recheck: { max: 0 } },
      env: {}, log: () => {} });
    expect(plat.value).toMatchObject({ releaseStage: 'prod', recheckMax: 0 });
    expect(plat.sources).toMatchObject({ releaseStage: 'platform', recheckMax: 'platform', verdictMode: 'built-in', preExistingMode: 'built-in' });
    const both = resolveAuditSettings({ fileRead: file({ releaseStage: 'prod' }), platform: { releaseStage: 'prerelease', recheck: { max: 0 } },
      env: {}, log: () => {} });
    expect(both.value).toMatchObject({ releaseStage: 'prod', recheckMax: 0 });
    expect(both.sources).toMatchObject({ releaseStage: 'file', recheckMax: 'platform', baseRecheckMax: 'built-in' });
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
  // PR #6381 judge: the cascade keys each leaf by its NUL-joined path, so an unknown key `"verdict" + NUL + "mode"` took
  // the slot of `verdict.mode` and dropped it: an explicit shadow mode read as omitted and earned the default `model`.
  // An unknown key holding any control or format character must change no explicit setting: the result equals the
  // same layer with that character replaced by a plain letter (an ordinary unknown key).
  const CONTROL_CHARS = [0x00, 0x01, 0x09, 0x1f, 0x7f, 0x85, 0x2028, 0x200b, 0xfeff].map(c => String.fromCodePoint(c));
  it.each(CONTROL_CHARS.map(c => [c.codePointAt(0).toString(16), c]))(
    'an unknown key holding U+%s changes no explicit setting in the file or the platform layer (PR #6381 judge)', (_hex, c) => {
      const layers = sep => [
        { verdict: { mode: 'shadow' }, [`verdict${sep}mode`]: 'computed', recheck: { max: 0 }, [`recheck${sep}max`]: 3 },
        { preExisting: { mode: 'block', baseRecheckMax: 0 }, [`preExisting${sep}baseRecheckMax`]: 3, [`cards${sep}requirePayBy`]: false },
      ];
      for (const [i, audit] of layers(c).entries()) {
        const control = layers('X')[i];
        const viaFile = resolveAuditSettings({ fileRead: file(audit), platform: null, env: {}, log: () => {} });
        const viaPlatform = resolveAuditSettings({ fileRead: file({}), platform: audit, env: {}, log: () => {} });
        const fileControl = resolveAuditSettings({ fileRead: file(control), platform: null, env: {}, log: () => {} });
        const platformControl = resolveAuditSettings({ fileRead: file({}), platform: control, env: {}, log: () => {} });
        expect(viaFile.value).toEqual(fileControl.value);
        expect(viaPlatform.value).toEqual(platformControl.value);
      }
      const r = resolveAuditSettings({ fileRead: file(layers(c)[0]), platform: null, env: {}, log: () => {} });
      expect(r.value).toMatchObject({ verdictMode: 'shadow', recheckMax: 0 });
      // The platform says shadow; a file key that collides with its leaf must not hide it either.
      const across = resolveAuditSettings({ fileRead: file({ [`verdict${c}mode`]: 'computed' }), platform: { verdict: { mode: 'shadow' } }, env: {}, log: () => {} });
      expect(across.value.verdictMode).toBe('shadow');
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
  it('the built-in floor and the shipped file hold the review authorization modules (PR #6381 red team)', () => {
    const auth = ['scripts/lib/review-independence.mjs', 'scripts/lib/marker-authorship.mjs', 'scripts/review-set-label.mjs'];
    for (const p of auth) expect(GUARD_FLOOR).toContain(p);
    expect(resolveAuditSettings({ platform: null, env: {}, log: () => {} }).value.guardFloorPaths).toEqual(expect.arrayContaining(auth));
  });
  // PR #6381 red team: a record field that is valid JSON but no text (`{"toString":0}` cannot be converted, so
  // `Date.parse` / `RegExp#test` throw on it) empties the list with a warning; the resolver never throws.
  it.each([
    ['an acceptUntil object that cannot become text', { hash: 'a'.repeat(64), acceptUntil: { toString: 0 } }],
    ['a hash object that cannot become text', { hash: { toString: 0 }, acceptUntil: '2026-12-01T00:00:00.000Z' }],
    ['a null acceptUntil', { hash: 'a'.repeat(64), acceptUntil: null }],
  ])('a prior hash record with %s accepts nothing and never throws (PR #6381 red team)', (_, record) => {
    const read = () => JSON.stringify({ audit: { priorQuestionHashes: [record] } });
    let r; expect(() => { r = resolveAuditSettings({ fileRead: read, platform: null, env: {}, log: () => {} }); }).not.toThrow();
    expect(r.value.priorQuestionHashes).toEqual([]);
    expect(r.sources.priorQuestionHashes).toBe('strictest');
    expect(r.warnings.join()).toMatch(/priorQuestionHashes invalid; none accepted/);
    // findAudit's reader refuses it too, so both readers still agree.
    expect(resolvePriorQuestionHashes({ readFile: read, env: {} })).toEqual([]);
  });
  it('a resolution that throws resolves every setting to its strictest option with a warning (PR #6381 red team)', () => {
    // An invalid env value warns BEFORE the throw: that warning must stay in the returned list, as it was logged.
    const env = { [AUDIT_SETTINGS_ENV.verdictMode]: 'bogus', get [AUDIT_SETTINGS_ENV.raceBlockPaths]() { throw new Error('boom'); } };
    const logged = [];
    let r; expect(() => { r = resolveAuditSettings({ fileRead: file(full()), platform: null, env, log: m => logged.push(m) }); }).not.toThrow();
    expect(r.value).toMatchObject({ verdictMode: 'shadow', preExistingMode: 'block', releaseStage: 'prod', recheckMax: 0, baseRecheckMax: 0,
      requireOnMain: true, requirePayBy: true, priorQuestionHashes: [] });
    expect(r.value.guardFloorPaths).toEqual([...GUARD_FLOOR, '**']);
    expect(r.value.raceBlockPaths).toEqual([...GUARD_FLOOR, '**']);
    expect(new Set(Object.values(r.sources))).toEqual(new Set(['strictest']));
    expect(r.warnings).toEqual([expect.stringMatching(/WE_AUDIT_VERDICT_MODE="bogus" invalid/),
      expect.stringMatching(/could not be resolved \(boom\); every setting resolves to its strictest option/)]);
    expect(logged).toEqual(r.warnings);
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
  it.each([
    ['a list over 64 records', Array.from({ length: 65 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'), acceptUntil: '2026-12-01T00:00:00.000Z' }))],
    ['a non-string hash', [{ hash: ['a'.repeat(64)], acceptUntil: '2026-12-01T00:00:00.000Z' }]],
    // Date.parse converts these to text that parses, so findAudit's reader accepts them (PR #6381 red team).
    ['an acceptUntil array', [{ hash: 'a'.repeat(64), acceptUntil: ['2026-12-01'] }]],
    ['a numeric acceptUntil', [{ hash: 'a'.repeat(64), acceptUntil: 1234 }]],
  ])('the audit resolver is only ever stricter than findAudit: %s accepts nothing (PR #6381 merge)', (_, list) => {
    const read = () => JSON.stringify({ audit: { priorQuestionHashes: list } });
    expect(resolveAuditSettings({ fileRead: read, platform: null, env: {}, log: () => {} }).value.priorQuestionHashes).toEqual([]);
    // findAudit's reader does accept it, so this really is a documented "stricter" case, not a shared refusal.
    expect(resolvePriorQuestionHashes({ readFile: read, env: {} })).toHaveLength(list.length);
  });
  it.each([['a case', 'PriorQuestionHashes'], ['an invisible-character', `priorQuestionHashes${String.fromCharCode(0x200b)}`]])(
    'the key beside %s variant of itself accepts nothing (stricter than findAudit, PR #6381 merge)', (_, variant) => {
    const audit = full({ priorQuestionHashes: [HASH_A], [variant]: [] });
    expect(resolve(audit).value.priorQuestionHashes).toEqual([]);
    expect(resolvePriorQuestionHashes({ readFile: file(audit), env: {} })).toEqual([HASH_A]);
  });
  it('an unreadable or non-object platform preference accepts no file hashes (stricter than findAudit, PR #6381 merge)', () => {
    for (const platform of ['x', 42, []]) {
      const r = resolveAuditSettings({ fileRead: file(full({ priorQuestionHashes: [HASH_A] })), platform, env: {}, log: () => {} });
      expect(r.value.priorQuestionHashes).toEqual([]);
      expect(r.sources.priorQuestionHashes).toBe('strictest');
    }
  });
  it('an inherited (prototype) priorQuestionHashes is never read as a setting, as findAudit never reads one (PR #6381 merge)', () => {
    // The parsed file object is a plain JSON value, so emulate a polluted prototype on the shared Object.prototype.
    Object.defineProperty(Object.prototype, 'priorQuestionHashes', { value: [HASH_A], configurable: true, writable: true });
    try {
      for (const audit of [{}, full()]) {
        const polluted = resolveAuditSettings({ fileRead: file(audit), platform: null, env: {}, log: () => {} });
        expect(polluted.value.priorQuestionHashes).toEqual([]);
        expect(polluted.value.priorQuestionHashes).toEqual(resolvePriorQuestionHashes({ readFile: file(audit), env: {} }));
      }
    } finally { delete Object.prototype.priorQuestionHashes; }
  });
  it('the shipped settings file reads the same prior question hashes through both readers (PR #6381 merge)', () => {
    expect(resolveAuditSettings({ platform: null, env: {}, log: () => {} }).value.priorQuestionHashes).toEqual(resolvePriorQuestionHashes({ env: {} }));
  });
  it('is read from the running checkout, not the cwd or a candidate path argument in env', () => {
    const r = resolveAuditSettings({ platform: null, env: { WE_AUDIT_SETTINGS_PATH: '/tmp/evil.json' }, log: () => {} });
    expect(r.value.releaseStage).toBe('prerelease');
  });
});
