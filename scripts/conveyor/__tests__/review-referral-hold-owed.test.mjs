import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideSameHeadHold, enrichPrsWithReferralHolds, loadRedTeamHoldReaders } from '../review-referral-hold.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';

// x9jlvy0: replay the saved-result/missing-comment boundary from PR #5461.
const repo = 'chalbert/web-everything';
const head = '3373a3326ef2b649303f7b26b69efabfdfe179a6';
const number = 5461;
const pr = (over = {}) => ({ number, headRefOid: head, comments: [], labels: ['review:accepted'], ...over });
const row = (over = {}) => ({ repo, pr: number, rev: head, dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', ...over });
const run = (over = {}) => ({ repo, pr: number, head, startedAt: 1, completedAt: 2,
  parked: false, persistenceFailed: false, rulings: [], ...over });
let dir, opts;
const save = records => writeFileSync(opts.redTeam.storePath, JSON.stringify({ version: 1, records }));
const settings = value => writeFileSync(opts.redTeam.settingsPath, JSON.stringify({ redTeam: value }));
const decide = (p = pr(), runs = [run()], extra = {}) => decideSameHeadHold(p, runs, { ...opts, ...extra });

beforeEach(async () => {
  await loadRedTeamHoldReaders();
  dir = mkdtempSync(join(tmpdir(), 'redteam-owed-'));
  const platform = join(dir, 'platform.json');
  writeFileSync(platform, '{}');
  opts = { repo, env: { WE_PLATFORM_PREFERENCES_FILE: platform, WE_POLICY_CASCADE_LOG: '1' },
    redTeam: { storePath: join(dir, 'scorecards.json'), stateDir: join(dir, 'lifts'),
      settingsPath: join(dir, 'settings.json'), log: vi.fn() } };
  resetCascadeLogForTest();
  settings({});
  save([row()]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('same-head hold when the post-accept red-team comment is owed', () => {
  it('starts in a real Node process without an ESM cycle and holds until the readers are ready', () => {
    const source = `
      import { decideSameHeadHold, loadRedTeamHoldReaders } from './scripts/conveyor/review-referral-hold.mjs';
      const pr = ${JSON.stringify(pr())}, runs = ${JSON.stringify([run()])}, opts = ${JSON.stringify(opts)};
      delete opts.redTeam.log;
      opts.redTeam.log = () => {};
      const cold = decideSameHeadHold(pr, runs, opts)?.kind;
      await loadRedTeamHoldReaders();
      console.log(JSON.stringify([cold, decideSameHeadHold(pr, runs, opts), decideSameHeadHold(pr, runs, opts)?.kind]));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 30_000 }))).toEqual(['same-head', null, 'same-head']);
  });
  it('lifts an owed head using the saved scorecard row', () => {
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (standard)'));
  });
  it('keeps the hold when a trusted comment is already present', () => {
    expect(decide(pr({ comments: [{ body: redTeamMarker(number, head), author: { login: 'chalbert' } }] })))
      .toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold on a different reviewed head', () => {
    const other = 'b'.repeat(40);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toMatchObject({ kind: 'same-head' });
  });
  it.each([
    ['no evidence', []], ['different repo', [row({ repo: 'other/repo' })]],
    ['different PR', [row({ pr: number + 1 })]], ['failed probe', [row({ status: 'error' })]],
    ['miss row only', [row({ dispatchKind: 'red-team-miss' })]],
  ])('keeps the hold with %s', (_, records) => {
    save(records);
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('lifts once, then holds again with the same durable state after a restart', () => {
    expect(decide()).toBeNull();
    const [reservation] = readdirSync(opts.redTeam.stateDir);
    expect(JSON.parse(readFileSync(join(opts.redTeam.stateDir, reservation, 'receipt.json'), 'utf8')))
      .toMatchObject({ repo, pr: number, head });
    const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { decideSameHeadHold, loadRedTeamHoldReaders } from './scripts/conveyor/review-referral-hold.mjs';
      await loadRedTeamHoldReaders();
      console.log(JSON.stringify(decideSameHeadHold(${JSON.stringify(pr())}, ${JSON.stringify([run()])}, ${JSON.stringify(opts)})));
    `], { encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(restarted)).toMatchObject({ kind: 'same-head' });
    // A second head has its own allowance; the first remains spent.
    const other = 'c'.repeat(40);
    save([row(), row({ rev: other })]);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toBeNull();
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold when the tool setting is off and logs its source', () => {
    settings({ reArmOnMissingComment: false });
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (tool)'));
  });
  it('honors the platform setting and the environment override', () => {
    writeFileSync(opts.env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ redTeam: { reArmOnMissingComment: false } }));
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (platform)'));
    opts.env.WE_RED_TEAM_REARM_ON_MISSING_COMMENT = 'on';
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (env)'));
  });
  it.each(['store', 'settings', 'platform', 'state'])('keeps the hold on a %s read error', kind => {
    if (kind === 'state') writeFileSync(opts.redTeam.stateDir, 'not a directory');
    else writeFileSync(kind === 'store' ? opts.redTeam.storePath : kind === 'settings'
      ? opts.redTeam.settingsPath : opts.env.WE_PLATFORM_PREFERENCES_FILE, '{unreadable JSON');
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it.each(['store', 'settings', 'platform'])('keeps the hold when the %s file cannot be read', kind => {
    // Reading a directory as UTF-8 raises EISDIR on the host; this exercises actual IO failure, not just parsing.
    if (kind === 'store') opts.redTeam.storePath = dir;
    else if (kind === 'settings') opts.redTeam.settingsPath = dir;
    else opts.env.WE_PLATFORM_PREFERENCES_FILE = dir;
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('does not count an untrusted marker or a marker for another head as posted', () => {
    expect(decide(pr({ comments: [
      { body: redTeamMarker(number, head), author: { login: 'stranger' } },
      { body: redTeamMarker(number, 'b'.repeat(40)), author: { login: 'chalbert' } },
    ] }))).toBeNull();
  });
  it('keeps the hold when the comment snapshot is unavailable', () => {
    expect(decide(pr({ comments: undefined }))).toMatchObject({ kind: 'same-head' });
  });
  it('releases through the production enricher only once', () => {
    const enrich = () => enrichPrsWithReferralHolds([pr()], { ...opts, readRuns: () => [run()] })[0];
    expect(enrich().referralHold).toBeNull();
    expect(enrich().referralHold).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold if fetching the full capped comment thread fails', () => {
    const p = pr({ comments: Array.from({ length: 100 }, () => ({ body: 'old comment' })) });
    expect(enrichPrsWithReferralHolds([p], { ...opts, readRuns: () => [run()],
      readComments: () => { throw new Error('thread read failed'); } })[0].referralHold)
      .toMatchObject({ kind: 'same-head' });
  });
});
