/** Diff-pinned local soak selection and exact-file execution (MQ-SOAK-PULLS).
 * Imports read default.fixedBy only. Registry top-level effects also run: today the
 * registry's read-only `sh -c 'command -v git'` lookup is the accepted exception.
 * Nothing calls fixPresent/run, starts a soak world, or excuses a failing break.
 */
import { existsSync, statSync, readFileSync, readdirSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BREAKS = 'scripts/conveyor/soak/breaks/';
const TEST = /^scripts\/conveyor\/soak\/breaks\/[^/]+\.soak\.test\.mjs$/;
const slash = path => path.split(sep).join('/');
const detail = error => String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500);
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function canonicalFile(root, file) {
  if (typeof file !== 'string' || isAbsolute(file) || !TEST.test(file)) throw Error(`invalid soak file: ${file}`);
  const dir = realpathSync(join(root, BREAKS));
  const actual = realpathSync(join(root, file));
  const inside = relative(dir, actual);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(actual).isFile()) {
    throw Error(`soak file escapes breaks directory or is not a file: ${file}`);
  }
  // A symlinked breaks directory must also stay in the target repository.
  const inRoot = relative(root, actual);
  if (inRoot.startsWith(`..${sep}`) || isAbsolute(inRoot) || !slash(inRoot).startsWith(BREAKS)) throw Error(`soak file escapes repository: ${file}`);
  return slash(inRoot);
}

export async function selectTargetedBreaks({ root, changed, timings, cap = 64, budgetSeconds = 900,
  importModule = url => import(url), now = () => performance.now(), importTimeoutMs = 10000 } = {}) {
  const deferred = (reason, files = [], estSeconds = 0, error) => ({ status: 'deferred', reason, files, estSeconds,
    ...(error ? { detail: detail(error) } : {}) });
  if (!Array.isArray(changed) || changed.some(file => typeof file !== 'string' || !file.length)) return deferred('changed-set-unknown');
  const selected = new Set();
  try {
    root = realpathSync(root);
    if (!statSync(join(root, 'vitest.soak.config.ts')).isFile()) throw Error('missing vitest.soak.config.ts');
    const entries = readdirSync(join(root, BREAKS)).sort();
    if (entries.length > 8192) throw Error('break registry exceeds 8192 entries; inspect registry before rerunning verify');
    const changedSet = new Set(changed);
    const deadline = now() + importTimeoutMs;
    for (const name of entries) {
      if (!name.endsWith('.mjs') || name.endsWith('.soak.test.mjs') || name === 'index.mjs') continue;
      const scenario = `${BREAKS}${name}`;
      const test = scenario.replace(/\.mjs$/, '.soak.test.mjs');
      if (!entries.includes(name.replace(/\.mjs$/, '.soak.test.mjs'))) continue;
      let timer;
      let module;
      try {
        const remaining = deadline - now();
        if (!(remaining > 0)) throw Error('registry import deadline exceeded; inspect imports and rerun verify');
        module = await Promise.race([
          importModule(pathToFileURL(join(root, scenario)).href),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('registry import timed out; inspect imports and rerun verify')), remaining); }),
        ]);
      } catch (error) { throw Error(`${scenario}: ${detail(error)}`); }
      finally { clearTimeout(timer); }
      if (!module?.default || typeof module.default !== 'object') throw Error(`${scenario}: missing default break metadata`);
      const paths = module.default.fixedBy?.paths;
      if (paths !== undefined && (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path))) throw Error(`${scenario}: malformed fixedBy.paths`);
      if (changedSet.has(scenario) || changedSet.has(test) || paths?.some(path => changedSet.has(path))) selected.add(canonicalFile(root, test));
    }
  } catch (error) { return deferred('selector-error', [], 0, error); }
  const files = [...selected].sort();
  if (!files.length) return { status: 'none', files, estSeconds: 0 };
  let soak;
  try {
    if (timings === undefined) {
      const path = join(root, 'scripts/ci/test-timings.json');
      if (statSync(path).size > 8 * 1024 * 1024) throw Error('timings exceed read bound');
      timings = JSON.parse(readFileSync(path, 'utf8'));
    }
    soak = timings?.soak;
    if (!soak || typeof soak !== 'object' || Array.isArray(soak)) throw Error('no soak timings');
  } catch { return deferred('timings-unavailable', files); }
  const population = Object.entries(soak).filter(([file, value]) => TEST.test(file) && validTime(value)).map(([, value]) => value).sort((a, b) => a - b);
  if (!population.length) return deferred('timings-unavailable', files);
  const median = population[Math.floor((population.length - 1) / 2)];
  const estSeconds = files.reduce((sum, file) => sum + (validTime(soak[file]) ? soak[file] : median), 0);
  if (!validTime(estSeconds) || !validTime(cap) || !validTime(budgetSeconds) || files.length > cap || estSeconds > budgetSeconds) return deferred('over-budget', files, estSeconds);
  return { status: 'run', files, estSeconds };
}

