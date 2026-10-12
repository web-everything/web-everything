// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGroupPrs } from '../merge-gate-check.mjs';

describe('merge-group first-parent chain membership', () => {
  let cwd;
  let main;
  const groups = [];
  const heads = {};
  const entries = [];
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'merge-gate-group-chain-'));
    git('init', '-b', 'main');
    git('config', 'user.name', 'Merge Gate Test');
    git('config', 'user.email', 'merge-gate@example.test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(cwd, 'main.txt'), 'main\n');
    git('add', 'main.txt');
    git('commit', '-m', 'Main');
    main = git('rev-parse', 'HEAD');

    for (const number of [5031, 5030, 5029]) {
      git('checkout', '-b', `lane-${number}`, main);
      writeFileSync(join(cwd, `${number}.txt`), `PR ${number}\n`);
      git('add', `${number}.txt`);
      git('commit', '-m', `PR ${number}`);
      heads[number] = git('rev-parse', 'HEAD');
      git('checkout', 'main');
      git('merge', '--no-ff', '-m', `Merge pull request #${number} from o/lane-${number}`, `lane-${number}`);
      const sha = git('rev-parse', 'HEAD');
      groups.push(sha);
      entries.push({ position: groups.length, headCommit: { oid: sha }, pullRequest: { number } });
    }
  });

  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function read(baseSha, { queueUnreadable = false } = {}) {
    const exec = (cmd, args, opts) => {
      if (cmd === 'git') return execFileSync(cmd, args, opts);
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
        if (queueUnreadable) throw new Error('Queue unreadable');
        return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: entries } } } } });
      }
      if (cmd === 'gh' && args[0] === 'api' && /^repos\/o\/r\/commits\/[^/]+\/pulls$/.test(args[1])) return '[]';
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };
    return readGroupPrs({
      repo: 'o/r', headSha: groups[2], baseSha,
      headRef: `refs/heads/gh-readonly-queue/main/pr-5029-${baseSha}`, cwd, exec,
    });
  }

  it('excludes earlier queue entries from a stacked per-entry group', () => {
    expect(read(groups[1])).toEqual({
      nums: [5029], complete: true, reasons: [], heads: { 5029: heads[5029] },
    });
  });

  it('lists and pins every PR in a true three-PR batch chain', () => {
    expect(read(main)).toEqual({ nums: [5029, 5030, 5031], complete: true, reasons: [], heads });
  });

  it('discovers the complete batch chain when queue entries are unreadable', () => {
    expect(read(main, { queueUnreadable: true })).toEqual({
      nums: [5029, 5030, 5031], complete: true, reasons: [], heads,
    });
  });

  it('preserves queue entries and fails closed when history is unreadable', () => {
    const found = read('f'.repeat(40));
    expect(found).toMatchObject({ nums: [5029, 5030, 5031], complete: false, heads: {} });
    expect(found.reasons.join(' ')).toMatch(/history/i);
  });
});
