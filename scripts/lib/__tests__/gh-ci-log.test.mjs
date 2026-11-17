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
  it.each([false, true])('returns the whole non-escape log byte-identically (async=%s)', async asynchronous => {
    const raw = '2026-11-17T12:00:00Z passing step\r\n2026-11-17T12:00:10Z FAIL café\r\n\ttrailing spaces  \n';
    const exec = vi.fn(asynchronous ? async () => raw : () => raw);
    const opts = { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 };
    expect(await readCiJobLog({ path, exec, opts })).toEqual({ ok: true, text: raw, filtered: false });
    expect(exec).toHaveBeenCalledWith('gh', ['api', '--allow-escape-sequences', path], opts);
  });
  it.each([false, true])('reads escape-coded logs without stripping bytes (async=%s)', async async => {
    const raw = '\x1b[31mFAIL\x1b[0m\n';
    const read = (_command, args) => {
      if (!args.includes('--allow-escape-sequences')) throw new Error('the response contains terminal escape sequences');
      return raw;
    };
    const exec = async ? async (...args) => read(...args) : read;
    expect(await readCiJobLog({ repo: 'o/r', jobId: 42, exec })).toEqual({ ok: true, text: raw, filtered: false });
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
  let shellSource = source;
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    // Error-message fixtures describe failed reads; they do not execute shell commands.
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'Error') {
      for (const arg of node.arguments ?? []) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          shellSource = shellSource.slice(0, arg.getStart(file))
            + ' '.repeat(arg.getWidth(file)) + shellSource.slice(arg.end);
        }
      }
    }
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
  if (/\bgh\s+run\s+view\b[^\n]*--log(?:-failed)?\b/.test(shellSource)
    || /\bgh\s+api\b[^\n]*\/logs\b/.test(shellSource)) errors.push('shell job-log command');
  return errors;
}

// Follow-up: finding-producing log readers on gh 2.104.
// These readers retain origin/main's transport until their log matching is addressed.
// Pin each existing bypass count so the allowlist grants no additional direct reads.
// reconcile-pass also contains the timeout classifier transport pinned separately below.
const deferredFindingReaders = new Map([
  ['scripts/conveyor/ci-auth-diagnosis.mjs', 1],
  ['scripts/conveyor/credential-inventory.mjs', 1],
  ['scripts/conveyor/ci-red-recovery-watch.mjs', 1],
  ['scripts/conveyor/main-ci-red-probe.mjs', 1],
  ['scripts/conveyor/reconcile-pass.mjs', 1],
  ['scripts/conveyor/stale-base-refresh.mjs', 1],
  ['scripts/lib/drain-mq-failure-recovery-io.mjs', 1],
  ['scripts/lib/drain-queue-safety.mjs', 2],
  ['scripts/lib/finished-ci-cache.mjs', 0],
  ['scripts/lib/merge-gate-hold-class.mjs', 1],
  ['scripts/lib/red-main-quarantine-io.mjs', 2], // Existing API array and its documented shell command.
  ['scripts/lib/renamed-pr-refresh.mjs', 1],
  ['scripts/operations/operator-queue.mjs', 1],
  ['scripts/review-hold-probe.mjs', 1],
]);

// Follow-up: timeout classifier on unfiltered logs: treat as unknown and retry, never eligible.
// Generic path arguments are invisible to the endpoint scanner; pin these deferred transports explicitly.
const deferredTimeoutReaders = new Map([
  ['scripts/conveyor/reconcile-pass.mjs', 'plainApi'],
  ['scripts/lib/fix-facts.mjs', 'plain'],
]);

describe('CI log reader structural guard', () => {
  it('keeps deferred timeout classifier log reads on plain API transport without the allow flag', () => {
    for (const [name, reader] of deferredTimeoutReaders) {
      const source = readFileSync(resolve(name), 'utf8');
      expect(source, name).toContain(`const ${reader} = (path, raw`);
      expect(source, name).toContain("const value = exec('gh', ['api', path],");
      expect(source, name).not.toMatch(/ciJobLogApiArgs|readCiJobLog|--allow-escape-sequences/);
    }
  });
  it('rejects direct API arrays, endpoint aliases, run-view arrays and shell readers', () => {
    for (const source of ["exec('gh', ['api', `repos/${repo}/actions/jobs/${id}/logs`])",
      "const endpoint = `repos/${repo}/actions/jobs/${id}/logs`; exec('gh', ['api', endpoint])",
      "gh(['run', 'view', '--job', id, '--log-failed'])", 'gh run view 42 --log', 'gh api repos/o/r/actions/jobs/42/logs']) {
      expect(bypasses(source, 'fixture.mjs').length).toBeGreaterThan(0);
    }
    expect(bypasses('exec("gh", ciJobLogApiArgs(path), opts)', 'fixture.mjs')).toEqual([]);
    expect(bypasses('throw new Error("Command failed: gh api .../logs")', 'fixture.mjs')).toEqual([]);
    expect(bypasses('throw new Error(exec("gh api repos/o/r/actions/jobs/42/logs"))', 'fixture.mjs'))
      .toEqual(['shell job-log command']);
  });
  it('requires the helper outside the explicit deferred readers in scripts and skills-src', () => {
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
        if (source.includes('\0')) continue;
        const issues = bypasses(source, name);
        if (name === 'scripts/conveyor/reconcile-pass.mjs') {
          // Pin the signature reader; the generic-path timeout reader is pinned separately above.
          expect(issues).toEqual(["['api', `repos/${repo}/actions/jobs/${jobId}/logs`]"]);
        } else if (deferredTimeoutReaders.has(name)) {
          expect(issues, name).toEqual([]);
        } else if (deferredFindingReaders.has(name)) {
          expect({ name, bypasses: issues.length }).toEqual({ name, bypasses: deferredFindingReaders.get(name) });
        } else {
          for (const issue of issues) violations.push(`${name}: ${issue}`);
        }
      }
    };
    walk(resolve(root, 'scripts'));
    walk(resolve(root, 'skills-src'));
    expect(violations).toEqual([]);
  });
});
