import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { ciJobLogApiArgs, readCiJobLog } from '../gh-ci-log.mjs';
import { classifyGhRead } from '../gh-throttle.mjs';
import { classifyGhResource } from '../gh-argv.mjs';

const path = 'repos/o/r/actions/jobs/42/logs';
describe('raw CI job log transport', () => {
  it('keeps flagged job reads on the core read budget without hiding mutation flags', () => {
    const args = ciJobLogApiArgs(path);
    expect(classifyGhRead(args)).toBe(true);
    expect(classifyGhResource(args)).toBe('core');
    expect(classifyGhRead([...args, '--method', 'POST'])).toBe(false);
    expect(classifyGhRead([...args, '--input', 'body.json'])).toBe(false);
  });
  it('returns byte-identical non-escape text to the old raw read', () => {
    const raw = '2026-11-17T12:00:00Z FAIL café\r\n\ttrailing spaces  \n';
    const exec = vi.fn(() => raw);
    const opts = { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 };
    expect(readCiJobLog({ path, exec, opts })).toEqual({ ok: true, text: exec('gh', ['api', path], opts) });
    expect(exec).toHaveBeenCalledWith('gh', ['api', '--allow-escape-sequences', path], opts);
  });
  it.each([false, true])('reads escape-coded logs without stripping bytes (async=%s)', async async => {
    const raw = '\x1b[31mFAIL\x1b[0m\n';
    const read = (_command, args) => {
      if (!args.includes('--allow-escape-sequences')) throw new Error('the response contains terminal escape sequences');
      return raw;
    };
    const exec = async ? async (...args) => read(...args) : read;
    expect(await readCiJobLog({ repo: 'o/r', jobId: 42, exec })).toEqual({ ok: true, text: raw });
    expect(ciJobLogApiArgs(path)).toEqual(['api', '--allow-escape-sequences', path]);
  });
  it.each([false, true])('fails closed with a typed unreadable result (async=%s)', async async => {
    const exec = async ? async () => { throw new Error('HTTP 404'); } : () => { throw new Error('HTTP 404'); };
    expect(await readCiJobLog({ path, exec })).toEqual({ ok: false, reason: 'log-unreadable', detail: 'HTTP 404' });
  });
});

// Inspect command arrays (including endpoint variables) and shell snippets in every text file.
function bypasses(source, name) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const expanded = (node, seen = new Set()) => {
    if (ts.isIdentifier(node) && declarations.has(node.text) && !seen.has(node.text)) {
      return expanded(declarations.get(node.text), new Set([...seen, node.text]));
    }
    return node.getText(file);
  };
  const errors = [];
  const visit = node => {
    if (ts.isArrayLiteralExpression(node)) {
      const parts = node.elements.map(element => expanded(element));
      if (/^['"]api['"]$/.test(parts[0] ?? '') && parts.some(part => /\/logs\b/.test(part))) errors.push(node.getText(file));
      if (parts.some(part => /^['"]run['"]$/.test(part)) && parts.some(part => /^['"]view['"]$/.test(part))
        && parts.some(part => /^['"]--log(?:-failed)?['"]$/.test(part))) errors.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (/\bgh\s+run\s+view\b[^\n]*--log(?:-failed)?\b/.test(source)
    || /\bgh\s+api\b[^\n]*\/logs\b/.test(source)) errors.push('shell job-log command');
  return errors;
}

describe('CI log reader structural guard', () => {
  it('rejects direct API arrays, endpoint aliases, run-view arrays and shell readers', () => {
    for (const source of ["exec('gh', ['api', `repos/${repo}/actions/jobs/${id}/logs`])",
      "const endpoint = `repos/${repo}/actions/jobs/${id}/logs`; exec('gh', ['api', endpoint])",
      "gh(['run', 'view', '--job', id, '--log-failed'])", 'gh run view 42 --log', 'gh api repos/o/r/actions/jobs/42/logs']) {
      expect(bypasses(source, 'fixture.mjs').length).toBeGreaterThan(0);
    }
    expect(bypasses('exec("gh", ciJobLogApiArgs(path), opts)', 'fixture.mjs')).toEqual([]);
  });
  it('allows only the shared helper to build job-log commands across scripts and skills-src', () => {
    const root = resolve('.');
    const violations = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        const name = relative(root, path);
        if (/\.(?:test|spec)\./.test(name) || name === 'scripts/lib/gh-ci-log.mjs') continue;
        const source = readFileSync(path, 'utf8');
        if (!source.includes('\0')) for (const issue of bypasses(source, name)) violations.push(`${name}: ${issue}`);
      }
    };
    walk(resolve(root, 'scripts'));
    walk(resolve(root, 'skills-src'));
    expect(violations).toEqual([]);
  });
});
