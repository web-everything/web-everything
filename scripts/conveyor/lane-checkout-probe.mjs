/**
 * Read-only pool-lane checkout evidence. Uses local refs plus the host main-tip time, never fetches,
 * and preserves unknown evidence on IO failure. Daemon clones belong to cloneLag instead.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { laneIndicesIn, poolsWithLanes } from '../lib/lane-pool-scan.mjs';

/**
 * @param {{poolRoot?: string|null, readFile?: Function, git?: Function, now?: number, mainTipTimeMs?: number|null}} [options]
 * `git(args, {cwd, timeout, maxBuffer})` returns stdout or throws; readFile follows readFileSync.
 * @returns {Array<{pool:string, lane:number, head:string|null, behind:number|null, behindSinceMs:number|null, headLagMs:number|null, forgeExecHasPrune:boolean|null}>}
 */
export function probeLaneCheckouts({ poolRoot, readFile = readFileSync, git = (args, options) => execFileSync('git', args, options), now = Date.now(), mainTipTimeMs = null } = {}) {
  if (!poolRoot) return [];
  const out = [];
  for (const pool of poolsWithLanes(poolRoot)) {
    for (const lane of laneIndicesIn(join(poolRoot, pool))) {
      const cwd = join(poolRoot, pool, `lane-${lane}`);
      const row = { pool, lane, head: null, behind: null, behindSinceMs: null, headLagMs: null, forgeExecHasPrune: null };
      try {
        const source = String(readFile(join(cwd, 'scripts/readiness/forge-exec-run.mjs'), 'utf8'));
        // Ignore prose and quoted code before locating the function's balanced body.
        const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g, ' ');
        const start = /\bfunction\s+parseTelemetry\s*\([^)]*\)\s*\{/.exec(code);
        let parser = '';
        if (start) {
          const bodyStart = start.index + start[0].length;
          let depth = 1;
          for (let i = bodyStart; i < code.length; i++) {
            if (code[i] === '{') depth++;
            if (code[i] === '}' && --depth === 0) {
              parser = code.slice(bodyStart, i);
              break;
            }
          }
        }
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
        const count = readGit(['rev-list', '--count', 'HEAD..origin/main']);
        if (/^\d+$/.test(count) && Number.isSafeInteger(Number(count))) {
          row.behind = Number(count);
          if (row.behind > 0) {
            const oldest = readGit(['log', '--reverse', '--format=%ct', 'HEAD..origin/main']).split('\n')[0];
            const timestamp = /^\d+$/.test(oldest) ? Number(oldest) * 1000 : NaN;
            if (Number.isFinite(timestamp) && timestamp <= now) row.behindSinceMs = timestamp;
          }
        }
      } catch { /* missing refs, timeout or oversized output: retain only proven evidence */ }
      if (Number.isFinite(mainTipTimeMs)) {
        try {
          const headTime = readGit(['log', '-1', '--format=%ct', 'HEAD']);
          if (/^\d+$/.test(headTime) && Number.isFinite(Number(headTime) * 1000)) {
            row.headLagMs = mainTipTimeMs - Number(headTime) * 1000;
          }
        } catch { /* unreadable HEAD time stays unknown */ }
      }
      out.push(row);
    }
  }
  return out;
}
