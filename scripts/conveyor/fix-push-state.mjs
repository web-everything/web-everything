/** Latest successful fixer push per PR. Same-head hand-back retries preserve the original push time. */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixHandoffDir } from '../lib/fix-handoff.mjs';
const fileFor = (dir, repo, pr) => join(dir, createHash('sha256').update(`${repo}#${pr}`).digest('hex') + '.json');
export function readFixPush({ repo, pr, head }, { dir = join(fixHandoffDir(), 'pushes') } = {}) {
  try {
    const row = JSON.parse(readFileSync(fileFor(dir, repo, pr), 'utf8'));
    return row.head === head && Number.isFinite(Date.parse(row.pushedAt)) ? row : null;
  } catch { return null; }
}
export function recordFixPush({ repo, pr, head }, { dir = join(fixHandoffDir(), 'pushes'), now = () => Date.now() } = {}) {
  const prior = readFixPush({ repo, pr, head }, { dir });
  if (prior) return prior;
  mkdirSync(dir, { recursive: true });
  const row = { repo, pr, head, pushedAt: new Date(now()).toISOString() };
  const file = fileFor(dir, repo, pr), temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(row));
  renameSync(temp, file);
  return row;
}
