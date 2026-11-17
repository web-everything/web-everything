import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

const HEAD = 'a'.repeat(40);
const PREFIX = 'review-gate-verdict/v1 ';
const bindings = { repo: 'o/n', 'pr-number': '7', 'head-sha': HEAD, 'run-id': '31', 'run-attempt': '1',
  'labels-json': '["review:pending","bug","review:pending"]' };
function run(flags = bindings) {
  const child = spawnSync(process.execPath, ['scripts/check-review-gate.mjs', ...Object.entries(flags).map(([key, value]) => `--${key}=${value}`)],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  expect(child.error).toBeUndefined();
  return child;
}
function marker(child) {
  const lines = child.stdout.split(/\r?\n/).filter(line => line.startsWith(PREFIX));
  expect(lines).toHaveLength(1);
  const value = JSON.parse(lines[0].slice(PREFIX.length));
  expect(lines[0]).toBe(PREFIX + JSON.stringify(value));
  expect(Object.keys(value).sort()).toEqual(['v', 'repo', 'pr', 'head', 'runId', 'runAttempt', 'event', 'labels', 'verdict', 'holdLabels'].sort());
  return value;
}
// Traverse literal relative static imports and re-exports, including transitive edges.
function importClosure(entry) {
  const seen = new Set();
  function visit(file) {
    file = resolve(file); if (seen.has(file)) return; seen.add(file);
    const source = readFileSync(file, 'utf8');
    const imports = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]/g; // static edges only: the --pr manual mode loads proc-read lazily and CI never takes it
    for (const match of source.matchAll(imports)) visit(resolve(dirname(file), match[1]));
  }
  visit(entry); return [...seen].map(file => relative(process.cwd(), file).replaceAll('\\', '/'));
}

describe('review-gate marker producer', () => {
  it('exact-marker-key-set-and-hold-exit', () => {
    const child = run(); expect(child.status).toBe(1);
    expect(marker(child)).toEqual({ v: 1, repo: 'o/n', pr: 7, head: HEAD, runId: 31, runAttempt: 1,
      event: 'pull_request', labels: ['bug', 'review:pending'], verdict: 'hold', holdLabels: ['review:pending'] });
  });
  it('clear-exit-zero', () => {
    const child = run({ ...bindings, 'labels-json': '["z","bug","bug"]' }); expect(child.status).toBe(0);
    expect(marker(child)).toMatchObject({ labels: ['bug', 'z'], verdict: 'clear', holdLabels: [] });
  });
  it('no-marker-and-exit-3-on-every-missing-binding', () => {
    for (const key of Object.keys(bindings)) {
      const flags = { ...bindings }; delete flags[key]; const child = run(flags);
      expect(child.status, key).toBe(3); expect(child.stdout).not.toContain(PREFIX);
    }
  });
  it('no-marker-and-exit-3-on-every-malformed-binding', () => {
    const invalid = { repo: ['', 'owner', 'a/b/c', 'o/n\n'], 'pr-number': ['', '0', '-1', '1.5', 'wat', '7\n'],
      'head-sha': ['', 'abc', 'g'.repeat(40), HEAD + '\n'], 'run-id': ['', '0', '-1', '1.5', 'wat'],
      'run-attempt': ['', '0', '-1', '1.5', 'wat'], 'labels-json': ['', '{', 'null', '{}', '"bug"', '[null]', '[1]', '[{}]', '[{"name":7}]', '[""]'] };
    for (const [key, values] of Object.entries(invalid)) for (const value of values) {
      const child = run({ ...bindings, [key]: value });
      expect(child.status, `${key}=${JSON.stringify(value)}`).toBe(3); expect(child.stdout).not.toContain(PREFIX);
    }
  });
  it('accepts-github-label-name-objects', () => {
    const child = run({ ...bindings, 'labels-json': '[{"name":"review:human"},{"name":"bug"}]' });
    expect(child.status).toBe(1); expect(marker(child)).toMatchObject({ labels: ['bug', 'review:human'], holdLabels: ['review:human'] });
  });
});

