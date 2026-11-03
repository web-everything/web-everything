/**
 * Brief red-team before code (R469 part 3): only guard/daemon/credential touch-sets, bounded, fail-open, settings-gated.
 */
import { describe, expect, it, vi } from 'vitest';
import { isBriefRedTeamTouchSet, readBriefRedTeamPolicy, redTeamBrief, renderRedTeamSection } from '../brief-red-team.mjs';

const GUARD = ['we:scripts/lib/red-team-gate.mjs'];
const PLAIN = ['we:scripts/lib/format-date.mjs'];
const policy = (over = {}) => ({ enabled: true, timeoutMs: 50, maxClasses: 3, ...over });
const ok = { classes: [{ attack: 'bypass via symlink', test: 'rejects a symlinked path' }, { attack: 'empty input passes', test: 'denies empty input' }] };

describe('isBriefRedTeamTouchSet', () => {
  it('is true for a guard path (reusing isGuardPath) and for daemon or credential files', () => {
    expect(isBriefRedTeamTouchSet(GUARD)).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/daemon-load-overlay.mjs'])).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/github-token-store.mjs'])).toBe(true);
  });
  it('is false for an ordinary touch-set, so ordinary dispatch is not slowed', () => {
    expect(isBriefRedTeamTouchSet(PLAIN)).toBe(false);
    expect(isBriefRedTeamTouchSet([])).toBe(false);
  });
});

describe('readBriefRedTeamPolicy', () => {
  it('defaults on with a bounded timeout, and honours the env switch', () => {
    const p = readBriefRedTeamPolicy({ env: {}, read: () => ({}) });
    expect(p.enabled).toBe(true);
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(readBriefRedTeamPolicy({ env: { WE_BRIEF_RED_TEAM_ENABLED: 'false' }, read: () => ({}) }).enabled).toBe(false);
  });
  it('reads the settings file and ignores invalid values', () => {
    expect(readBriefRedTeamPolicy({ env: {}, read: () => ({ briefRedTeam: { enabled: false, timeoutMs: 9 } }) })).toMatchObject({ enabled: false, timeoutMs: 9 });
    expect(readBriefRedTeamPolicy({ env: {}, read: () => ({ briefRedTeam: { timeoutMs: -1 } }) }).timeoutMs).toBeGreaterThan(0);
    expect(readBriefRedTeamPolicy({ env: {}, read: () => { throw new Error('x'); } }).enabled).toBe(true);
  });
});

describe('redTeamBrief', () => {
  it('skips (never runs) for an ordinary touch-set', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: PLAIN, prep: 'p', policy: policy(), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('skips when the setting is off', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: GUARD, prep: 'p', policy: policy({ enabled: false }), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('skips when there is no prep or acceptance text to attack', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: GUARD, prep: '  ', policy: policy(), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('returns attack classes, each with a test, capped at maxClasses', async () => {
    const run = async () => ({ classes: [...ok.classes, ...ok.classes] });
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', acceptance: 'acc', policy: policy(), run });
    expect(r.status).toBe('ok');
    expect(r.classes).toHaveLength(3);
    expect(r.classes.every((c) => c.attack && c.test)).toBe(true);
  });
  it('drops a class that has no test', async () => {
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => ({ classes: [{ attack: 'a', test: '' }, ok.classes[0]] }) });
    expect(r.classes).toEqual([ok.classes[0]]);
  });
  it('fails open and logs when the red-team throws', async () => {
    const log = vi.fn();
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => { throw new Error('boom'); }, log });
    expect(r).toMatchObject({ status: 'failed', classes: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
  it('fails open and logs on timeout, and on a malformed result', async () => {
    const log = vi.fn();
    const slow = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy({ timeoutMs: 10 }), run: () => new Promise(() => {}), log });
    expect(slow).toMatchObject({ status: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
    expect((await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => 'junk', log })).status).toBe('failed');
  });
});

describe('renderRedTeamSection', () => {
  it('renders each class with a required-test line, and nothing for skipped or failed', () => {
    const text = renderRedTeamSection({ status: 'ok', classes: ok.classes });
    expect(text).toContain('bypass via symlink');
    expect(text).toContain('rejects a symlinked path');
    expect(text).toMatch(/must have a test/i);
    expect(renderRedTeamSection({ status: 'skipped', classes: [] })).toBe('');
    expect(renderRedTeamSection({ status: 'failed', classes: [] })).toBe('');
  });
});
