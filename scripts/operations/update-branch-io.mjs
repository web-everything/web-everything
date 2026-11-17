import { userInfo } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { runUpdateBranch, UPDATE_BRANCH_OP } from './update-branch.mjs';

/** gh runner takes argv + exec options, never shell text. No retries of ambiguous writes here. */
export function createUpdateBranchSinks({ env = process.env, gh = runGhSync, sleep = setTimeout,
  append = event => appendDaemonEvent(event, { env }),
  actor = () => { try { return userInfo().username; } catch { return env.USER || env.USERNAME || 'unknown'; } },
} = {}) {
  const call = async (args) => String(await gh(['api', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    throttle: { maxAttempts: 1 },
  }));
  const prefix = repo => `repos/${ghRepoSlug(repo)}`;
  const read = async path => JSON.parse(await call([path]));
  const io = {
    actor, sleep, append,
    readPr: (repo, pr) => read(`${prefix(repo)}/pulls/${pr}`),
    compare: (repo, base, head) => read(`${prefix(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
    files: async (repo, pr) => {
      const rows = await read(`${prefix(repo)}/pulls/${pr}/files?per_page=100`);
      if (!Array.isArray(rows) || rows.some(row => typeof row?.filename !== 'string')) throw new Error('unreadable PR files');
      return rows.slice(0, 100).map(row => row.filename);
    },
    update: async (repo, pr, sha) => {
      const response = await call(['--include', '--method', 'PUT', `${prefix(repo)}/pulls/${pr}/update-branch`,
        '-f', `expected_head_sha=${sha}`]);
      return Number(response.match(/^HTTP\/\S+\s+(\d{3})\b/m)?.[1]) || null;
    },
  };
  return { [UPDATE_BRANCH_OP]: input => runUpdateBranch(input, io) };
}
