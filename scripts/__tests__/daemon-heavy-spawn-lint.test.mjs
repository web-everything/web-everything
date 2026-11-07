// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUngatedHeavySpawns } from '../lib/heavy-spawn-lint.mjs';

const cp = "import { spawnSync } from 'node:child_process';\n";
describe('daemon heavy spawn admission lint', () => {
  it.each([
    "spawnSync('grep', ['vitest', 'x']);",
    "spawnSync('echo', ['npx vitest run']);",
    "spawnSync('npx', ['vitest', '--version']);",
    "spawnSync('vitest', ['--help']);",
    "spawnSync('node', ['light.mjs', 'vitest']);",
    "spawnSync('sh', ['-c', 'echo npx vitest run']);",
  ])('ignores harmless executable arguments: %s', call => {
    expect(findUngatedHeavySpawns(cp + call)).toEqual([]);
  });
  it.each([
    "spawnSync('pnpm', ['exec', 'playwright', 'test', 'a']);",
    "spawnSync('yarn', ['vitest', 'run', 'a']);",
    "spawnSync('sh', ['-c', 'npx vitest run a']);",
  ])('detects the executed heavy target: %s', call => {
    expect(findUngatedHeavySpawns(cp + call)).toHaveLength(1);
  });
  // Self-review #6461: nested substitutions are inspected once each; a pathological nest fails closed.
  const ex = "import { execSync } from 'node:child_process';\n";
  const nest = (levels, inner) => Array.from({ length: levels }).reduce(cmd => `echo $(${cmd})`, inner);
  it('inspects nested substitutions without combinatorial growth', () => {
    const started = Date.now();
    expect(findUngatedHeavySpawns(ex + `execSync(${JSON.stringify(nest(20, 'echo hi'))});`)).toEqual([]);
    expect(findUngatedHeavySpawns(ex + `execSync(${JSON.stringify(nest(5, 'npm test'))});`)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it.each([['a deep unclosed nest', '$('.repeat(8000)], ['too many substitutions', 'echo $(a) '.repeat(300)]])(
    'fails closed on %s', (_, command) => {
      expect(findUngatedHeavySpawns(ex + `execSync(${JSON.stringify(command)});`)).toHaveLength(1);
    });
  // Red-team #6461: package test scripts and Node's own test runner are unqueued heavy entry points too.
  it.each([
    "spawnSync('npm', ['test', '--', 'a.test.mjs']);",
    "spawnSync('npm', ['test']);",
    "spawnSync('npm', ['t']);",
    "spawnSync('npm', ['run', 'test']);",
    "spawnSync('npm', ['--prefix', '.', 'test']);",
    "spawnSync('pnpm', ['test']);",
    "spawnSync('yarn', ['test']);",
    "spawnSync('bun', ['run', 'test']);",
    "spawnSync('node', ['--test', 'a.test.mjs']);",
    "spawnSync('node', ['--test']);",
    "spawnSync('node', ['--test-reporter=spec', '--test', 'a.test.mjs']);",
    "spawnSync('env', ['CI=1', 'npm', 'test']);",
    "spawnSync('sh', ['-c', 'npm test -- a.test.mjs']);",
    "execSync('npm test -- a.test.mjs');",
    "execSync('node --test a.test.mjs');",
    "spawnSync('node', ['--run', 'test']);",
    "spawnSync('npm', ['it']);",
    "spawnSync('npm', ['cit']);",
    "spawnSync('corepack', ['pnpm', 'test']);",
    "spawnSync('/usr/bin/env', ['npm', 'test']);",
    "spawnSync('npx', ['--yes', 'bun@1.4.2', 'test']);",
    "spawnSync(process.execPath, ['--test', 'a.test.mjs']);",
    "execSync('echo $(npm test)');",
    "execSync('echo `node --test a.test.mjs`');",
  ])('detects unqueued package test / node --test entry points: %s', call => {
    expect(findUngatedHeavySpawns(cp.replace('spawnSync }', 'spawnSync, execSync }') + call)).toHaveLength(1);
  });
  // Self-review #6461 (round 2): the same class through package scripts, spreads, Node-binary spellings,
  // shell options and escaped nested `sh -c`.
  const all = "import { spawnSync, execSync, execFileSync } from 'node:child_process';\n";
  it.each([
    "spawnSync('npm', ['run', 'test:bun:scripts']);",
    "execSync('npm run test:bun:scripts');",
    "const a = ['--test', 'x.mjs']; spawnSync('node', [...a, 'y']);",
    "const a = ['test', '--', 'x']; spawnSync('npm', [...a]);",
    'execSync(`${process.execPath} --test a`);',
    "const { execPath } = process; spawnSync(execPath, ['--test']);",
    "spawnSync(process['execPath'], ['--test']);",
    "spawnSync(process.argv[0], ['--test']);",
    "spawnSync(globalThis.process.execPath, ['--test']);",
    "execSync('sh -c \"sh -c \\\\\"npm test\\\\\"\"');",
    "spawnSync('npm test', { shell: true });",
    "spawnSync('echo', ['$(npm test)'], { shell: true });",
    "execFileSync('npm', ['test'], { shell: '/bin/sh' });",
    "spawnSync('bash', ['-o', 'pipefail', '-c', 'npm test']);",
    "spawnSync('bash', ['-ce', 'npm test']);",
    "execSync(\"bash -euo pipefail -c 'npm test'\");",
    "spawnSync('npm', ['--loglevel', 'silent', 'run', 'test:bun:scripts']);",
    "import { execPath } from 'node:process'; spawnSync(execPath, ['--test']);",
    "import proc from 'node:process'; spawnSync(proc.execPath, ['--test']);",
  ])('detects same-class spelling: %s', call => {
    expect(findUngatedHeavySpawns(all + call)).toHaveLength(1);
  });
  it.each([
    "spawnSync('npm', ['run', 'test:e2e']);",
    "spawnSync('gh', ['pr', 'comment', '42', '--body', '" + '`'.repeat(280) + "']);",
    "spawnSync('git', ['commit', '-m', '" + 'x'.repeat(17000) + "']);",
    "spawnSync('echo', ['$(npm test)'], { shell: false });",
    "const { execPath } = other; spawnSync(execPath, ['--test']);",
    "spawnSync('sh', ['script.sh']);",
    "spawnSync('bash', ['-o', 'pipefail', 'script.sh', '-c', 'npm test']);",
  ])('leaves plain-argv data and queued scripts alone: %s', call => {
    expect(findUngatedHeavySpawns(all + call)).toEqual([]);
  });
  // Self-review #6461 (round 3): npm value options, launchers, case-folded names, fork execArgv, joined strings
  // and shell-fed heredocs.
  const withFork = "import { spawnSync, execSync, fork } from 'node:child_process';\n";
  it.each([
    "spawnSync('npm', ['--loglevel', 'silent', 'test']);",
    "spawnSync('npm', ['--tag', 'x', 'test']);",
    "spawnSync('nohup', ['npm', 'test']);",
    "execSync('nohup npm test');",
    "execSync(\"eval 'npm test'\");",
    "spawnSync('NPM', ['test']);",
    "fork('a.test.mjs', [], { execArgv: ['--test'] });",
    "fork('a.test.mjs', { execArgv: flags });",
    "spawnSync('node', ['--te' + 'st', 'a.test.mjs']);",
    "spawnSync('n' + 'pm', ['test']);",
    "spawnSync('node', [`--te${'st'}`]);",
    "execSync('bash <<EOF\\nnpm test\\nEOF');",
  ])('detects launcher / joined / fork spellings: %s', call => {
    expect(findUngatedHeavySpawns(withFork + call)).toHaveLength(1);
  });
  it.each([
    "execSync('git commit -m \"" + 'x'.repeat(17000) + "\"');",
    "execSync('cat <<EOF\\nnpm test\\nEOF');",
    "fork('worker.mjs', [], { execArgv: ['--max-old-space-size=4096'] });",
    "fork('worker.mjs');",
    "spawnSync('npm', ['--loglevel', 'silent', 'run', 'build']);",
    "spawnSync('nohup', ['node', 'x.mjs']);",
  ])('leaves long plain commands, heredoc data and plain forks alone: %s', call => {
    expect(findUngatedHeavySpawns(withFork + call)).toEqual([]);
  });
  it('resolves package scripts through the given table and fails closed when it is unreadable', () => {
    const call = "spawnSync('npm', ['run', 'ci:all']);";
    expect(findUngatedHeavySpawns(all + call, 's.mjs', { scripts: { 'ci:all': 'npm run lint && vitest run' } })).toHaveLength(1);
    expect(findUngatedHeavySpawns(all + call, 's.mjs', { scripts: { 'ci:all': 'npm run lint' } })).toEqual([]);
    expect(findUngatedHeavySpawns(all + "spawnSync('npm', ['run', 'test:x']);", 's.mjs', { scripts: null })).toHaveLength(1);
    expect(findUngatedHeavySpawns(all + "spawnSync('npm', ['run', 'test:unit']);", 's.mjs', { scripts: null })).toEqual([]);
  });
  it.each([
    "spawnSync('npm', ['run', 'test:unit', '--', 'a.test.mjs']);",
    "spawnSync('npm', ['run', 'check:standards']);",
    "spawnSync('npm', ['install']);",
    "spawnSync('node', ['--check', 'a.mjs']);",
    "spawnSync('node', ['scripts/readiness/heavy-admission.mjs', 'run', '--', 'node', '--test', 'a.test.mjs']);",
    "spawnSync('echo', ['$(npm test)']);",
    "spawnSync(process.execPath, ['scripts/light.mjs', '--test']);",
    "spawnSync('node', ['--run', 'build']);",
  ])('leaves queued scripts and non-test commands alone: %s', call => {
    expect(findUngatedHeavySpawns(cp + call)).toEqual([]);
  });
  it.each([
    "spawnSync('vitest'); // heavy-admission-allow: parent holds slot\nspawnSync('vitest');",
    "// heavy-admission-allow: parent holds slot\nspawnSync('vitest'); spawnSync('vitest');",
    "spawnSync('vitest'); spawnSync('vitest'); // heavy-admission-allow: parent holds slot",
    "// heavy-admission-allow: parent holds slot\nspawnSync('echo'); spawnSync('vitest');",
  ])('limits each allowance to one spawn: %s', calls => {
    expect(findUngatedHeavySpawns(cp + calls)).toHaveLength(1);
  });
  it('reports an unadmitted literal heavy spawn (red fixture)', () => {
    expect(findUngatedHeavySpawns(cp + "spawnSync('npx', ['vitest', 'run']);", 'bad.mjs')).toHaveLength(1);
  });
  it.each(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])('recognizes %s and aliases', name => {
    expect(findUngatedHeavySpawns(`import { ${name} as run } from 'child_process'; run('playwright test a');`)).toHaveLength(1);
  });
  it('follows literal argument bindings and namespace spawns', () => {
    expect(findUngatedHeavySpawns("import * as cp from 'node:child_process'; const args = ['check-standards.mjs']; cp.spawn('node', args);")).toHaveLength(1);
  });
  it('respects shadowed argument bindings', () => {
    expect(findUngatedHeavySpawns(cp + "const args = ['vitest']; function safe(args) { spawnSync('node', args); }")).toEqual([]);
  });
  it('recognizes promisified child_process calls', () => {
    expect(findUngatedHeavySpawns("import { exec } from 'node:child_process'; import { promisify } from 'node:util'; const run = promisify(exec); run('vitest run a');")).toHaveLength(1);
  });
  it('recognizes heavy command template literals', () => {
    expect(findUngatedHeavySpawns(cp + 'spawnSync(`npx vitest run ${file}`);')).toHaveLength(1);
  });
  it('rejects an allowance mentioned in a string rather than a comment', () => {
    expect(findUngatedHeavySpawns(cp + "const text = '// heavy-admission-allow: fake'; spawnSync('vitest');")).toHaveLength(1);
  });
  it('accepts a file using the imported admission helper', () => {
    expect(findUngatedHeavySpawns(cp + "import { admittedArgv as admit } from './readiness/heavy-admission.mjs'; const a = admit('npx', ['vitest']); spawnSync(a.file, a.args);")).toEqual([]);
  });
  it('rejects an unrelated unadmitted spawn beside an admitted call', () => {
    const source = cp + "import { admittedArgv } from './readiness/heavy-admission.mjs';\n"
      + "const a = admittedArgv('node', ['light.mjs']); spawnSync(a.file, a.args);\n"
      + "spawnSync('vitest', ['run']);";
    expect(findUngatedHeavySpawns(source, 'mixed.mjs')).toEqual([
      expect.objectContaining({ filename: 'mixed.mjs', line: 4 }),
    ]);
  });
  it('requires both spawn arguments to come from the same admitted invocation', () => {
    const source = cp + "import { admittedArgv } from './readiness/heavy-admission.mjs';"
      + "const a = admittedArgv('vitest', ['run']); const b = admittedArgv('node', ['light.mjs']);";
    expect(findUngatedHeavySpawns(source + 'spawnSync(a.file, b.args);')).toHaveLength(1);
    expect(findUngatedHeavySpawns(source + "spawnSync(a.file, ['vitest']);")).toHaveLength(1);
  });
  it('traces aliases of the admitted result and its fields', () => {
    expect(findUngatedHeavySpawns(cp + "import { admittedArgv } from './readiness/heavy-admission.mjs';"
      + "const a = admittedArgv('vitest', ['run']); const alias = a; const file = alias.file; const args = a.args; spawnSync(file, args);")).toEqual([]);
  });
  it('does not trust a shadowed admission helper', () => {
    expect(findUngatedHeavySpawns(cp + "import { admittedArgv } from './readiness/heavy-admission.mjs';"
      + "function run(admittedArgv) { const a = admittedArgv('vitest', ['run']); spawnSync(a.file, a.args); }")).toHaveLength(1);
  });
  it('limits runUnderAdmission coverage to its execution callback', () => {
    const source = cp + "import { runUnderAdmission as admit } from './readiness/heavy-admission.mjs';\n"
      + "admit({ command: 'vitest run a', exec: () => spawnSync('vitest', ['run', 'a']) });\n"
      + "spawnSync('vitest', ['run', 'b']);";
    expect(findUngatedHeavySpawns(source)).toEqual([expect.objectContaining({ line: 4 })]);
  });
  it('does not accept a mere admission mention or unused import', () => {
    expect(findUngatedHeavySpawns(cp + "// runUnderAdmission\nimport { admittedArgv } from './readiness/heavy-admission.mjs'; spawnSync('vitest');")).toHaveLength(1);
  });
  it.each(['// heavy-admission-allow: parent already holds the admission slot\n', ''])('accepts justified on/above-line allowance %j', prefix => {
    const suffix = prefix ? '' : ' // heavy-admission-allow: parent already holds the admission slot';
    expect(findUngatedHeavySpawns(cp + prefix + "spawnSync('vitest');" + suffix)).toEqual([]);
  });
  it('ignores comments, ordinary strings, and unrelated exec methods', () => {
    expect(findUngatedHeavySpawns(cp + "// spawnSync('vitest')\nconst s = `spawnSync('playwright')`; /vitest/.exec(s);")).toEqual([]);
  });
  it('fails closed on incomplete syntax with a manual inspection fallback', () => {
    expect(findUngatedHeavySpawns(cp + 'spawnSync(')[0].reason).toContain('inspect manually');
    expect(findUngatedHeavySpawns(null)[0].reason).toContain('inspect manually');
  });
  it('scans the real daemon/script tree', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    function files(dir, recursive) {
      return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(e => {
        const path = `${dir}/${e.name}`;
        if (e.isDirectory()) return recursive && !['__tests__', 'node_modules'].includes(e.name) ? files(path, true) : [];
        return e.name.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/.test(e.name) ? [path] : [];
      });
    }
    const paths = [...files('scripts', false), ...files('scripts/conveyor', true), ...files('skills-src/conveyor', true)];
    const hits = paths.flatMap(path => findUngatedHeavySpawns(readFileSync(resolve(root, path), 'utf8'), relative(root, resolve(root, path))));
    expect(hits).toEqual([]);
  });
});
