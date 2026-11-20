/**
 * @file operator-cli-fresh.test.mjs — item 113: an operator CLI (review-set-label, record-referral-ruling) must
 *   refuse, not return a misleading verdict, when its own checkout is behind origin/main in code it runs.
 *   Uses a REAL origin + clone pair so "behind" is measured by git, not stubbed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertOperatorCliFresh, OPERATOR_CLI_STALE_MARKER } from '../main-staleness.mjs';
import { classifySkipReason } from '../drain-skip-reasons.mjs';
import { createRecordReferralRulingReader } from '../../operations/record-referral-ruling-io.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function pair() {
  const base = mkdtempSync(join(tmpdir(), 'we-op-fresh-')); dirs.push(base);
  const origin = join(base, 'origin'); const clone = join(base, 'clone');
  mkdirSync(origin); git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.mjs'), 'export const a = 1;\n'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'one');
  git(base, 'clone', '-q', origin, clone);
  const land = (file, text) => { writeFileSync(join(origin, file), text); git(origin, 'add', '.'); git(origin, 'commit', '-qm', `touch ${file}`); };
  return { clone, land };
}
const opts = { skipUnderVitest: false, env: {} };

describe('assertOperatorCliFresh (item 113)', () => {
  it('passes when the checkout is level with origin/main', () => {
    const { clone } = pair();
    expect(() => assertOperatorCliFresh(clone, { ...opts, label: 'review-set-label' })).not.toThrow();
  });

  it('REFUSES a checkout behind origin/main in a code file, saying to run from an up-to-date lane', () => {
    const { clone, land } = pair();
    land('a.mjs', 'export const a = 2; // main fixed a bug\n');
    expect(() => assertOperatorCliFresh(clone, { ...opts, label: 'review-set-label' }))
      .toThrow(new RegExp(`review-set-label: .*1 commit\\(s\\) behind origin/main.*${OPERATOR_CLI_STALE_MARKER}`));
  });

  it('never moves the checkout it refuses', () => {
    const { clone, land } = pair();
    const before = git(clone, 'rev-parse', 'HEAD');
    land('a.mjs', 'export const a = 3;\n');
    expect(() => assertOperatorCliFresh(clone, opts)).toThrow();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('tolerates lag that touches only non-code files (backlog churn)', () => {
    const { clone, land } = pair();
    land('card.md', '---\nx: 1\n---\n');
    expect(() => assertOperatorCliFresh(clone, opts)).not.toThrow();
  });

  it('fails closed when the behind-file list is unknown', () => {
    const { clone, land } = pair();
    land('card.md', 'x\n');
    expect(() => assertOperatorCliFresh(clone, { ...opts, listBehindFiles: () => null })).toThrow(OPERATOR_CLI_STALE_MARKER);
  });

  it('stays fail-soft when offline (fetch fails)', () => {
    const run = (args) => (args[0] === 'fetch' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' });
    expect(() => assertOperatorCliFresh('/nowhere', { ...opts, run })).not.toThrow();
  });

  it('skips a daemon-managed clone (its gated rebuild owns freshness)', () => {
    const { clone, land } = pair();
    land('a.mjs', 'export const a = 4;\n');
    expect(() => assertOperatorCliFresh(clone, { ...opts, env: { WE_DAEMON_MANAGED_CLONE: '1' } })).not.toThrow();
  });
});

describe('re-stamp runs from fresh code: accepts the daemon-ADOPTED smoke-passed build (R1099)', () => {
  const now = Date.parse('2026-11-20T16:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
  // Behind in a code file, with fallbacks that must never run: a spawn/lane acquire would mean the old path.
  const boom = () => { throw new Error('fallback must not run'); };
  const setup = () => {
    const { clone, land } = pair();
    land('a.mjs', 'export const a = 9;\n');
    const head = git(clone, 'rev-parse', 'HEAD').trim();
    return { clone, head };
  };
  const call = (clone, adoptedState, extra = {}) => {
    const lines = [];
    const out = assertOperatorCliFresh(clone, { ...opts, label: 'review-set-label', adoptedState, now: () => now,
      spawn: boom, laneSpawn: boom, exit: boom, write: (s) => lines.push(s), ...extra });
    return { out, lines };
  };

  it('re-stamp runs from fresh code: HEAD == adopted head, clean, adopted 2h ago -> accepted, no spawn/lane', () => {
    const { clone, head } = setup();
    const { out, lines } = call(clone, () => ({ adopted: { head, at: hoursAgo(2) } }));
    expect(out).toMatchObject({ adoptedBuild: true, head });
    expect(lines.join('')).toMatch(/ADOPTED smoke-passed build/);
  });

  it('refuses when HEAD differs from the adopted head', () => {
    const { clone } = setup();
    expect(() => call(clone, () => ({ adopted: { head: 'a'.repeat(40), at: hoursAgo(1) } }), { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } })).toThrow(OPERATOR_CLI_STALE_MARKER);
  });

  it('refuses when the code tree is dirty', () => {
    const { clone, head } = setup();
    writeFileSync(join(clone, 'a.mjs'), 'export const a = 7; // local edit\n');
    expect(() => call(clone, () => ({ adopted: { head, at: hoursAgo(1) } }), { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } })).toThrow(OPERATOR_CLI_STALE_MARKER);
  });

  it('refuses when the adoption is older than the max age', () => {
    const { clone, head } = setup();
    expect(() => call(clone, () => ({ adopted: { head, at: hoursAgo(25) } }), { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } })).toThrow(OPERATOR_CLI_STALE_MARKER);
  });

  it.each([['no rebuild record', () => null], ['unreadable adopted.at', (h) => ({ adopted: { head: h, at: 'garbage' } })], ['no adopted block', () => ({})]])(
    'refuses on %s', (_name, state) => {
      const { clone, head } = setup();
      expect(() => call(clone, () => state(head), { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } })).toThrow(OPERATOR_CLI_STALE_MARKER);
    });

  it('WE_OPERATOR_CLI_FRESH_FALLBACK=off skips the adopted-build acceptance and refuses', () => {
    const { clone, head } = setup();
    expect(() => call(clone, () => ({ adopted: { head, at: hoursAgo(1) } }), { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } })).toThrow(OPERATOR_CLI_STALE_MARKER);
  });
});

describe('a remaining stale re-stamp refusal is a NAMED skip (contract)', () => {
  it('re-stamp runs from fresh code: the guard\'s real refusal classifies as restamp-stale-code', () => {
    const { clone, land } = pair();
    land('a.mjs', 'export const a = 5;\n');
    let message = '';
    try { assertOperatorCliFresh(clone, { ...opts, label: 'review-set-label', env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } }); } catch (e) { message = e.message; }
    expect(classifySkipReason(`merge-queue: numbered card(s) on branch before enqueue → x; acceptance re-stamp failed: ${JSON.stringify({ error: message }).slice(0, 200)}`))
      .toBe('restamp-stale-code');
  });
});

describe('record-referral-ruling reader checks freshness first', () => {
  it('a stale checkout refuses before any PR read happens', () => {
    const { clone, land } = pair();
    land('a.mjs', 'export const a = 5;\n');
    let read = false;
    const reader = createRecordReferralRulingReader({
      readJson: () => { read = true; return {}; },
      assertFresh: () => assertOperatorCliFresh(clone, { ...opts, label: 'record-referral-ruling' }),
    });
    expect(() => reader({ repo: 'o/n', pr: 1 })).toThrow(OPERATOR_CLI_STALE_MARKER);
    expect(read).toBe(false);
  });
});
