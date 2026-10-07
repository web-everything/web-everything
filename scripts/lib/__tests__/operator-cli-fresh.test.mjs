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
