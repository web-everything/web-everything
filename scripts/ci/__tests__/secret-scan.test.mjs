// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { secretText } from '../../readiness/forge-exec-manifest.mjs';

const cli = new URL('../secret-scan.mjs', import.meta.url);
const token = 'ghp' + '_' + 'a'.repeat(36);
const aws = 'AKIA' + 'A'.repeat(16);
const diff = (text, path = 'fixture.txt') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +7 @@\n+${text}\n`;
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function scan(input, entries = []) {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  dirs.push(dir);
  const allowlist = join(dir, 'allowlist.json');
  writeFileSync(allowlist, JSON.stringify(entries));
  const result = spawnSync(process.execPath, [cli.pathname, '--stdin', '--allowlist', allowlist], {
    input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return { ...result, output: result.stdout + result.stderr };
}

describe('secret-scan', () => {
  it('exports the identical shared rule array', async () => {
    expect((await import('../secret-scan.mjs')).secretText).toBe(secretText);
  });
  it.each([[token, 'github-token'], [aws, 'aws-access-key']])('reports only location and rule for fake credential %#', (value, rule) => {
    const result = scan(diff(value));
    expect(result.status).toBe(1);
    expect(result.output).toBe(`fixture.txt:7 ${rule}\n`);
    expect(result.output).not.toContain(value);
  });
  it('passes clean text and an empty diff', () => {
    expect(scan(diff('ordinary text')).status).toBe(0);
    expect(scan('').status).toBe(0);
  });
  it('ignores removed lines and context, keeping new-file line numbers', () => {
    const result = scan(`--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n-${token}\n ${token}\n+${aws}\n`);
    expect(result.status).toBe(1);
    expect(result.output).toBe('x:4 aws-access-key\n');
    expect(scan(`--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-${token}\n`).status).toBe(0);
  });
  it('scans additions beginning with header-like text', () => {
    expect(scan(diff('++ ' + token)).output).toBe('fixture.txt:7 github-token\n');
  });
  it('honors only the exact allowlisted path and rule', () => {
    const entries = [{ path: 'fixture.txt', rule: 'github-token', reason: 'Synthetic token fixture' }];
    expect(scan(diff(token), entries).status).toBe(0);
    expect(scan(diff(aws), entries).status).toBe(1);
    expect(scan(diff(token, 'other.txt'), entries).status).toBe(1);
  });
  it.each([undefined, '', '   '])('fails closed on missing or blank allowlist reason %#', reason => {
    expect(scan('', [{ path: 'fixture.txt', rule: 'github-token', reason }]).status).toBe(1);
  });
  it('fails closed on unknown rules, wildcard paths and malformed diffs', () => {
    expect(scan('', [{ path: 'x', rule: 'unknown', reason: 'test' }]).status).toBe(1);
    expect(scan('', [{ path: '*', rule: 'github-token', reason: 'test' }]).status).toBe(1);
    expect(scan('@@ -0,0 +1 @@\n+text\n').status).toBe(1);
    expect(scan('--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+text\n').status).toBe(1);
  });
  it('fails closed on unreadable config, unknown args and unavailable git refs without echoing inputs', () => {
    for (const args of [['--allowlist', 'missing-config'], ['--unknown', token], ['--base', 'nonexistent-secret-scan-ref']]) {
      const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });
  it('refuses oversized input with an operator fallback', () => {
    const result = scan(' '.repeat(32 * 1024 * 1024 + 1));
    expect(result.status).toBe(1);
    expect(result.output).toContain('review the full diff manually');
  });
  it('decodes Git quoted paths and scans multiple hunks', () => {
    const result = scan(`--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -0,0 +1 @@\n+clean\n@@ -5,0 +6 @@\n+${token}\n`);
    expect(result.output).toBe('sp ace.txt:6 github-token\n');
  });
  it('decodes octal UTF-8 paths for exact allowlist matching and escapes terminal controls', () => {
    const input = `--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -0,0 +1 @@\n+${token}\n`;
    expect(scan(input).output).toBe('café.txt:1 github-token\n');
    expect(scan(input, [{ path: 'café.txt', rule: 'github-token', reason: 'Synthetic fixture' }]).status).toBe(0);
    expect(scan(`--- "a/x\\033.txt"\n+++ "b/x\\033.txt"\n@@ -0,0 +1 @@\n+${token}\n`).output).toBe('"x\\u001b.txt":1 github-token\n');
  });
  it('reports every matching shared rule on a line', () => {
    expect(scan(diff(token + ' ' + aws)).output).toBe('fixture.txt:7 github-token\nfixture.txt:7 aws-access-key\n');
  });
  it('loads the shipped allowlist', () => {
    const clean = spawnSync(process.execPath, [cli.pathname, '--stdin'], { input: diff('clean'), encoding: 'utf8', timeout: 10_000 });
    expect(clean.status).toBe(0);
  });
});

it('runs an isolated read-only PR workflow using only existing action pins', () => {
  const source = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const workflow = yaml.safeLoad(source);
  const job = workflow.jobs['secret-scan'];
  expect(job).toBeDefined();
  expect(job.name).toBe('secret-scan');
  expect(job.permissions).toEqual({ contents: 'read' });
  expect(job.if).toBe("${{ github.event_name == 'pull_request' }}");
  expect(JSON.stringify(job)).not.toMatch(/secrets\s*\./);
  expect(job.steps.filter(step => step.uses).map(step => step.uses)).toEqual(['actions/checkout@v4', 'actions/setup-node@v4']);
  expect(job.steps[0].with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false, ref: '${{ github.sha }}' });
  expect(job.steps[1].with['node-version']).toBe(22);
  const run = job.steps.find(step => step.run);
  expect(run.env).toEqual({ BASE_SHA: '${{ github.event.pull_request.base.sha }}', HEAD_SHA: '${{ github.sha }}' });
  expect(run.run).toBe('node scripts/ci/secret-scan.mjs --base "$BASE_SHA" --head "$HEAD_SHA"');
  expect(workflow.jobs.test.needs).not.toContain('secret-scan');
});
