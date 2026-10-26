import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numberingRedTeamAlias, hasRedTeamEvidence } from '../numbering-red-team-alias.mjs';
import { proveNumberingOnlyMove } from '../numbering-carry.mjs';
import { numberPendingHashes } from '../../lane-drain.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'rt-alias-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'commit.gpgsign', 'false');
  git('config', 'user.name', 'Drain'); git('config', 'user.email', 'drain@x');
  mkdirSync(join(cwd, 'backlog')); mkdirSync(join(cwd, '.claude/skills/batch-backlog-items'), { recursive: true });
  writeFileSync(join(cwd, 'backlog/010-old.md'), '---\nstatus: resolved\n---\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n\n# Foo\n');
  writeFileSync(join(cwd, 'backlog/xdef456-bar.md'), '---\nstatus: open\nrelatedTo: ["xabc123"]\n---\n\n# Bar, see xabc123\n');
  git('add', '.'); git('commit', '-qm', 'cards');
  const accepted = git('rev-parse', 'HEAD');
  expect(numberPendingHashes(cwd).committed).toBe(true);
  return { cwd, git, accepted, head: git('rev-parse', 'HEAD') };
}

it('a head moved only by the drain numbering commit reads red-team evidence from the accepted head', () => {
  const { cwd, accepted, head } = fixture();
  try {
    const alias = numberingRedTeamAlias({ exec: execFileSync, cwd, head, hasEvidence: (sha) => sha === accepted });
    expect(alias.head).toBe(accepted);
    expect(alias.reason).toMatch(/xabc123→#0*11\b/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('NOT WEAKENED: any extra change in the numbering commit keeps the exact head (today\'s behavior)', () => {
  const { cwd, git, accepted } = fixture();
  try {
    const card = readdirSync(join(cwd, 'backlog')).find((f) => f.startsWith('011-'));
    writeFileSync(join(cwd, 'backlog', card), '---\nbornAs: xabc123\nstatus: open\n---\n\n# Foo, plus a smuggled edit\n');
    git('add', '.'); git('commit', '-q', '--amend', '--no-edit');
    const head = git('rev-parse', 'HEAD');
    expect(numberingRedTeamAlias({ exec: execFileSync, cwd, head, hasEvidence: (sha) => sha === accepted })).toBeNull();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('NOT WEAKENED: a real commit after the numbering commit keeps the exact head', () => {
  const { cwd, git, accepted } = fixture();
  try {
    writeFileSync(join(cwd, 'code.mjs'), 'export const x = 1;\n');
    git('add', '.'); git('commit', '-qm', 'drain: JIT-number xzzz999→#99 at land (#2288)');
    const head = git('rev-parse', 'HEAD');
    expect(numberingRedTeamAlias({ exec: execFileSync, cwd, head, hasEvidence: (sha) => sha === accepted })).toBeNull();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('no evidence on any proven ancestor, an unreadable git, or a bad head all keep the exact head', () => {
  const { cwd, head } = fixture();
  try {
    expect(numberingRedTeamAlias({ exec: execFileSync, cwd, head, hasEvidence: () => false })).toBeNull();
    expect(numberingRedTeamAlias({ exec: () => { throw new Error('git down'); }, cwd, head, hasEvidence: () => true })).toBeNull();
    expect(numberingRedTeamAlias({ exec: execFileSync, cwd, head: 'HEAD', hasEvidence: () => true })).toBeNull();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  expect(hasRedTeamEvidence({ scheduled: false, recorded: false })).toBe(false);
  expect(hasRedTeamEvidence({ recorded: true })).toBe(true);
});

// Live replays on the real repo objects (skipped when the clone lacks them). Main is pinned to the commit
// current at each event, so a later land of the numbers cannot change the proof.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const have = (sha) => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'pipe' }); return true; } catch { return false; } };
const replay = (head, main, hasEvidence) => numberingRedTeamAlias({ exec: execFileSync, cwd: repo, head, hasEvidence,
  prove: (o) => proveNumberingOnlyMove({ ...o, mainRef: main }) });
const H5742 = { first: '4b622bedb38d84e5735029c84d07d2637f7957ba', fixed: '11f43c85d01c539ff7bcb5606b9368f95ff5dfe6', numbered: '33a282cc047aa0187bdcae2aa3a98abdb1f4072d' };
const MAIN_5742 = '03c12a8d48c4022d21dc9fe2eaf6e4d264bcf6b6';

it('live replay #5742: the numbered head 33a282cc0 reads evidence from the approved head 11f43c85d', () => {
  if (![H5742.numbered, H5742.fixed, MAIN_5742].every(have)) return;
  const alias = replay(H5742.numbered, MAIN_5742, (sha) => sha === H5742.fixed);
  expect(alias?.head).toBe(H5742.fixed);
  expect(alias.pairs.map(([h, n]) => `${h}→${n}`)).toEqual(['x5wqxb3→6786', 'xl3mmn5→6787', 'xbyg4e4→6788', 'xukmjgl→6789', 'x0lckod→6790']);
});

it('live replay #5742: the real fix heads 4b622bedb → 11f43c85d are NOT a numbering move (a review is still owed)', () => {
  if (![H5742.fixed, H5742.first, MAIN_5742].every(have)) return;
  expect(replay(H5742.fixed, MAIN_5742, (sha) => sha === H5742.first)).toBeNull();
});

it('live replay #5777 and #5779: each numbered head proves numbering-only over its pre-numbering head', () => {
  const cases = [
    ['1f9c89db66b1657508d94bcef1fda5ee573052ce', '7cb69e75a145b0c017086e5a0c78ee558040af6f', '2a25ba93d78bbe58e63eeab237a8cdbc164999d7'],
    ['b8759c44fe23485b86d0add46b55d73a365632e8', 'e77e844439c658e047c579d7233fc0771e2f7902', 'c25f4031eebdbcf10ac886486b1ad50ebd5a1208'],
  ];
  for (const [head, main, parent] of cases) {
    if (![head, main, parent].every(have)) continue;
    expect(replay(head, main, (sha) => sha === parent)?.head).toBe(parent);
  }
});
