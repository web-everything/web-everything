import { QUESTION_HASH } from '../../../operations/codex-audit.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import ts from 'typescript';
import { collectImportClosure } from '../../import-closure.mjs';

// Independently derive the static CI control graph; do not mirror the guard's path rules.
export function ciControlFiles() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
  const scripts = JSON.parse(read('package.json')).scripts;
  const jobs = yaml.safeLoad(read('.github/workflows/ci.yml')).jobs;
  const commands = Object.values(jobs).flatMap(job => (job.steps ?? [])
    .filter(step => step.run && step['working-directory'] !== 'frontierui').map(step => step.run));
  const scriptNames = new Set(Object.keys(scripts).filter(name => /^test(?::|$)/.test(name)));
  const visit = command => {
    // Workflow shell comments are not entrypoints.
    command = command.replace(/#.*$/gm, '');
    for (const [, name] of command.matchAll(/\bnpm run ([\w:-]+)/g)) {
      if (!scriptNames.has(name)) { scriptNames.add(name); visit(scripts[name] ?? ''); }
    }
    return command;
  };
  const workflowCommands = commands.map(visit);
  // Set iteration includes nested npm scripts discovered by visit.
  const npmCommands = [];
  for (const name of scriptNames) npmCommands.push(visit(scripts[name] ?? ''));
  const entries = new Set([...workflowCommands, ...npmCommands].flatMap(command =>
    [...command.matchAll(/(?:^|[\s"'(])((?:scripts|tests)\/[\w/.-]+\.(?:mjs|cjs|js|ts|sh))/gm)].map(m => m[1])));
  const configs = readdirSync(root).filter(path => /^(?:vitest|playwright|vite)[^/]*\.(?:ts|mts|mjs|js)$/.test(path));
  for (const config of configs) {
    entries.add(config);
    for (const [, setup] of read(config).matchAll(/(?:setupFiles|globalSetup):\s*\[([^\]]*)\]/g)) {
      for (const [, path] of setup.matchAll(/['"](\.\/[^'"*]+)['"]/g)) entries.add(path);
    }
  }
  entries.add('.eleventy.js');
  const unresolved = [];
  const closure = collectImportClosure({ root, entries: [...entries], readFile: path => {
    // TypeScript's scanner handles ESM, re-exports, literal import(), CommonJS require,
    // and comments. Resolve extensionless TS config imports before the shared graph walk.
    const imports = ts.preProcessFile(read(path), true, true).importedFiles;
    return imports.filter(({ fileName }) => fileName.startsWith('.')).map(({ fileName }) => {
      const base = resolve(dirname(path), fileName);
      const target = ['', '.ts', '.mts', '.mjs', '.js', '.cjs', '/index.ts', '/index.js', '/index.mjs']
        .map(ext => base + ext).find(isFile);
      if (relative(root, base).startsWith('..')) return ''; // External sibling repos have their own CI.
      if (!target) { unresolved.push(`${relative(root, path)}: ${fileName}`); return ''; }
      return `import ${JSON.stringify(`./${relative(dirname(path), target)}`)};`;
    }).join('\n');
  } });
  const missing = [...entries].filter(path => !isFile(resolve(root, path)));
  if (!closure?.complete || missing.length || unresolved.length) throw new Error(`Incomplete CI control graph: ${JSON.stringify({ missing, unresolved })}`);
  return new Set([...closure.files, '.github/workflows/ci.yml', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc',
    ...readdirSync(root).filter(path => /^tsconfig(?:\.[^/]+)?\.json$/.test(path))]);
}

export const HP_SHA = 'a'.repeat(40);
export function hotpatchFixture() {
  const check = (name, id) => ({ name, id, head_sha: HP_SHA, app: { id: 15368 }, check_suite: { id: 7 }, status: 'completed', conclusion: 'success' });
  const data = {
    checks: { total_count: 5, check_runs: [check('test', 10), check('test-shard (1)', 8), check('test-shard (2)', 9), check('smoke', 11), check('daemon-soak', 12)] },
    workflows: { total_count: 1, workflow_runs: [{ check_suite_id: 7, head_sha: HP_SHA, path: '.github/workflows/ci.yml', event: 'workflow_dispatch' }] },
    audits: [{ head: HP_SHA, base: 'e'.repeat(40), at: '2026-11-20T12:00:00Z', questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', findings: [] }],
    auditOptions: { now: Date.parse('2026-11-22T12:00:00Z'), priorQuestionHashes: [] },
    fullSuite: true, ruledWeakened: [], paths: [], ciPlan: [{}, {}], settings: {},
  };
  const readers = Object.fromEntries(Object.keys(data).map(k => [k, () => data[k]]));
  readers.covers = () => true;
  return { data, readers };
}
