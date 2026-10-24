import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';

const clean = value => String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 2000);

export function salvageStamp(date) {
  return date.toISOString().slice(0, 16).replaceAll('-', '').replace('T', '-').replace(':', '');
}

export function salvageRefName(lane, date) {
  if (!Number.isSafeInteger(lane) || lane < 1) throw new Error('invalid salvage lane');
  return `salvage/lane-${lane}-${salvageStamp(date)}`;
}

/** Only a verified remote SHA and a durable record count as a completed salvage. */
export async function salvagePushLane({ lane, laneDir, io, now = () => new Date() }) {
  let unmatched = [];
  try {
    const ahead = await io.aheadShas(laneDir);
    if (!Array.isArray(ahead)) throw new Error('incomplete ahead evidence');
    if (!ahead.length) return { status: 'none-ahead', unmatched };
    unmatched = await io.unmatchedShas(laneDir, ahead);
    if (!Array.isArray(unmatched)) throw new Error('incomplete patch-match evidence');
    if (!unmatched.length) return { status: 'matched', unmatched };
    const base = salvageRefName(lane, now());
    for (let attempt = 1; attempt <= 100; attempt++) {
      const ref = attempt === 1 ? base : `${base}-${attempt}`;
      if (await io.remoteSha(ref) !== null) continue;
      const pushed = await io.push(laneDir, ref, ahead[0]);
      if (pushed?.ok !== true) throw new Error('salvage push refused');
      if (await io.remoteSha(ref) !== ahead[0]) throw new Error('salvage remote SHA verification failed');
      await io.record(lane, `${ref} ${ahead[0]}\n`);
      return { status: 'pushed', ref, unmatched };
    }
    throw new Error('100 salvage names occupied; inspect remote salvage branches and retry next minute');
  } catch (e) {
    return { status: 'failed', unmatched, reason: clean(e?.message || e || 'salvage failed') };
  }
}

export function realSalvageIo({ repo, backupRoot = process.env.WE_LANE_BACKUP_ROOT || join(homedir(), 'workspace', '.operations', 'backup') }) {
  const env = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0' });
  const git = (dir, args, timeout = 120_000) => execFileSync('git', args, {
    cwd: dir, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return {
    aheadShas: dir => git(dir, ['rev-list', `origin/${repo.branch}..HEAD`]).split('\n').filter(Boolean),
    unmatchedShas: (dir, ahead) => {
      git(dir, ['fetch', 'origin']);
      const refs = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
        .split('\n').filter(ref => ref && ref !== 'refs/remotes/origin/HEAD');
      if (refs.length > 400) throw new Error('more than 400 origin refs; inspect remote branches manually before retrying salvage');
      const preferred = `refs/remotes/origin/${repo.branch}`;
      refs.sort((a, b) => Number(b === preferred) - Number(a === preferred) || a.localeCompare(b));
      const matched = new Set(), deadline = Date.now() + 120_000;
      for (const ref of refs) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('salvage patch scan timed out; inspect lane manually or retry');
        for (const line of git(dir, ['cherry', ref, 'HEAD'], remaining).split('\n')) {
          if (line.startsWith('- ')) matched.add(line.slice(2).trim());
        }
      }
      return ahead.filter(sha => !matched.has(sha));
    },
    push: (dir, ref, sha) => {
      git(dir, ['push', 'origin', `${sha}:refs/heads/${ref}`]);
      return { ok: true };
    },
    remoteSha: ref => {
      const output = git(repo.referencePath, ['ls-remote', 'origin', `refs/heads/${ref}`]);
      if (!output) return null;
      const lines = output.split('\n');
      const [sha, name] = lines[0].split(/\s+/);
      if (lines.length !== 1 || !/^[a-f0-9]{40,64}$/.test(sha) || name !== `refs/heads/${ref}`) {
        throw new Error('unreadable salvage remote ref');
      }
      return sha;
    },
    record: (lane, text) => {
      const dir = join(backupRoot, `lane-${lane}-preserve`);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'salvage-ref.txt'), text);
    },
  };
}
