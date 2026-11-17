import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { ciJobLogApiArgs, failedStepsLog, readCiJobLog } from '../gh-ci-log.mjs';
import { classifyGhRead } from '../gh-throttle.mjs';
import { classifyGhResource } from '../gh-argv.mjs';

const path = 'repos/o/r/actions/jobs/42/logs';
const at = seconds => `2026-11-17T12:00:${seconds}Z`;
const step = (conclusion, start, end) => ({ conclusion, started_at: at(start), completed_at: at(end) });
describe('failed-step log selection', () => {
  const job = { steps: [step('success', '00', '09'), step('failure', '10', '19'),
    step('success', '20', '29'), step('failure', '30', '39')] };
  it('keeps all failed intervals with inclusive bounds and original ANSI, CRLF and whitespace bytes', () => {
    const kept = `${at('10')} \x1b[31mFAIL café\x1b[0m  \r\ncontinuation\r\n${at('19')} end\r\n`;
    const second = `${at('30')} second failure\n${at('39')} end`;
    const log = `unowned preamble\n${at('09')} passing\npassing continuation\n${kept}${at('20')} cleanup\ncleanup continuation\n${second}`;
    expect(failedStepsLog(job, log)).toEqual({ text: kept + second, filtered: true });
  });
  it('inherits the previous timestamp ownership for untimestamped lines, including embedded timestamps', () => {
    const kept = `${at('10')} failure\nBad credentials\n  ${at('25')} still a continuation\n`;
    expect(failedStepsLog(job, `${at('00')} passing\nBad credentials\n${kept}${at('40')} outside\nBad credentials`)).toEqual({ text: kept, filtered: true });
  });
  it('accepts fractional ISO timestamps and excludes skipped, cancelled and timed-out steps', () => {
    const log = `${at('00')} success\n2026-11-17T12:00:10.1234567Z failure\n${at('20')} skipped\n${at('30')} cancelled\n${at('40')} timeout`;
    expect(failedStepsLog({ steps: [step('success', '00', '09'), step('failure', '10', '19'),
      step('skipped', '20', '29'), step('cancelled', '30', '39'), step('timed_out', '40', '49')] }, log))
      .toEqual({ text: '2026-11-17T12:00:10.1234567Z failure\n', filtered: true });
  });
  it.each([undefined, {}, { steps: [] }, { steps: null },
    { steps: [{ conclusion: 'failure' }] }, { steps: [step('failure', '19', '10')] },
    { steps: [step('failure', 'xx', '19')] }, { steps: [step('success', '00', '09')] },
    { steps: [step('success', '00', '09'), { conclusion: 'failure', started_at: at('10') }] },
  ])('preserves whole-log parity when usable failed-step metadata is unavailable: %j', metadata => {
    const raw = `${at('00')} Bad credentials\r\n\x1b[31mcontinuation\x1b[0m  \n`;
    expect(failedStepsLog(metadata, raw)).toEqual({ text: raw, filtered: false });
    expect(readCiJobLog({ path, job: metadata, failedOnly: true, exec: () => raw }))
      .toEqual({ ok: true, text: raw, filtered: false });
  });
  it('excludes all lines when usable intervals establish that none belong to a failed step', () => {
    expect(failedStepsLog(job, `${at('00')} passing\nBad credentials`)).toEqual({ text: '', filtered: true });
  });
  it.each([
    { conclusion: 'failure', started_at: at('30') },
    { conclusion: 'failure', completed_at: at('39') },
    step('failure', 'xx', '39'),
    step('failure', '39', '30'),
  ])('retains both errors when one failed step has usable times and another has an unusable interval: %j', incomplete => {
    const metadata = { steps: [step('failure', '10', '19'), incomplete] };
    const raw = `${at('01')} setup\r\n${at('11')} ##[error]Disk full\r\n`
      + `${at('31')} ##[error]Bad credentials\r\nauth continuation  \n`;
    expect(failedStepsLog(metadata, raw)).toEqual({ text: raw, filtered: false });
    expect(readCiJobLog({ path, job: metadata, failedOnly: true, exec: () => raw }))
      .toEqual({ ok: true, text: raw, filtered: false });
  });
  it('keeps both errors through an async reader when only some failed-step times are usable', async () => {
    const metadata = { steps: [step('failure', '10', '19'), { conclusion: 'failure', started_at: at('30') }] };
    const raw = `${at('11')} ##[error]Disk full\n${at('31')} ##[error]Bad credentials`;
    expect(await readCiJobLog({ path, job: metadata, failedOnly: true, exec: async () => raw }))
      .toEqual({ ok: true, text: raw, filtered: false });
  });
  it('marks a selected log as filtered even when every line belongs to a failed step', () => {
    const raw = `${at('10')} failure\nBad credentials`;
    expect(failedStepsLog(job, raw)).toEqual({ text: raw, filtered: true });
    expect(readCiJobLog({ path, job, failedOnly: true, exec: () => raw }))
      .toEqual({ ok: true, text: raw, filtered: true });
  });
  it.each([false, true])('selects failed steps only when the reader option is enabled (async=%s)', async asynchronous => {
    const raw = `${at('00')} Bad credentials\n${at('10')} actual failure\n`;
    const exec = asynchronous ? async () => raw : () => raw;
    expect(await readCiJobLog({ path, job, failedOnly: true, exec })).toEqual({ ok: true, text: `${at('10')} actual failure\n`, filtered: true });
    expect(await readCiJobLog({ path, job, exec })).toEqual({ ok: true, text: raw, filtered: false });
    expect(await readCiJobLog({ path, failedOnly: true, exec })).toEqual({ ok: true, text: raw, filtered: false });
  });
});
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
    expect(readCiJobLog({ path, exec, opts })).toEqual({ ok: true, text: exec('gh', ['api', path], opts), filtered: false });
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
