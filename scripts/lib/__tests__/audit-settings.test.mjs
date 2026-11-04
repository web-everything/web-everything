import { describe, expect, it } from 'vitest';
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