describe('review-gate workflow contract', () => {
  const workflow = yaml.safeLoad(readFileSync('.github/workflows/review-gate.yml', 'utf8'));
  const steps = workflow.jobs['review-gate'].steps;
  it('one-verdict-producer-with-all-github-bindings', () => {
    const producers = steps.filter(step => step.name === 'review-gate verdict');
    expect(producers).toHaveLength(1);
    const step = producers[0];
    const expected = { repo: 'github.repository', 'pr-number': 'github.event.pull_request.number',
      'head-sha': 'github.event.pull_request.head.sha', 'run-id': 'github.run_id', 'run-attempt': 'github.run_attempt',
      'labels-json': 'github.event.pull_request.labels' };
    // Bindings may be passed directly or through the step's environment, but every flag must use its own source.
    for (const [flag, source] of Object.entries(expected)) {
      expect(step.run).toContain(`--${flag}`);
      const envNames = Object.entries(step.env ?? {}).filter(([, value]) => String(value).includes(source)).map(([key]) => key);
      const commandLine = step.run.replace(/\\\n\s*/g, ' ');
      const value = commandLine.match(new RegExp(`--${flag}(?:=|\\s+)(.*?)(?=\\s+--|$)`))?.[1] ?? '';
      expect(value.includes(source) || envNames.some(key => value.includes(`$${key}`) || value.includes('${' + key + '}')), flag).toBe(true);
    }
  });
  it('keeps-per-pr-concurrency-that-cancels-superseded-runs', () => {
    // Without it every label change queues its own run (the earlier 75-queued-runs incident).
    expect(workflow.concurrency?.group).toMatch(/github\.event\.pull_request\.number/);
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
  });
  it('sparse-checkout-covers-real-import-closure', () => {
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('main');
    const paths = String(checkout?.with?.['sparse-checkout'] ?? '').split(/\s+/).filter(Boolean).map(p => p.replace(/\/$/, ''));
    expect(paths.length).toBeGreaterThan(0);
    for (const file of importClosure('scripts/check-review-gate.mjs')) {
      expect(paths.some(path => file === path || file.startsWith(path + '/')), file).toBe(true);
    }
  });
  it('supports-the-legacy-trusted-main-script-before-the-new-script-lands', () => {
    const compatibility = steps.find(step => step.name === 'Prepare legacy gate dependencies');
    expect(compatibility).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'review-gate-transition-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'bin'));
      for (const command of ['git', 'npm']) {
        const file = join(root, 'bin', command);
        writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${command}' \"$@\" >> \"$TRACE\"\nexit \"\${${command.toUpperCase()}_STATUS:-0}\"\n`);
        chmodSync(file, 0o755);
      }
      const entry = join(root, 'scripts/check-review-gate.mjs');
      const trace = join(root, 'trace');
      function prepare(source, status = {}) {
        writeFileSync(entry, source);
        writeFileSync(trace, '');
        const child = spawnSync('bash', ['-e', '-c', compatibility.run], { cwd: root,
          env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TRACE: trace, ...status }, encoding: 'utf8' });
        expect(child.error).toBeUndefined();
        return { status: child.status, calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
      }
      // Main still has these static imports until this PR merges. Test each independently.
      for (const dependency of ['proc-read', 'review-escalation']) {
        const legacy = `import { value } from './lib/${dependency}.mjs';\n`;
        expect(prepare(legacy)).toEqual({ status: 0,
          calls: ['git', 'sparse-checkout', 'disable', 'npm', 'ci', '--ignore-scripts'] });
        expect(prepare(legacy, { GIT_STATUS: '9' })).toEqual({ status: 9,
          calls: ['git', 'sparse-checkout', 'disable'] });
        expect(prepare(legacy, { NPM_STATUS: '8' }).status).toBe(8);
      }
      expect(prepare(readFileSync('scripts/check-review-gate.mjs', 'utf8'))).toEqual({ status: 0, calls: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('no-jq-fast-path-no-npm-ci-outside-legacy-setup-and-setup-node-without-cache', () => {
    const compatibility = steps.find(step => step.name === 'Prepare legacy gate dependencies');
    const executable = steps.filter(step => step !== compatibility).map(step => step.run ?? '').join('\n');
    expect(steps.map(step => step.run ?? '').join('\n')).not.toMatch(/\bjq\b/);
    expect(executable).not.toMatch(/\bnpm\s+ci\b/);
    expect(steps.some(step => step.id === 'fast' || /steps\.fast\./.test(String(step.if)))).toBe(false);
    const setup = steps.filter(step => step.uses?.startsWith('actions/setup-node@'));
    expect(setup).toHaveLength(1); expect(setup[0].with).not.toHaveProperty('cache');
    expect(steps.findIndex(step => step.uses?.startsWith('actions/checkout@'))).toBeLessThan(steps.indexOf(setup[0]));
    expect(steps.indexOf(setup[0])).toBeLessThan(steps.findIndex(step => step.name === 'review-gate verdict'));
    expect(steps.indexOf(setup[0])).toBeLessThan(steps.indexOf(compatibility));
    expect(steps.indexOf(compatibility)).toBeLessThan(steps.findIndex(step => step.name === 'review-gate verdict'));
  });
});
