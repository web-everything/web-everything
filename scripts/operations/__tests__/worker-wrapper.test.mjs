/**
 * @file worker-wrapper.test.mjs — item 117 slice S3a: the unified detached worker wrapper (D7 FINAL).
 * These run the wrapper against REAL child processes (node -e), so pid, stdin and timeout are proven, not mocked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { tryReadCompletion, writeCompletion } from '../completion-store.mjs';
import { listDraftKeys } from '../worker-result-router.mjs';
import {
  STRUCTURED_OUTPUT_SUFFIX, extractAgyResult, extractClaudeResult, launchDetached, runWorker, withStructuredOutput, workerWrapperEnabled,
} from '../worker-wrapper.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wr-wrap-')); dirs.push(d); return d; };

const DONE = { v: 1, outcome: 'done', summary: 'built', blocker: null, findingsAddressed: [], filesTouched: ['a.mjs'], learning: null };
const BLOCKED = (kind, extra = {}) => ({
  ...DONE, outcome: 'blocked', filesTouched: [], summary: 'stuck',
  blocker: { kind, component: 'thing', evidence: { text: 'it broke', refs: [] }, proposedFix: null, ruling: null, deniedCommand: null, retryable: false, ...extra },
});
const claudeStdout = (structured, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'prose', ...(structured === undefined ? {} : { structured_output: structured }), ...extra });
/** A child that prints `text` to stdout. */
const printing = (text) => ['-e', `process.stdout.write(${JSON.stringify(text)})`];

function spec(over = {}, dir = tmp()) {
  return {
    role: 'build', launcher: 'claude-p', session: 'build-4001', command: process.execPath, argv: printing(claudeStdout(DONE)), model: 'sonnet', item: 4001,
    timeoutMs: 20_000, completionsDir: dir, draftsDir: join(dir, 'drafts'), postmortemMode: 'draft', ...over,
  };
}
const read = (s) => tryReadCompletion(s.session, s.completionsDir);

