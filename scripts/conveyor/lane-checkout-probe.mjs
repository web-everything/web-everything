/**
 * Read-only pool-lane checkout evidence. Uses each lane's local origin/main, never fetches,
 * and preserves unknown evidence on IO failure. Daemon clones belong to cloneLag instead.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { laneIndicesIn, poolsWithLanes } from '../lib/lane-pool-scan.mjs';

/**
 * @param {{poolRoot?: string|null, readFile?: Function, git?: Function, now?: number}} [options]
 * `git(args, {cwd, timeout, maxBuffer})` returns stdout or throws; readFile follows readFileSync.
 * @returns {Array<{pool:string, lane:number, head:string|null, behind:number|null, behindSinceMs:number|null, forgeExecHasPrune:boolean|null}>}
 */
export function probeLaneCheckouts({ poolRoot, readFile = readFileSync, git = (args, options) => execFileSync('git', args, options), now = Date.now() } = {}) {
  if (!poolRoot) return [];
  const out = [];
  for (const pool of poolsWithLanes(poolRoot)) {
    for (const lane of laneIndicesIn(join(poolRoot, pool))) {
      const cwd = join(poolRoot, pool, `lane-${lane}`);
      const row = { pool, lane, head: null, behind: null, behindSinceMs: null, forgeExecHasPrune: null };
      try {
        const source = String(readFile(join(cwd, 'scripts/readiness/forge-exec-run.mjs'), 'utf8'));
        const parser = source.split(/\bfunction\s+/).find((part) => /^parseTelemetry\s*\(/.test(part)) || '';
        row.forgeExecHasPrune = /delete\s+legacy\.prune\b/.test(parser)
          && /delete\s+legacy\.diskUsedPct\b/.test(parser)
          && /validPruneStatus\s*\(\s*v\.prune\s*\)/.test(parser)
          && /Number\.isFinite\s*\(\s*v\.diskUsedPct\s*\)/.test(parser);
      } catch { /* unreadable source stays unknown */ }
      const readGit = (args) => String(git(args, {
        cwd, encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      })).trim();
      try {
        row.head = readGit(['rev-parse', 'HEAD']).slice(0, 9) || null;
        readGit(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
        const count = readGit(['rev-list', '--count', 'HEAD..origin/main']);
        if (/^\d+$/.test(count) && Number.isSafeInteger(Number(count))) {
          row.behind = Number(count);
          if (row.behind > 0) {
            const oldest = readGit(['log', '--reverse', '--format=%ct', 'HEAD..origin/main']).split('\n')[0];
            const timestamp = /^\d+$/.test(oldest) ? Number(oldest) * 1000 : NaN;
            if (Number.isFinite(timestamp) && timestamp <= now) row.behindSinceMs = timestamp;
          }
        }
      } catch { /* divergent/missing refs, timeout or oversized output: retain only proven evidence */ }
      out.push(row);
    }
  }
  return out;
}
