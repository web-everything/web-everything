import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Complete evidence on disk; callers remove exactly the item their negative case exercises. */
export function emptyDiffFixture({ repo = 'web-everything/web-everything', pr = 5872, realDiff = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'empty-diff-evidence-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git('add', 'file.txt'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  if (realDiff) {
    writeFileSync(join(root, 'file.txt'), 'real change\n');
    git('commit', '--quiet', '-am', 'change');
  }
  git('commit', '--quiet', '--allow-empty', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const read = { netBasis: { base, rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
  const loopPayload = { findings: { read } };
  const status = { repo, pr, head, status: 'finished', loopPayload, result: { status: 'skipped', policy: 'empty-net-diff' } };
  const storePath = join(root, 'scorecards.json');
  const row = { dispatchKind: 'review-seat', seat: 'codex-advisory', repo, pr, rev: head, status: 'ok' };
  const writeStore = (records = [row]) => writeFileSync(storePath, JSON.stringify({ version: 1, records }));
  writeStore();
  const proof = { repo, pr, head, seatRecord: status, storePath, cwd: root };
  return { root, git, base, head, read, loopPayload, status, row, storePath, writeStore, proof };
}
