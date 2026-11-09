/**
 * Pre-install soak scope: seed the harness tree and config, then follow local
 * imports and literal repository paths (including scripts launched/read by tests).
 * This is a conservative source scan, never an execution of PR code. Unreadable
 * evidence makes the CLI request the soak rather than silently skipping it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export function computeSoakClosure({ root = DEFAULT_ROOT } = {}) {
  root = resolve(root);
  const closure = new Set();
  const pending = [];
  const inside = (path) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const add = (path, scan = true) => {
    if (!inside(path)) return;
    const key = relative(root, path).split(sep).join('/');
    if (closure.has(key)) return;
    closure.add(key);
    if (scan) pending.push(path);
  };
  const seed = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) seed(path);
      else if (entry.isFile()) add(path);
      else throw new Error('Unsupported soak seed entry');
    }
  };
  const isFile = (path) => {
    try { return statSync(path).isFile(); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const follow = (base) => {
    if (!inside(base)) return;
    const candidates = [base];
    if (!extname(base)) {
      for (const suffix of ['.mjs', '.js', '.cjs', '.ts', '.mts', '.tsx', '/index.mjs', '/index.js', '/index.ts']) {
        candidates.push(`${base}${suffix}`);
      }
    }
    for (const candidate of candidates) {
      if (isFile(candidate)) { add(candidate); return; }
    }
    // A deleted dependency is still in scope. Preserve every resolution candidate
    // without trying to read it; this also covers extensionless deleted imports.
    for (const candidate of candidates) add(candidate, false);
  };

  seed(resolve(root, 'scripts/conveyor/soak'));
  const config = resolve(root, 'vitest.soak.config.ts');
  if (!isFile(config)) throw new Error('Missing soak configuration');
  add(config);
  while (pending.length) {
    const file = pending.pop();
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    // Over-approximate: literals in comments/fixtures may widen scope too.
    // `import'x'`, `export*from"x"` and `import(\`x\`)` are valid: whitespace is optional, and
    // dynamic import/require may take a template literal.
    for (const match of source.matchAll(/(?:\bfrom|\bimport(?:\s*\()?|\brequire\s*\()\s*(['"`])([^'"`\r\n]+)\1/g)) {
      if (match[2].startsWith('./') || match[2].startsWith('../')) {
        follow(resolve(dirname(file), match[2]));
      }
    }
    for (const match of source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)) {
      // Repo-root literals cover spawn/readFile/new URL targets that are not imports.
      const path = match[2].replace(/^\.\//, '');
      if (/^(?:scripts|src|tools|skills-src)\//.test(path)) follow(resolve(root, path));
    }
  }
  return closure;
}

export function soakScopeRun({ root = DEFAULT_ROOT, changed } = {}) {
  try {
    if (!Array.isArray(changed) || changed.some((path) => typeof path !== 'string')) return true;
    const closure = computeSoakClosure({ root });
    return changed.some((path) => closure.has(path));
  } catch {
    return true;
  }
}

// Keep the pre-install safeguards executable in CI without npm dependencies.
async function selfTest() {
  const { test } = await import('node:test');
  const assert = await import('node:assert/strict');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const cli = fileURLToPath(import.meta.url);
  const dependency = 'fixture/dependency.mjs';
  const scopeCase = (name, prepare, changed, expected) => test(name, () => {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-scope-self-test-'));
    const seed = join(root, 'scripts/conveyor/soak');
    try {
      mkdirSync(seed, { recursive: true });
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'vitest.soak.config.ts'), 'export default {};');
      writeFileSync(join(root, dependency), 'export const value = true;');
      writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency.mjs';");
      prepare({ root, seed });
      assert.equal(soakScopeRun({ root, changed: [changed] }), expected);
      const result = spawnSync(process.execPath, [cli], {
        input: `${changed}\n`, encoding: 'utf8', timeout: 25_000,
        maxBuffer: 1024 * 1024, env: { ...process.env, SOAK_SCOPE_ROOT: root },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `run=${expected}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await scopeCase('unreadable seed evidence requests the soak', ({ seed }) => {
    rmSync(seed, { recursive: true });
    // A self-referential link deterministically causes ELOOP, even under root.
    symlinkSync('soak', seed, 'dir');
  }, 'backlog/unrelated.md', true);
  await scopeCase('unreadable dependency evidence requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
    symlinkSync('dependency.mjs', join(root, dependency));
  }, 'backlog/unrelated.md', true);
  await scopeCase('deleted dependency outside legacy scope requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
  }, dependency, true);
  await scopeCase('deleted extensionless dependency requests the soak', ({ root, seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency';");
    rmSync(join(root, dependency));
  }, dependency, true);
  await scopeCase('discovers dependencies without executing their source', ({ root }) => {
    writeFileSync(join(root, dependency), "throw new Error('executed');\nimport'./transitive.mjs';");
    writeFileSync(join(root, 'fixture/transitive.mjs'), 'export const t = 1;');
  }, 'fixture/transitive.mjs', true);
  await scopeCase('unrelated changes skip the soak with readable evidence', () => {}, 'backlog/unrelated.md', false);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') {
    await selfTest();
  } else {
    let run = true;
    try {
      const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
      run = soakScopeRun({ root: process.env.SOAK_SCOPE_ROOT || DEFAULT_ROOT, changed });
    } catch { /* Missing stdin is incomplete evidence: run the soak. */ }
    process.stdout.write(`run=${run}\n`);
  }
}
