/**
 * @file scripts/conveyor/__tests__/auto-round-grant.test.mjs
 * @description The automated standing-ruling round grant: eligibility (card-only NET diff, repo list, note kind),
 *   the per-PR cap, idempotency per limit hit, the credential gate, and the daemon hook that consumes it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_GRANT_CHANNEL, AUTO_GRANT_PERSONAL_EXCEPTION, autoGrantKey, countAutoRoundGrants, decideAutoGrant,
  isCardOnlyNetDiff, resolveAutoRoundGrantSettings, screenAutoGrantNote, STANDING_RULING,
} from '../auto-round-grant.mjs';
import { autoRoundGrant, claimLimitHit, operatorGhEnv } from '../auto-round-grant-io.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const WE = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const note = { kind: 'round-cap-exhausted', prNumber: 5654, attempts: 8, cap: 7, capKind: 'review', text: 'PR #5654: review auto-repair rounds exhausted (8/7) — a person must take it over' };
const ON = { enabled: true, maxPerPr: 3, repos: [WE], sources: {} };
const grantComment = (channel, login = 'chalbert', by = 1) => ({
  author: { login },
  body: buildRoundExtensionComment({ repo: WE, pr: 5654, by, actor: 'chalbert', channel, reason: 'r', at: '2026-10-20T00:00:00Z' }),
});
const allow = () => ({ auth: 'app', personalExceptions: { [AUTO_GRANT_PERSONAL_EXCEPTION]: 'x' } });
const tmpClaim = () => { const dir = mkdtempSync(join(tmpdir(), 'arg-')); return (key) => claimLimitHit(key, { dir }); };
const deps = (over = {}) => ({
  settings: ON, readThread: () => ({ state: 'OPEN', comments: [] }),
  readNet: () => ({ ok: true, files: ['backlog/x8js7c9-prevention.md', 'backlog/raised-by/x8js7c9.json'], added: [] }),
  claim: tmpClaim(), policy: allow, ghEnv: () => ({ ok: true, env: { GH_TOKEN: 'operator' } }),
  extend: vi.fn(() => ({ runId: 'extend-rounds-1' })), ...over,
});

describe('settings cascade', () => {
  it('standard is off with cap 3; the tool layer turns it on; invalid leaves never override', () => {
    expect(resolveAutoRoundGrantSettings({})).toMatchObject({ enabled: false, maxPerPr: 3, repos: [WE], sources: { enabled: 'standard' } });
    const s = resolveAutoRoundGrantSettings({ tool: { autoRoundGrant: { cardOnly: { enabled: true, maxPerPr: 'lots' } } } });
    expect(s).toMatchObject({ enabled: true, maxPerPr: 3, sources: { enabled: 'tool', maxPerPr: 'standard' } });
    const p = resolveAutoRoundGrantSettings({ platform: { autoRoundGrant: { cardOnly: { maxPerPr: 2 } } }, tool: { autoRoundGrant: { cardOnly: { enabled: true } } } });
    expect(p).toMatchObject({ maxPerPr: 2, sources: { maxPerPr: 'platform', enabled: 'tool' } });
  });
});

describe('card-only is judged on the NET diff', () => {
  it('accepts cards and raised-by sidecars only', () => {
    expect(isCardOnlyNetDiff(['backlog/a.md', 'backlog/raised-by/a.json'])).toBe(true);
    expect(isCardOnlyNetDiff(['backlog/a.md', 'scripts/x.mjs'])).toBe(false);
    expect(isCardOnlyNetDiff([])).toBe(false);
    expect(isCardOnlyNetDiff(['backlog/../scripts/x.mjs'])).toBe(false);
    expect(isCardOnlyNetDiff(['backlogs/a.md'])).toBe(false);
  });
  it('a PR whose three-dot list is inflated by sibling-lane code but whose net diff is cards only is granted', () => {
    // gh's three-dot list would show scripts/foo.mjs (landed on main via a sibling); the net read does not.
    const readNet = vi.fn(() => ({ ok: true, files: ['backlog/x.md'], added: [] }));
    const d = deps({ readNet });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD, files: [{ path: 'scripts/foo.mjs' }] } }, d)).toMatchObject({ action: 'granted', count: 1, max: 3 });
    expect(readNet).toHaveBeenCalledWith({ repo: WE, number: 5654, headRefOid: HEAD });
  });
  it('a code PR is refused and nothing is posted', () => {
    const d = deps({ readNet: () => ({ ok: true, files: ['backlog/x.md', 'scripts/conveyor/foo.mjs'] }) });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d)).toEqual({ action: 'skip', why: 'not card-only: scripts/conveyor/foo.mjs' });
    expect(d.extend).not.toHaveBeenCalled();
  });
  it('an unreadable net diff refuses (fail closed), never falls back to the listed files', () => {
    const d = deps({ readNet: () => ({ ok: false, reason: 'fetch failed' }) });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD, files: [{ path: 'backlog/x.md' }] } }, d)).toMatchObject({ action: 'skip', why: 'net diff unreadable: fetch failed' });
    expect(d.extend).not.toHaveBeenCalled();
  });
});

describe('screen', () => {
  it('ignores other note kinds and other repos before any read', () => {
    const d = deps({ readThread: vi.fn() });
    expect(autoRoundGrant({ repo: 'we', note: { ...note, kind: 'ci-heal-exhausted' }, pr: { headRefOid: HEAD } }, d)).toBeNull();
    expect(autoRoundGrant({ repo: 'plateau-app', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'skip' });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, { ...d, settings: { ...ON, enabled: false } })).toBeNull();
    expect(d.readThread).not.toHaveBeenCalled();
    expect(screenAutoGrantNote({ note: { ...note, takeoverNotConverging: true }, repo: 'we', pr: { headRefOid: HEAD }, settings: ON }).ok).toBe(false);
  });
});

describe('per-PR cap', () => {
  it('counts only operator-authored automatic grants', () => {
    const comments = [grantComment(AUTO_GRANT_CHANNEL), grantComment('claude-code-chat'), grantComment(AUTO_GRANT_CHANNEL, 'web-everything[bot]')];
    expect(countAutoRoundGrants(comments, { repo: WE, pr: 5654 })).toBe(1);
  });
  it('grants the 3rd, refuses the 4th with a cap-reached reason, posts nothing', () => {
    const two = [grantComment(AUTO_GRANT_CHANNEL), grantComment(AUTO_GRANT_CHANNEL), grantComment('claude-code-chat')];
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, deps({ readThread: () => ({ state: 'OPEN', comments: two }) })))
      .toMatchObject({ action: 'granted', count: 3, max: 3 });
    const three = [...two, grantComment(AUTO_GRANT_CHANNEL)];
    const d = deps({ readThread: () => ({ state: 'OPEN', comments: three }) });
    const out = autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d);
    expect(out).toMatchObject({ action: 'cap-reached', used: 3, max: 3 });
    expect(out.reason).toMatch(/^auto-grant cap reached \(3\/3\): PR #5654/);
    expect(d.extend).not.toHaveBeenCalled();
  });
  it('decideAutoGrant refuses a closed PR', () => {
    expect(decideAutoGrant({ netRead: { ok: true, files: ['backlog/a.md'] }, used: 0, max: 3, state: 'MERGED' }).action).toBe('skip');
  });
});

describe('idempotency per (PR, head, cap episode)', () => {
  it('a second call for the same limit hit never grants again; a new episode can', () => {
    const d = deps();
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d).action).toBe('granted');
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'skip', why: expect.stringMatching(/^already claimed/) });
    expect(d.extend).toHaveBeenCalledTimes(1);
    expect(autoRoundGrant({ repo: 'we', note: { ...note, attempts: 9, cap: 8 }, pr: { headRefOid: HEAD } }, d).action).toBe('granted');
    expect(autoGrantKey({ repo: 'we', note, head: HEAD })).toBe(`${WE}#5654@${HEAD}:review:8/7`);
  });
  it('a failed run keeps its claim (no automatic retry) and reports failed', () => {
    const d = deps({ extend: vi.fn(() => { throw new Error('extend-rounds must run under the operator credential'); }) });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'failed' });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'skip' });
    expect(d.extend).toHaveBeenCalledTimes(1);
  });
});

describe('credential gate', () => {
  it('without the github.auth personal exception nothing is posted', () => {
    const d = deps({ policy: () => ({ auth: 'app', personalExceptions: {} }) });
    expect(autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d)).toMatchObject({ action: 'skip', why: expect.stringContaining(AUTO_GRANT_PERSONAL_EXCEPTION) });
    expect(d.extend).not.toHaveBeenCalled();
  });
  it('the operator env puts the real gh first, drops shim dirs and GITHUB_TOKEN', () => {
    const out = operatorGhEnv({ env: { PATH: '/h/.claude/github-app-token/gh-shim:/usr/bin', GITHUB_TOKEN: 'app', GH_TOKEN: 'app' }, home: '/h', realGh: '/opt/homebrew/bin/gh', token: 'op' });
    expect(out).toEqual({ ok: true, env: { PATH: '/opt/homebrew/bin:/usr/bin', GH_TOKEN: 'op' } });
    expect(operatorGhEnv({ env: {}, home: '/h', realGh: '/opt/homebrew/bin/gh', token: null }).ok).toBe(false);
  });
  it('the grant reason quotes the ruling and the automatic-grant count', () => {
    const d = deps();
    autoRoundGrant({ repo: 'we', note, pr: { headRefOid: HEAD } }, d);
    const { reason, repo, pr } = d.extend.mock.calls[0][0];
    expect({ repo, pr }).toEqual({ repo: WE, pr: 5654 });
    expect(reason.startsWith(STANDING_RULING)).toBe(true);
    expect(reason).toContain('Automatic grant 1/3');
  });
});

describe('daemon hook (runReconcileNotesAllRepos)', () => {
  const tick = () => ({ notes: [note], prsByNumber: new Map([[5654, { number: 5654, headRefOid: HEAD, labels: [], comments: [] }]]) });
  const safety = { value: { alertAtRoundCap: true }, sources: { alertAtRoundCap: 'test' } };
  it('a grant skips the needs-you event, the note comment and parking', () => {
    const publish = vi.fn(); const postComment = vi.fn(() => ({ ok: true })); const parkToHuman = vi.fn(() => ({ ok: true }));
    const out = runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment, parkToHuman, safety,
      autoRoundGrant: () => ({ action: 'granted', count: 1, max: 3, runId: 'r' }) });
    expect(publish).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled(); expect(parkToHuman).not.toHaveBeenCalled();
    expect(out.autoGrants).toEqual([{ repo: 'we', prNumber: 5654, action: 'granted', count: 1, max: 3, runId: 'r' }]);
  });
  it('at the cap the event is kept with the cap-reached reason', () => {
    const publish = vi.fn();
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment: () => ({ ok: true }), safety,
      autoRoundGrant: () => ({ action: 'cap-reached', used: 3, max: 3, reason: 'auto-grant cap reached (3/3): x' }) });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'at-round-limit', reason: 'auto-grant cap reached (3/3): x' }));
  });
  it('a refusal or a throw publishes the event unchanged; dry-run never grants', () => {
    const publish = vi.fn();
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: false, publish, postComment: () => ({ ok: true }), safety,
      autoRoundGrant: () => { throw new Error('boom'); } });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: note.text }));
    const grant = vi.fn();
    runReconcileNotesAllRepos({ repos: ['we'], tick, dryRun: true, publish, safety, autoRoundGrant: grant });
    expect(grant).not.toHaveBeenCalled();
  });
});
