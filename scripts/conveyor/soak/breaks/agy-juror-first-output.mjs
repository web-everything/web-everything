/** A silent agy launch must be killed promptly and held across provider backends. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SPAWN = 'scripts/lib/antigravity-judge-spawn.mjs';

export async function probe(sourceRoot = REPO_ROOT) {
  const { antigravityJudgeSpawn } = await import(pathToFileURL(join(sourceRoot, SPAWN)).href);
  const { readAgyHold, saveAgyHold } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/antigravity-run-evidence.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'soak-agy-liveness-'));
  let kills = 0; let spawns = 0; let killedAt = null;
  const started = Date.now();
  let watchdog;
  const opts = { mandate: 'review', input: 'fixture', shape: {}, env: {}, firstOutputMs: 20, cooldownMs: 1000,
    timeoutMs: 150, persistTranscript: () => null, recordScorecard: () => {},
    readHold: model => readAgyHold(model, { dir }), saveHold: row => saveAgyHold(row, { dir }),
    spawnFn: () => {
      spawns++;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { kills++; killedAt = Date.now(); child.emit('close', null); };
      // Bounds the replay on an unfixed tree, independently of production timers.
      watchdog = setTimeout(() => child.emit('error', new Error('probe watchdog expired')), 300);
      return child;
    } };
  try {
    const error = await antigravityJudgeSpawn({ ...opts, model: 'claude-sonnet-4-6' }).catch(e => e);
    clearTimeout(watchdog);
    const firstSpawns = spawns;
    const next = await antigravityJudgeSpawn({ ...opts, model: 'gemini-3.1-pro' }).catch(e => e);
    const violations = [];
    if (kills !== 1 || killedAt - started > 130) violations.push('silent child not killed within first-output window');
    if (error?.telemetry?.fallbackDecision !== 'skip-provider-unresponsive') violations.push('missing provider-unresponsive evidence');
    if (firstSpawns !== 1 || spawns !== 1 || next?.telemetry?.quotaState !== 'provider-unresponsive') violations.push('binary-wide cooldown did not skip next launch');
    if (!error?.message?.includes('first-output window 20 ms; cooldown 1000 ms')) violations.push('missing window/cooldown summary');
    return { violations };
  } finally { clearTimeout(watchdog); rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'agy-juror-first-output', title: 'silent agy jurors spend the entire review wall at launch',
  card: 'external CLI first-output liveness', fixedBy: { sha: 'working-tree', where: SPAWN, paths: [SPAWN] },
  fixPresent(root) {
    // The shared harness requires a synchronous predicate. Decide by running the real spawn boundary.
    try {
      const code = `import { probe } from ${JSON.stringify(import.meta.url)}; const r = await probe(process.argv[1]); process.exit(r.violations.length ? 1 : 0);`;
      execFileSync(process.execPath, ['--input-type=module', '-e', code, root], { timeout: 10000, stdio: 'pipe' });
      return true;
    } catch { return false; }
  },
  run: ({ sourceRoot = REPO_ROOT } = {}) => probe(sourceRoot),
  judge: report => report.violations,
};
