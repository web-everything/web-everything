/**
 * Read-only pool-lane checkout evidence. Uses local refs plus the host main-tip time, never fetches,
 * and preserves unknown evidence on IO failure. Daemon clones belong to cloneLag instead.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';
import { basename, join } from 'node:path';
import { laneIndicesIn, poolsWithLanes } from '../lib/lane-pool-scan.mjs';

// Only string telemetry is exercised. These lexical helpers stay inside the VM;
// no host objects, Node globals, imports or lane top-level code are exposed.
const telemetryHarness = `
  const Buffer = { isBuffer: () => false, byteLength: text => text.length };
  const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === keys;
  const validET = value => value === '2026-11-17T12:00:00.000-05:00';
  const duration = value => Number.isSafeInteger(value) && value >= 0;
  const runName = value => typeof value === 'string' && /^r-[a-f0-9]{32}$/.test(value);
  const validPruneStatus = value => exactKeys(value, 'consecutiveRefused,lastRefusal')
    && duration(value.consecutiveRefused) && typeof value.lastRefusal === 'string';
  const sample = {
    sampledAtET: '2026-11-17T12:00:00.000-05:00', cores: 8, loadPerCore: 0.25,
    memFreePct: 60, activeRuns: 0, recent: [], diskUsedPct: 73,
    prune: { consecutiveRefused: 2, lastRefusal: 'active cache' }
  };
`;

// Only this fixed driver executes in Node's main context. Lane code arrives over
// stdin and runs in a VM inside the disposable, heap-capped child process.
const telemetryChild = `
  import { readFileSync } from 'node:fs';
  import { runInNewContext } from 'node:vm';
  try {
    const result = runInNewContext(readFileSync(0, 'utf8'), Object.create(null), {
      timeout: 250,
      microtaskMode: 'afterEvaluate',
      contextCodeGeneration: { strings: false, wasm: false },
    });
    process.stdout.write(result === true ? 'true' : 'false');
  } catch { process.stdout.write('false'); }
`;

function probeTelemetry(source) {
  let declaration;
  try {
    const ast = parse(source, { ecmaVersion: 2021, sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
    declaration = ast.body.map(node => node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      ? node.declaration : node).find(node => node?.type === 'FunctionDeclaration' && node.id?.name === 'parseTelemetry');
  } catch { return null; }
  if (!declaration) return null;
  try {
    const program = `(() => {
      ${telemetryHarness}
      ${source.slice(declaration.start, declaration.end)}
      const result = parseTelemetry(JSON.stringify(sample));
      if (result?.diskUsedPct !== sample.diskUsedPct
        || result?.prune?.consecutiveRefused !== sample.prune.consecutiveRefused
        || result?.prune?.lastRefusal !== sample.prune.lastRefusal) return false;
      // A raw JSON.parse return preserves fields too: require schema handling.
      for (const invalid of [{ ...sample, prune: null }, { ...sample, diskUsedPct: '73' }]) {
        let rejected = false;
        try { parseTelemetry(JSON.stringify(invalid)); } catch { rejected = true; }
        if (!rejected) return false;
      }
      return true;
    })()`;
    // Native allocations are outside the VM timeout and share its heap. Isolate
    // them from health-watch, cap the child's V8 heap, and kill it on wall timeout.
    // The fixed shell prefix disables OOM core dumps; all data uses argv/stdin.
    const result = execFileSync('sh', ['-c', 'ulimit -c 0 && exec "$@"', 'lane-telemetry-probe',
      process.execPath, '--max-old-space-size=32', '--max-semi-space-size=4',
      '--input-type=module', '--eval', telemetryChild], {
      input: program, encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096,
      env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result === 'true';
  } catch { return false; } // Child failure, OOM, timeout or wrong output is failed evidence.
}

/**
 * @param {{poolRoot?: string|null, readFile?: Function, readdir?: Function, git?: Function, now?: number, mainTipTimeMs?: number|null}} [options]
 * `git(args, {cwd, timeout, maxBuffer})` returns stdout or throws; readFile follows readFileSync.
 * @returns {Array<{pool:string, unreadable:true, path:string}|{pool:string, lane:number, head:string|null, behind:number|null, behindSinceMs:number|null, headLagMs:number|null, forgeExecHasPrune:boolean|null}>}
 */
export function probeLaneCheckouts({ poolRoot, readFile = readFileSync, readdir = readdirSync, git = (args, options) => execFileSync('git', args, options), now = Date.now(), mainTipTimeMs = null } = {}) {
  if (poolRoot == null) return [];
  // The shared scanner deliberately swallows IO errors. Verify the root first,
  // and refuse an empty scan so health-watch records probe failure, not a clean tick.
  const entries = readdir(poolRoot);
  const unreadable = new Set();
  const readPool = (pool) => {
    try { return readdir(join(poolRoot, pool)); }
    catch (error) {
      // Root-level sentinel files are not pools; other failures are unknown evidence.
      if (error.code !== 'ENOTDIR') unreadable.add(pool);
      return [];
    }
  };
  for (const pool of entries) readPool(pool);
  const pools = poolsWithLanes(poolRoot, {
    readdir: path => path === poolRoot ? readdir(path) : readPool(basename(path)),
  });
  // Check again: the shared scan can swallow a pool becoming unreadable mid-scan.
  const namesByPool = new Map([...new Set([...entries, ...pools])].map(pool => [pool, readPool(pool)]));
  if (!pools.length) throw new Error('Lane checkout probe found no pools');
  const out = [];
  for (const pool of new Set([...pools, ...unreadable])) {
    if (unreadable.has(pool)) {
      out.push({ pool, unreadable: true, path: join(poolRoot, pool) });
      continue;
    }
    for (const lane of laneIndicesIn(join(poolRoot, pool), { readdir: () => namesByPool.get(pool) })) {
      const cwd = join(poolRoot, pool, `lane-${lane}`);
      const row = { pool, lane, head: null, behind: null, behindSinceMs: null, headLagMs: null, forgeExecHasPrune: null };
      try {
        const source = String(readFile(join(cwd, 'scripts/readiness/forge-exec-run.mjs'), 'utf8'));
        row.forgeExecHasPrune = probeTelemetry(source);
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
          const fork = readGit(['merge-base', 'HEAD', 'origin/main']);
          if (!fork) throw new Error('Missing lane fork point');
          const times = [fork, 'origin/main'].map(ref => readGit(['log', '-1', '--format=%ct', ref]));
          if (times.every(time => /^\d+$/.test(time) && Number.isFinite(Number(time) * 1000))) {
            row.headLagMs = Math.max(...times.map(time => mainTipTimeMs - Number(time) * 1000));
          }
        } catch { /* unreadable fork point or local main time stays unknown */ }
      }
      out.push(row);
    }
  }
  return out;
}