describe('runWorker: the job record and the result channels', () => {
  it('writes a started record with pid, timeout and deadline BEFORE the child exits, then a done envelope', async () => {
    const writes = [];
    const s = spec({ argv: ['-e', `setTimeout(()=>process.stdout.write(${JSON.stringify(claudeStdout(DONE))}), 150)`] });
    const out = await runWorker(s, { writeRecord: (rec, dir) => { writes.push(structuredClone(rec)); return writeCompletion(rec, dir); } });
    expect(writes[0]).toMatchObject({ v: 2, status: 'started', role: 'build', launcher: 'claude-p', timeoutMs: 20_000 });
    expect(Number.isInteger(writes[0].pid)).toBe(true);
    expect(Date.parse(writes[0].deadlineAt) - Date.parse(writes[0].startedAt)).toBe(20_000);
    expect(out.envelope).toMatchObject({ status: 'done', outcome: 'done', source: 'worker-result', parse: { ok: true }, action: { type: 'done' }, result: { filesTouched: ['a.mjs'] } });
  });

  it('claude -p: the result is the stdout structured_output; the record on disk is v2 done', async () => {
    const s = spec();
    await runWorker(s);
    expect(read(s)).toMatchObject({ v: 2, status: 'done', pid: expect.any(Number), result: { outcome: 'done' }, action: { type: 'done' } });
  });

  it('a blocked tooling-defect makes ONE deduped draft under postmortem draft, and none under off', async () => {
    const dir = tmp();
    const s = spec({ argv: printing(claudeStdout(BLOCKED('tooling-defect'))) }, dir);
    await runWorker(s); await runWorker({ ...s, session: 'build-4002', item: 4002 });
    expect(listDraftKeys(s.draftsDir)).toHaveLength(1);
    const off = spec({ argv: printing(claudeStdout(BLOCKED('tooling-defect'))), postmortemMode: 'off', draftsDir: join(dir, 'd2') }, dir);
    expect((await runWorker(off)).action).toMatchObject({ type: 'product-fix-draft', mode: 'off' });
    expect(listDraftKeys(off.draftsDir)).toEqual([]);
  });

  it('FAIL CLOSED: no structured_output is contract-violation, never success', async () => {
    const s = spec({ argv: printing(claudeStdout(undefined)) });
    const { envelope } = await runWorker(s);
    expect(envelope).toMatchObject({ outcome: 'blocked', parse: { ok: false, reason: 'no-structured-output' }, result: { outcome: 'unparseable', blocker: { kind: 'contract-violation' } }, action: { type: 'product-fix-draft' } });
    expect(listDraftKeys(s.draftsDir)).toHaveLength(1);
  });

  it('FAIL CLOSED: retries exhausted, non-JSON stdout and a schema violation are each their own reason', async () => {
    const cases = [
      [claudeStdout(undefined, { subtype: 'error_max_structured_output_retries', is_error: true }), 'structured-output-retries-exhausted'],
      ['this is prose, not json', 'no-structured-output'],
      [claudeStdout({ v: 1, outcome: 'done' }), 'schema-violation'],
    ];
    for (const [stdout, reason] of cases) {
      const { envelope } = await runWorker(spec({ argv: printing(stdout) }));
      expect(envelope.parse, reason).toEqual({ ok: false, reason });
      expect(envelope.result.blocker.kind).toBe('contract-violation');
    }
  });

  it('a build that says done with no files fails the reader check', async () => {
    const { envelope } = await runWorker(spec({ argv: printing(claudeStdout({ ...DONE, filesTouched: [] })) }));
    expect(envelope.parse.ok).toBe(false);
  });

  it('a timeout kills the child and is a contract violation (D6), with a signature that dedupes', async () => {
    const s = spec({ argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 });
    const { envelope } = await runWorker(s);
    expect(envelope.parse).toEqual({ ok: false, reason: 'timeout' });
    expect(envelope.result.signature).toBe('build|claude-p|timeout');
    expect(envelope.action.type).toBe('product-fix-draft');
  });

  it('rejects successful output when the child subsequently fails (valid output x timeout / nonzero exit / signal)', async () => {
    const out = JSON.stringify(claudeStdout(DONE));
    const hang = 'setInterval(()=>{},1000)';
    const cases = {
      timeout: { argv: ['-e', `process.stdout.write(${out});${hang}`], timeoutMs: 400 },
      'nonzero exit': { argv: ['-e', `process.stdout.write(${out});process.exitCode=3`] },
      'signal termination': { argv: ['-e', `process.stdout.write(${out});process.kill(process.pid,'SIGTERM');${hang}`] },
    };
    for (const [name, over] of Object.entries(cases)) {
      const s = spec({ ...over, session: `build-${name.replace(/\W/g, '')}` });
      const { envelope, result } = await runWorker(s);
      expect(envelope.parse.ok, name).toBe(false);
      expect(envelope.outcome, name).not.toBe('done');
      expect(envelope.action.type, name).not.toBe('done');
      expect(result.outcome, name).toBe('unparseable');
      expect(result.blocker.kind, name).toBe('contract-violation');
    }
  });

  it('codex: an existing -o result file does not rescue a run that then failed', async () => {
    const dir = tmp();
    const resultFile = join(dir, 'last.json');
    writeFileSync(resultFile, JSON.stringify(DONE));
    const { envelope } = await runWorker(spec({ launcher: 'codex-exec', resultFile, argv: ['-e', 'process.exitCode=2'], session: 'build-4003' }, dir));
    expect(envelope).toMatchObject({ parse: { ok: false }, result: { outcome: 'unparseable' } });
    expect(envelope.outcome).not.toBe('done');
  });

  it('an operator stop is aborted and makes no draft (D6)', async () => {
    const s = spec({ argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 });
    const { envelope } = await runWorker(s, { isOperatorStop: () => true });
    expect(envelope).toMatchObject({ outcome: 'aborted', action: { type: 'aborted' } });
    expect(listDraftKeys(s.draftsDir)).toEqual([]);
  });

  it('STDIN IS CLOSED: a child that waits for stdin EOF finishes (a piped, never-closed stdin would hang it)', async () => {
    const script = `process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(claudeStdout(DONE))}));process.stdin.resume();`;
    const started = Date.now();
    const { envelope } = await runWorker(spec({ argv: ['-e', script], launcher: 'codex-exec', resultFile: join(tmp(), 'none') }));
    // codex-exec reads the -o file (absent here) so the point is only that the child EXITED before the 20s budget
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(envelope.parse.reason).not.toBe('timeout');
  });

  it('codex: the result is the -o file; a missing file is unparseable', async () => {
    const dir = tmp();
    const resultFile = join(dir, 'last.json');
    const script = `require('fs').writeFileSync(${JSON.stringify(resultFile)}, ${JSON.stringify(JSON.stringify(BLOCKED('permission-wall', { deniedCommand: 'git push' })))})`;
    const { envelope } = await runWorker(spec({ launcher: 'codex-exec', argv: ['-e', script], resultFile, role: 'fix' }, dir));
    expect(envelope).toMatchObject({ launcher: 'codex-exec', outcome: 'blocked-on-permission', action: { type: 'product-fix-draft' }, result: { blocker: { kind: 'permission-wall' } } });
    const missing = await runWorker(spec({ launcher: 'codex-exec', argv: printing('x'), resultFile: join(dir, 'nope.json'), session: 'build-4009' }, dir));
    expect(missing.envelope.parse.reason).toBe('no-structured-output');
  });

  it('agy: reads the nested key; an ABSENT key is agy-key-absent', async () => {
    expect(extractAgyResult(JSON.stringify({ result: { result: { structured_output: DONE } } })).value).toEqual(DONE);
    expect(extractAgyResult(JSON.stringify({ result: { result: {} } })).reason).toBe('agy-key-absent');
    const { envelope } = await runWorker(spec({ launcher: 'agy', argv: printing(JSON.stringify({ result: { result: {} } })) }));
    expect(envelope.parse.reason).toBe('agy-key-absent');
  });

  it('migration only: with no structured output, the OLD delivery report is read and mapped (section 5 reader order)', async () => {
    const legacy = { session: 'build-4001', item: '4001', status: 'done', outcome: 'needs-human-judgment', reason: 'which shape?', filesTouched: ['a.mjs'], learning: null, startedAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:01:00.000Z' };
    const s = spec({ argv: printing(claudeStdout(undefined)) });
    const out = await runWorker(s, { legacyRead: () => legacy });
    expect(out.legacyRecord).toBe(legacy);
    expect(out.envelope).toMatchObject({ source: 'legacy-delivery-report', parse: { ok: true, reason: 'legacy-mapped' }, action: { type: 'operator' } });
  });

  it('a draft-write failure never loses the envelope: runWorker resolves and the done record is on disk', async () => {
    const s = spec({ argv: printing(claudeStdout(BLOCKED('tooling-defect'))) });
    const out = await runWorker(s, { writeDraft: () => { throw new Error('disk full'); } });
    expect(out.action.type).toBe('product-fix-draft');
    expect(read(s)).toMatchObject({ v: 2, status: 'done', action: { type: 'product-fix-draft' } });
  });

  it('records head before and after', async () => {
    const heads = ['aaa', 'bbb'];
    const { envelope } = await runWorker(spec(), { head: () => heads.shift() ?? 'bbb' });
    expect(envelope).toMatchObject({ headBefore: 'aaa', headAfter: 'bbb' });
  });

  it('rejects a bad spec instead of writing a record', async () => {
    await expect(runWorker({ role: 'build' })).rejects.toThrow(/spec\.launcher/);
  });
});

describe('claude argv: the schema rides on fresh and resumed turns', () => {
  const fresh = ['--restricted', '--model', 'sonnet', '-p', '--session-id', 'abc', 'PROMPT'];
  const resumed = ['--restricted', '--resume', 'abc', 'PROMPT'];
  it('adds --output-format json and --json-schema before the prompt, and -p when missing (resume)', () => {
    for (const argv of [fresh, resumed]) {
      const out = withStructuredOutput(argv);
      expect(out.at(-1)).toBe('PROMPT');
      expect(out).toContain('-p');
      expect(out[out.indexOf('--output-format') + 1]).toBe('json');
      expect(JSON.parse(out[out.indexOf('--json-schema') + 1]).$id).toBe('we.worker-result/v1');
    }
    expect(withStructuredOutput(resumed)).toContain('--resume');
    expect(withStructuredOutput(withStructuredOutput(fresh))).toEqual(withStructuredOutput(fresh));
    expect(() => withStructuredOutput([])).toThrow();
  });
  it('extractClaudeResult handles an array of messages and a non-object', () => {
    expect(extractClaudeResult(JSON.stringify([{ type: 'system' }, { type: 'result', structured_output: DONE }])).value).toEqual(DONE);
    expect(extractClaudeResult('null').reason).toBe('no-structured-output');
    expect(STRUCTURED_OUTPUT_SUFFIX).toContain('StructuredOutput');
  });
  it('the knob is off unless WE_WORKER_WRAPPER=on', () => {
    expect(workerWrapperEnabled({})).toBe(false);
    expect(workerWrapperEnabled({ WE_WORKER_WRAPPER: 'on' })).toBe(true);
    expect(workerWrapperEnabled({ WE_WORKER_WRAPPER: '1' })).toBe(false);
  });
});

describe('detached launch', () => {
  it('launchDetached spawns THIS file detached with the spec, and unrefs it', () => {
    const calls = [];
    const specDir = tmp();
    const r = launchDetached(spec(), { specDir, spawnFn: (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { pid: 4242, unref() { calls.push('unref'); } }; } });
    expect(r.wrapperPid).toBe(4242);
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(calls[0].argv[1]).toBe(`--spec=${r.specFile}`);
    expect(calls).toContain('unref');
    expect(JSON.parse(readFileSync(r.specFile, 'utf8')).session).toBe('build-4001');
  });

  it('the CLI runs a spec file to completion, leaves the v2 record and deletes the spec (a real child process)', () => {
    const s = spec();
    const specFile = join(s.completionsDir, 'spec.json');
    writeFileSync(specFile, JSON.stringify(s));
    const out = execFileSync(process.execPath, [join(process.cwd(), 'scripts/operations/worker-wrapper.mjs'), `--spec=${specFile}`], { encoding: 'utf8' });
    expect(JSON.parse(out)).toMatchObject({ session: 'build-4001', outcome: 'done', action: 'done' });
    expect(read(s)).toMatchObject({ v: 2, status: 'done' });
    expect(existsSync(specFile)).toBe(false);
  });

  it('the spec file never carries env (it can hold tokens), is owner-only, and an invalid session slug is refused', () => {
    const specDir = tmp();
    const calls = [];
    const r = launchDetached(spec({ env: { GH_TOKEN: 'ghp_abcdefghijklmnop12345' } }), { specDir, spawnFn: (c, a, o) => { calls.push(o); return { pid: 1, unref() {} }; } });
    const text = readFileSync(r.specFile, 'utf8');
    expect(text).not.toContain('ghp_');
    expect(JSON.parse(text).env).toBeUndefined();
    expect(statSync(r.specFile).mode & 0o777).toBe(0o600);
    expect(calls[0].env.GH_TOKEN).toBe('ghp_abcdefghijklmnop12345'); // the child inherits it through its environment, not a file
    expect(() => launchDetached(spec({ session: '../escape' }), { specDir })).toThrow(/invalid session slug/);
  });

  it('with no draftsDir in the spec, a draft goes to the shared 114 store under WE_OPERATIONS_DIR/drafts', async () => {
    const ops = tmp();
    const prev = process.env.WE_OPERATIONS_DIR;
    process.env.WE_OPERATIONS_DIR = ops;
    try {
      const s = spec({ argv: printing(claudeStdout(BLOCKED('tooling-defect'))) });
      delete s.draftsDir;
      await runWorker(s);
      expect(listDraftKeys(join(ops, 'drafts'))).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.WE_OPERATIONS_DIR; else process.env.WE_OPERATIONS_DIR = prev;
    }
  });
});