/** Cache selection is current evidence; transient deferrals must be retried. */
export function soakCacheOk(record, selection, gateExplicit) {
  if (selection?.status === 'none') return true;
  const old = record?.phases?.soak;
  if (!selection || !old || !Array.isArray(old.files) || !Array.isArray(selection.files)
    || JSON.stringify(old.files) !== JSON.stringify(selection.files)) return false;
  // A genuine operator override requests no soak. Its own previously skipped
  // evidence can reuse the existing sha/tree/command cache; defaults cannot.
  if (gateExplicit === true && old.status === 'skipped' && old.reason === 'explicit-gate') return true;
  if (old.status === 'skipped' && old.reason === 'explicit-gate' && gateExplicit !== true) return false;
  if (selection.status === 'run') return old.status === 'passed';
  return selection.status === 'deferred' && selection.reason === 'over-budget'
    && (old.status === 'passed' || (old.status === 'deferred' && old.reason === 'over-budget'));
}

export async function runTargetedBreaks({ root, files, report, spawnFn = spawn, tempRoot = tmpdir(), stderr = message => process.stderr.write(`${message}\n`) }) {
  let temporary;
  let code = 2;
  try {
    root = realpathSync(root);
    if (!Array.isArray(files) || !files.length) throw Error('empty soak file list');
    if (files.length > 64) throw Error('soak file list exceeds 64; use the merge queue for over-budget selections');
    if (!statSync(join(root, 'vitest.soak.config.ts')).isFile()) throw Error('missing vitest.soak.config.ts');
    const canonical = [...new Set(files.map(file => canonicalFile(root, file)))].sort();
    const include = canonical.map(file => join(root, file).replace(/[\[\]{}()*?!+@\\]/g, '\\$&'));
    temporary = mkdtempSync(join(tempRoot, 'we-soak-'));
    const config = join(temporary, 'vitest.targeted.config.mjs');
    writeFileSync(config, `import base from ${JSON.stringify(join(root, 'vitest.soak.config.ts'))};
export default async env => {
  const config = await (typeof base === 'function' ? base(env) : base);
  return { ...config, test: { ...config.test, include: ${JSON.stringify(include)} } };
};\n`);
    const reporterArgs = report ? ['--reporter=default', '--reporter=json', `--outputFile.json=${report}`] : [];
    code = await new Promise(resolveExit => {
      const child = spawnFn('npx', ['vitest', 'run', '--config', config, ...reporterArgs], { cwd: root, stdio: 'inherit', timeout: 2700000 });
      child.once('error', error => { stderr(`targeted-soak: spawn-error: ${detail(error)}`); resolveExit(1); });
      child.once('close', (exit, signal) => resolveExit(signal || !Number.isInteger(exit) ? 1 : exit));
    });
  } catch (error) { stderr(`targeted-soak: refused: ${detail(error)}`); }
  finally {
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { stderr(`targeted-soak: cleanup-failed: ${detail(error)}`); code = 1; }
    }
  }
  return code;
}

export async function targetedBreaksCli(argv, { cwd = process.cwd(), spawnFn = spawn, stderr = message => process.stderr.write(`${message}\n`), stdout = message => process.stdout.write(`${message}\n`) } = {}) {
  const [mode, ...rest] = argv;
  const separator = rest.indexOf('--');
  const options = mode === 'run' && separator >= 0 ? rest.slice(0, separator) : rest;
  const rootArg = options.find(arg => arg.startsWith('--root='));
  const root = rootArg ? rootArg.slice(7) : cwd;
  if (mode === 'run' && separator >= 0 && options.every(arg => /^--(?:root|report)=.+/.test(arg))) {
    return runTargetedBreaks({ root, files: rest.slice(separator + 1), report: options.find(arg => arg.startsWith('--report='))?.slice(9), spawnFn, stderr });
  }
  if (mode === 'plan' && options.every(arg => /^--(?:root|changed-file)=.+/.test(arg)) && options.some(arg => arg.startsWith('--changed-file='))) {
    let changed = null;
    try {
      const path = options.find(arg => arg.startsWith('--changed-file=')).slice(15);
      if (statSync(path).size > 8 * 1024 * 1024) throw Error('changed list exceeds read bound');
      changed = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n');
    } catch (error) { stderr(`targeted-soak: changed-set-unknown: ${detail(error)}`); }
    const selection = await selectTargetedBreaks({ root, changed });
    stdout(JSON.stringify(selection));
    return 0;
  }
  stderr('targeted-soak: refused: use plan --changed-file=<path> or run [--root=<checkout>] [--report=<path>] -- <files>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await targetedBreaksCli(process.argv.slice(2));
