#!/usr/bin/env node
/** Read-only remote probe: creates local objects/private index, never pushes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRun } from '../lib/git-run.mjs';
import { resolveRealFiles } from '../lib/pr-real-files.mjs';
import { rebaseDropManifest } from '../lib/rebase-drop-manifest.mjs';
import { patchWithoutPositions } from '../lib/card-squash-rebuild.mjs';

export function cardRebaseProbe({ pr, repo, cwd = process.cwd(), run = gitRun, print = console.log } = {}) {
  if (!Number.isInteger(pr) || pr <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('usage: --pr=N --repo=owner/name');
  // A hard no-push boundary remains even if the rebuild implementation changes.
  const safeRun = (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('push')) throw new Error('probe must never push');
    return run(cmd, args, opts);
  };
  const viewed = safeRun('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName,headRefOid,baseRefName,files'], { cwd });
  if (viewed.status !== 0) throw new Error('PR metadata unavailable');
  const view = JSON.parse(viewed.stdout);
  const evidence = resolveRealFiles({ pr: view, repo, ghFiles: view.files?.length < 100 ? view.files : null, cwd, run: safeRun, enabled: true });
  print(JSON.stringify(evidence));
  if (evidence.source !== 'git') throw new Error('cannot verify PR in this clone');
  const scratch = mkdtempSync(join(tmpdir(), 'card-rebase-probe-'));
  try {
    const result = rebaseDropManifest({ laneRef: view.headRefName, readRef: view.headRefOid, base: 'origin/main',
      fetch: false, tmpIndex: join(scratch, 'index'), cwd, run: safeRun, dryRun: true });
    if (!['dry-run', 'current'].includes(result.action)) { print(JSON.stringify(result)); return result; }
    const count = safeRun('git', ['rev-list', '--count', `${result.base}..${result.newCommit}`], { cwd });
    const old = safeRun('git', ['diff', '--binary', '--no-renames', '-U0', `${result.base}...${view.headRefOid}`], { cwd });
    const next = safeRun('git', ['diff', '--binary', '--no-renames', '-U0', result.base, result.newCommit], { cwd });
    print(JSON.stringify({ ...result, commitCount: count.status === 0 ? Number(count.stdout) : null,
      patchEqual: old.status === 0 && next.status === 0 && patchWithoutPositions(old.stdout) === patchWithoutPositions(next.stdout) }));
    return result;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
    cardRebaseProbe({ pr: Number(flag('pr')), repo: flag('repo') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
