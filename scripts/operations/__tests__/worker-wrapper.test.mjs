/**
 * @file worker-wrapper.test.mjs — item 117 slice S3a: the unified detached worker wrapper (D7 FINAL).
 * These run the wrapper against REAL child processes (node -e), so pid, stdin and timeout are proven, not mocked.
 */
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeStoredAwaitVerify, clearStoredAwaitVerify, awaitVerifyStoreKey } from '../../conveyor/await-verify.mjs';
import { validateCompletionRecord } from '../completion-record.mjs';
import { tryReadCompletion, writeCompletion } from '../completion-store.mjs';
import { WORKER_MARKER_ENV, WORKER_MARKER_VALUE } from '../session-role.mjs';
import { listDraftKeys } from '../worker-result-router.mjs';
import {
  MAX_AWAIT_RESUMES, RESULT_FILE_MAX_BYTES, resumeArgvFrom, resumeRequestPath, STRUCTURED_OUTPUT_SUFFIX, extractAgyResult, extractClaudeResult, launchDetached, runWorker, withStructuredOutput, workerWrapperEnabled,
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
      'signal termination': { argv: ['-e', `process.stdout.write(${out});process.kill(process.pid,'SIGKILL');${hang}`] },
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

  it('codex: a -o file the child wrote does not rescue a run that then failed', async () => {
    const dir = tmp();
    const resultFile = join(dir, 'last.json');
    const script = `require('fs').writeFileSync(${JSON.stringify(resultFile)}, ${JSON.stringify(JSON.stringify(DONE))});process.exitCode=2`;
    const { envelope } = await runWorker(spec({ launcher: 'codex-exec', resultFile, argv: ['-e', script], session: 'build-4003' }, dir));
    expect(envelope).toMatchObject({ parse: { ok: false }, result: { outcome: 'unparseable' } });
    expect(envelope.outcome).not.toBe('done');
  });

  it('codex: relative resultFile resolves against spec.cwd', async () => {
    const dir = tmp();
    const childDir = join(dir, 'child');
    mkdirSync(childDir);
    // vitest threads cannot chdir, so the wrapper's own cwd is process.cwd(): park an UNRELATED same-named file there
    const name = `wr-last-${process.pid}-${Date.now()}.json`;
    const sentinel = join(process.cwd(), name);
    writeFileSync(sentinel, 'unrelated');
    try {
      const script = `require('fs').writeFileSync(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(DONE))})`;
      const { envelope } = await runWorker(spec({ launcher: 'codex-exec', resultFile: name, cwd: childDir, argv: ['-e', script], session: 'build-4011' }, dir));
      expect(envelope).toMatchObject({ status: 'done', outcome: 'done', parse: { ok: true } });
      expect(readFileSync(sentinel, 'utf8')).toBe('unrelated'); // the pre-run cleanup must not touch the wrapper-cwd file
      // and the stale-file cleanup hits the CHILD's file: a leftover under spec.cwd is not this run's result
      writeFileSync(join(childDir, name), JSON.stringify(DONE));
      const stale = await runWorker(spec({ launcher: 'codex-exec', resultFile: name, cwd: childDir, argv: ['-e', '0'], session: 'build-4012' }, dir));
      expect(stale.envelope.parse).toEqual({ ok: false, reason: 'no-structured-output' });
    } finally {
      rmSync(sentinel, { force: true });
    }
  });

  it('every fail-closed or aborted envelope is a VALID record and never claims source "none" (that is for a legacy record that never reported)', async () => {
    const dir = tmp();
    const stopSource = new EventEmitter();
    const cases = {
      timeout: [spec({ argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300, session: 'build-4040' }, dir), {}],
      'nonzero exit': [spec({ argv: ['-e', 'process.exitCode=3'], session: 'build-4041' }, dir), {}],
      'no output': [spec({ argv: printing(claudeStdout(undefined)), session: 'build-4042' }, dir), {}],
      aborted: [spec({ argv: ['-e', 'setInterval(()=>{},1000)'], session: 'build-4043' }, dir), { isOperatorStop: () => true, stopSource }],
    };
    for (const [name, [s, io]] of Object.entries(cases)) {
      const { envelope } = await runWorker(s, io);
      expect(envelope.source, name).toBe('worker-result');
      expect(validateCompletionRecord(envelope), name).toEqual({ ok: true, errors: [] });
    }
  }, 60_000);

  it('the child never sees GH_TOKEN/GITHUB_TOKEN and is marked a worker, whether the spec carries env or inherits the wrapper\'s', async () => {
    const dir = tmp();
    const out = join(dir, 'env.txt');
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.${WORKER_MARKER_ENV}].map(String).join('|'))`;
    await runWorker(spec({ argv: ['-e', script], env: { ...process.env, GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaa1', GITHUB_TOKEN: 'ghp_bbbbbbbbbbbbbbbb2' }, session: 'build-4050' }, dir));
    expect(readFileSync(out, 'utf8')).toBe(`undefined|undefined|${WORKER_MARKER_VALUE}`);
    rmSync(out);
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_cccccccccccccccc3';
    try {
      await runWorker(spec({ argv: ['-e', script], session: 'build-4051' }, dir)); // no spec.env: inherits process.env
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
    }
    expect(readFileSync(out, 'utf8')).toBe(`undefined|undefined|${WORKER_MARKER_VALUE}`);
  }, 60_000);

  it('codex: a STALE -o file from an earlier attempt is not this run\'s result (clean exit, nothing written)', async () => {
    const dir = tmp();
    const resultFile = join(dir, 'last.json');
    writeFileSync(resultFile, JSON.stringify(DONE));
    const { envelope } = await runWorker(spec({ launcher: 'codex-exec', resultFile, argv: ['-e', '0'], session: 'build-4005' }, dir));
    expect(envelope.parse).toEqual({ ok: false, reason: 'no-structured-output' });
    expect(envelope.outcome).not.toBe('done');
  });

  it('a worker cannot pick its own failure class: a self-sent SIGTERM and a bare exit 143 are contract violations, never an operator stop', async () => {
    const dir = tmp();
    const term = spec({ argv: ['-e', `process.kill(process.pid,'SIGTERM');setInterval(()=>{},1000)`], session: 'build-4006' }, dir);
    expect((await runWorker(term)).envelope).toMatchObject({ outcome: 'blocked', parse: { ok: false, reason: 'ended-without-result' }, action: { type: 'product-fix-draft' }, result: { blocker: { kind: 'contract-violation' } } });
    expect(listDraftKeys(term.draftsDir)).toHaveLength(1);
    const exit143 = spec({ argv: ['-e', 'process.exitCode=143'], session: 'build-4009' }, dir);
    const out = (await runWorker(exit143)).envelope;
    expect(out.outcome).not.toBe('aborted');
    expect(out.action.type).toBe('product-fix-draft');
  }, 60_000);

  it('an operator stop is the WRAPPER being told to stop: the signal reaches the child, the envelope is aborted, no draft, and the listeners are gone', async () => {
    const stopSource = new EventEmitter();
    const dir = tmp();
    for (const [i, argv] of [['-e', 'setInterval(()=>{},1000)'], ['-e', `process.on('SIGTERM',()=>process.exit(143));setInterval(()=>{},1000)`]].entries()) {
      const s = spec({ argv, session: `build-402${i}` }, dir);
      const run = runWorker(s, { stopSource });
      for (let n = 0; n < 200 && !Number.isInteger(read(s)?.pid); n++) await new Promise((r) => setTimeout(r, 25)); // wait for the started record
      expect(stopSource.listenerCount('SIGTERM')).toBe(1);
      stopSource.emit('SIGTERM', 'SIGTERM');
      const { envelope } = await run;
      expect(envelope).toMatchObject({ outcome: 'aborted', action: { type: 'aborted' } });
      expect(listDraftKeys(s.draftsDir)).toEqual([]);
      expect(stopSource.listenerCount('SIGTERM')).toBe(0);
    }
  }, 60_000);

  it('a COOPERATIVE operator stop (the child handles the forwarded SIGTERM and exits 0) is still aborted with no draft, with or without earlier valid output', async () => {
    const stopSource = new EventEmitter();
    const dir = tmp();
    const ready = join(dir, 'ready');
    // the child announces itself ONLY after its handler is installed, so the stop can never beat it (a default-action TERM would be a signal death)
    const handler = `process.on('SIGTERM',()=>process.exit(0));require('fs').writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`;
    const variants = {
      'no output': ['-e', handler],
      'earlier valid output': ['-e', `process.stdout.write(${JSON.stringify(claudeStdout(DONE))});${handler}`],
    };
    let i = 0;
    for (const [name, argv] of Object.entries(variants)) {
      rmSync(ready, { force: true });
      const s = spec({ argv, session: `build-403${i++}` }, dir);
      const run = runWorker(s, { stopSource });
      for (let n = 0; n < 400 && !existsSync(ready); n++) await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(ready), name).toBe(true);
      stopSource.emit('SIGTERM', 'SIGTERM');
      const { envelope, failure } = await run;
      expect(failure, name).toBeNull(); // the child really did exit 0: this is the path `failure && ...` missed
      expect(envelope, name).toMatchObject({ outcome: 'aborted', action: { type: 'aborted' } });
      expect(envelope.outcome, name).not.toBe('done');
      expect(listDraftKeys(s.draftsDir), name).toEqual([]);
    }
  }, 60_000);

  it('the stop is not swallowed: once the envelope is written it is re-raised, and a stop that lands AFTER the child ended does not relabel a crash `aborted`', async () => {
    const dir = tmp();
    const reraise = [];
    const stopSource = new EventEmitter();
    const hung = spec({ argv: ['-e', 'setInterval(()=>{},1000)'], session: 'build-4060' }, dir);
    const run = runWorker(hung, { stopSource, reraise: (sig) => reraise.push(sig) });
    for (let n = 0; n < 200 && !Number.isInteger(read(hung)?.pid); n++) await new Promise((r) => setTimeout(r, 25));
    stopSource.emit('SIGINT', 'SIGINT');
    expect((await run).envelope.outcome).toBe('aborted');
    expect(reraise).toEqual(['SIGINT']);
    expect(read(hung)).toMatchObject({ status: 'done', outcome: 'aborted' }); // the record is written BEFORE the stop is handed back

    const late = spec({ argv: ['-e', 'process.exitCode=3'], session: 'build-4061' }, dir);
    const writeRecord = (rec, d) => { if (rec.status === 'done') stopSource.emit('SIGTERM', 'SIGTERM'); return writeCompletion(rec, d); };
    const out = await runWorker(late, { stopSource, reraise: (sig) => reraise.push(sig), writeRecord });
    expect(out.envelope.outcome).not.toBe('aborted'); // a genuine crash keeps its contract-violation draft
    expect(reraise).toEqual(['SIGINT', 'SIGTERM']);
  }, 60_000);

  it('REAL signal to a REAL detached wrapper process: the stop reaches the worker, the aborted record is written, then the wrapper dies of the signal', async () => {
    const dir = tmp();
    const s = spec({ argv: ['-e', 'setInterval(()=>{},1000)'], session: 'build-4062' }, dir);
    const specFile = join(dir, 'spec.json');
    writeFileSync(specFile, JSON.stringify(s));
    const wrapper = spawn(process.execPath, [join(process.cwd(), 'scripts/operations/worker-wrapper.mjs'), `--spec=${specFile}`], { stdio: 'ignore' });
    const exited = new Promise((r) => wrapper.once('exit', (code, signal) => r({ code, signal })));
    let childPid = null;
    for (let n = 0; n < 400 && !Number.isInteger(childPid); n++) { await new Promise((r) => setTimeout(r, 25)); childPid = read(s)?.pid ?? null; }
    expect(Number.isInteger(childPid)).toBe(true);
    wrapper.kill('SIGTERM');
    expect((await exited).signal).toBe('SIGTERM');
    expect(read(s)).toMatchObject({ v: 2, status: 'done', outcome: 'aborted', action: { type: 'aborted' } });
    expect(listDraftKeys(s.draftsDir)).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow(); // the worker did not outlive the stop
  }, 60_000);

  it('by default runWorker leaves no signal listener behind on the real process', async () => {
    const before = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((sig) => process.listenerCount(sig));
    await runWorker(spec({ session: 'build-4030' }));
    expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map((sig) => process.listenerCount(sig))).toEqual(before);
  });

  it('classification: an overflow is not blamed on a timeout', async () => {
    const dir = tmp();
    const flood = spec({ argv: ['-e', `const c='x'.repeat(1<<20);for(let i=0;i<10;i++)process.stdout.write(c);setInterval(()=>{},1000)`], session: 'build-4007', timeoutMs: 20_000 }, dir);
    const { envelope } = await runWorker(flood);
    expect(envelope.parse).toEqual({ ok: false, reason: 'ended-without-result' });
    expect(envelope.result.signature).not.toContain('timeout');
  }, 60_000);

  it('a throwing started-record write kills the already-spawned child instead of orphaning it', async () => {
    let pid = null;
    const s = spec({ argv: ['-e', 'setInterval(()=>{},1000)'], session: 'build-4008' });
    let calls = 0;
    const writeRecord = (rec, d) => { calls += 1; if (calls === 1) { pid = rec.pid; throw new Error('lock timeout'); } return writeCompletion(rec, d); };
    await expect(runWorker(s, { writeRecord })).rejects.toThrow(/lock timeout/); // infra fault, not filed as a worker contract violation
    expect(Number.isInteger(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow(); // gone: ESRCH
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

  it('codex: the -o file is read bounded and never through a symlink; an oversized, linked or non-regular file is unparseable even when its contents are a valid result', async () => {
    const dir = tmp();
    // the target and the padded file are each a VALID done result: only the bound / the symlink refusal can make them unparseable
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify(DONE));
    const resultFile = join(dir, 'last.json');
    const cases = {
      oversized: `require('fs').writeFileSync(${JSON.stringify(resultFile)}, ' '.repeat(${RESULT_FILE_MAX_BYTES + 10}) + ${JSON.stringify(JSON.stringify(DONE))})`,
      symlink: `require('fs').symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(resultFile)})`,
      directory: `require('fs').mkdirSync(${JSON.stringify(resultFile)})`,
      // a FIFO would block a plain blocking open() forever, past every timeout: it must be refused, not hang the wrapper
      fifo: `require('child_process').execFileSync('mkfifo',[${JSON.stringify(resultFile)}])`,
    };
    let i = 0;
    for (const [name, script] of Object.entries(cases)) {
      rmSync(resultFile, { recursive: true, force: true });
      // chatty stdout: the refusal note must survive the evidence's 500-char prose tail
      const chatty = `process.stdout.write('z'.repeat(2000));${script}`;
      const { envelope } = await runWorker(spec({ launcher: 'codex-exec', resultFile, argv: ['-e', chatty], session: `build-405${i++}` }, dir));
      expect(envelope, name).toMatchObject({ parse: { ok: false, reason: 'schema-violation' }, result: { outcome: 'unparseable' } });
      expect(envelope.result.blocker.evidence.text, name).toMatch(/result file refused/);
      expect(envelope.outcome, name).not.toBe('done');
      expect(JSON.stringify(envelope).length, name).toBeLessThan(RESULT_FILE_MAX_BYTES / 2);
    }
    // a small regular file still works (the bound is on size, not on the channel)
    rmSync(resultFile, { recursive: true, force: true });
    const ok = await runWorker(spec({ launcher: 'codex-exec', resultFile, argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(resultFile)}, ${JSON.stringify(JSON.stringify(DONE))})`], session: 'build-4058' }, dir));
    expect(ok.envelope).toMatchObject({ outcome: 'done', parse: { ok: true } });
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
    expect(JSON.parse(readFileSync(r.specFile, 'utf8'))).toMatchObject({ session: 'build-4001', specDir });
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
    // the detached wrapper inherits the launcher's environment (not a file) with the token STRIPPED and the worker marker set
    expect(calls[0].env.GH_TOKEN).toBeUndefined();
    expect(calls[0].env[WORKER_MARKER_ENV]).toBe(WORKER_MARKER_VALUE);
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

// 117 S3b regression 2026-10-08: the old wrapper finalized run 1 and never consumed a resume.
describe('wrapped verification waits', () => {
  const sid = '12345678-1234-4234-8234-123456789abc';
  const start = Date.parse('2026-10-08T10:00:00.000Z');
  const awaiting = { awaiting: true, record: { sha: 'a'.repeat(40), pr: 7, ref: 'lane/fix-7', requestedAt: new Date(start).toISOString() } };
  // Each turn that asks to wait again writes a NEW await record (its own `requestedAt`); an identical one is a leftover of an answered wait.
  const awaitingTurn = (turn) => ({ awaiting: true, record: { ...awaiting.record, requestedAt: new Date(start + turn).toISOString() } });
  const harness = () => {
    const s = spec({ sessionId: sid, specDir: tmp(), cwd: '/lane', argv: withStructuredOutput(['--session-id', sid, '--permission-mode', 'auto', '--model', 'sonnet', '--settings', '{}', 'first']) });
    const calls = [], writes = [], drafts = [], heads = [];
    let ms = start;
    const io = {
      now: () => new Date(ms).toISOString(), selfPid: 9001, pollMs: 100,
      head: () => { heads.push(1); return 'a'; },
      writeRecord: (rec, dir) => { writes.push(structuredClone(rec)); writeCompletion(rec, dir); },
      writeDraft: (...args) => drafts.push(args),
      spawnFn: () => ({ pid: 1234 + calls.length }),
      spawnToCompletionFn: async (command, argv, opts, { spawnFn }) => {
        calls.push({ argv, opts }); spawnFn(command, argv, opts);
        return { stdout: claudeStdout({ ...DONE, summary: `turn ${calls.length}` }), stderr: '' };
      },
      awaitingVerify: () => calls.length === 1 ? awaiting : null,
      sleep: async (delay) => { ms += delay; writeFileSync(resumeRequestPath(s.specDir, s.session), JSON.stringify({ v: 1, sessionId: sid, prompt: 'verified', at: new Date(ms).toISOString() })); },
    };
    return { s, io, calls, writes, drafts, heads, advance: (delay) => { ms += delay; } };
  };
  it('keeps its own live pid while waiting, resumes the same session, and finalizes only the last output', async () => {
    const h = harness();
    const out = await runWorker(h.s, h.io);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].argv).toEqual(resumeArgvFrom(h.s.argv, { sessionId: sid, prompt: 'verified' }));
    expect(h.calls[1].argv).not.toContain('--session-id');
    expect(h.calls[1].opts.timeout).toBe(h.s.timeoutMs - 100);
    expect(h.writes).toContainEqual(expect.objectContaining({ status: 'started', pid: 9001, cwd: '/lane', awaitingVerify: awaiting.record }));
    expect(h.writes.filter((r) => r.status === 'done')).toHaveLength(1);
    expect(h.writes.every((r) => r.cwd === '/lane' && r.startedAt === new Date(start).toISOString())).toBe(true);
    expect(h.writes.at(-2)).not.toHaveProperty('awaitingVerify');
    expect(out.envelope).toMatchObject({ v: 2, status: 'done', parse: { ok: true }, result: { summary: 'turn 2' } });
    expect(out.envelope).not.toHaveProperty('awaitingVerify');
    expect(existsSync(resumeRequestPath(h.s.specDir, h.s.session))).toBe(false);
    expect(h.heads).toHaveLength(2);
    expect(h.drafts).toHaveLength(0);
  });
  // PR #4462 review: a wait that ends with no verdict delivered used to finalize the awaiting turn's `done` as a success.
  // The harness never pushed, so the work is unverified and unpushed: it is a retryable infra block, never `done`.
  it.each(['expired', 'deadline', 'foreign'])('%s ends the wait as a retryable block, not as the first turn\'s done', async (mode) => {
    const h = harness();
    let polled = false;
    h.io.awaitingVerify = () => polled && mode !== 'deadline' ? null : awaiting;
    h.io.sleep = async () => {
      polled = true;
      h.advance(mode === 'deadline' ? h.s.timeoutMs : 100);
      if (mode === 'foreign') writeFileSync(resumeRequestPath(h.s.specDir, h.s.session), JSON.stringify({ v: 1, sessionId: 'foreign', prompt: 'wrong' }));
    };
    const out = await runWorker(h.s, h.io);
    expect(h.calls).toHaveLength(1);
    expect(out.envelope).toMatchObject({
      status: 'done', outcome: 'blocked-on-infra', parse: { ok: true }, action: { type: 'retry-after-cooloff' },
      result: { outcome: 'blocked', blocker: { kind: 'infra-transient', component: 'verify-wait', retryable: true } },
    });
    expect(out.envelope.result.blocker.evidence.text).toContain('turn 1'); // the awaiting turn's own summary stays as evidence
    expect(out.envelope.result.blocker.evidence.text).toContain('a'.repeat(40).slice(0, 12));
    expect(out.envelope).not.toHaveProperty('awaitingVerify');
    expect(existsSync(resumeRequestPath(h.s.specDir, h.s.session))).toBe(false);
  });
  it('an unfinished wait overrides a stale self-reported done word from the legacy store', async () => {
    const h = harness();
    h.s.preserveLegacyWords = true;
    h.io.legacyRead = () => ({ status: 'done', outcome: 'healed' });
    h.io.awaitingVerify = () => awaiting;
    h.io.sleep = async () => { h.advance(h.s.timeoutMs); };
    const out = await runWorker(h.s, h.io);
    expect(out.envelope.outcome).toBe('blocked-on-infra');
  });
  // An await record that EXISTS but cannot be read is an unknown, not "no wait owed": the first check must not finalize `done`.
  it('a torn await record in the default store blocks the run; a missing one is a normal done', async () => {
    const store = tmp();
    vi.stubEnv('WE_AWAIT_VERIFY_STORE', store);
    try {
      const missing = harness();
      delete missing.io.awaitingVerify;
      expect((await runWorker(missing.s, missing.io)).result.outcome).toBe('done');
      writeFileSync(join(store, `${sid}.json`), '{"v":1,"sessionId":');
      const torn = harness();
      delete torn.io.awaitingVerify;
      const out = await runWorker(torn.s, torn.io);
      expect(torn.calls).toHaveLength(1);
      expect(out.result).toMatchObject({ outcome: 'blocked', blocker: { kind: 'infra-transient', component: 'verify-wait' } });
      expect(out.envelope.outcome).toBe('blocked-on-infra');
    } finally { vi.unstubAllEnvs(); }
  });
  it('an injected unreadable await check blocks the run too', async () => {
    const h = harness();
    h.io.awaitingVerify = () => ({ unreadable: true });
    expect((await runWorker(h.s, h.io)).result).toMatchObject({ outcome: 'blocked', blocker: { component: 'verify-wait' } });
  });
  // PR #4462 review: the default adapter answered null for a record that was OURS but already past its TTL when the child
  // exited, so the first post-exit check skipped the wait and published the awaiting turn's `done` unverified.
  describe('the default await store at the first post-exit check', () => {
    const ttl = 150 * 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    const withStore = async (record, assert) => {
      const store = tmp();
      vi.stubEnv('WE_AWAIT_VERIFY_STORE', store);
      try {
        const h = harness();
        delete h.io.awaitingVerify;
        if (record) writeFileSync(join(store, `${sid}.json`), `${JSON.stringify({ v: 1, sessionId: sid, who: h.s.session, ...awaiting.record, ...record })}\n`);
        await assert(h, await runWorker(h.s, h.io));
      } finally { vi.unstubAllEnvs(); }
    };
    const blocked = (h, out) => {
      expect(h.calls).toHaveLength(1);
      expect(out.result).toMatchObject({ outcome: 'blocked', blocker: { kind: 'infra-transient', component: 'verify-wait', retryable: true } });
      expect(out.envelope).toMatchObject({ status: 'done', outcome: 'blocked-on-infra', action: { type: 'retry-after-cooloff' } });
    };
    it('an already-expired record of this session is a retryable block, not a done', () => withStore({ requestedAt: iso(start - ttl - 1) }, (h, out) => {
      blocked(h, out);
      expect(out.result.blocker.evidence.text).toContain('a'.repeat(12));
    }));
    it.each([
      ['future-dated beyond the skew allowance', { requestedAt: iso(start + 6 * 60 * 1000) }],
      ['missing its pr', { pr: undefined }],
      ['unparseable requestedAt', { requestedAt: 'not-a-date' }],
    ])('a record that is %s is unknown, so it blocks too', (_name, record) => withStore(record, blocked));
    it('a record that speaks for another session, or none at all, is no wait owed', async () => {
      await withStore({ sessionId: 'other', who: 'other-session' }, (h, out) => { expect(out.result.outcome).toBe('done'); expect(h.calls).toHaveLength(1); });
      await withStore(null, (h, out) => { expect(out.result.outcome).toBe('done'); });
    });
  });
  it('the cap-or-deadline look-again treats an expired record as an unfinished wait', async () => {
    const h = harness();
    h.io.awaitingVerify = () => (h.calls.length <= MAX_AWAIT_RESUMES ? awaitingTurn(h.calls.length) : { expired: true, record: awaitingTurn(h.calls.length).record });
    const out = await runWorker(h.s, h.io);
    expect(h.calls).toHaveLength(1 + MAX_AWAIT_RESUMES);
    expect(out.result).toMatchObject({ outcome: 'blocked', blocker: { component: 'verify-wait' } });
  });
  // Deliberate non-regression pins: the pass clears the record right after it writes the resume request, so a leftover copy only
  // exists when that clear failed. The wait it described was answered, so it must not turn the finished resumed turn into a block.
  it.each(['expired', 'live'])('a %s leftover of a wait the last resume already answered is not a new obligation', async (kind) => {
    const h = harness();
    h.io.awaitingVerify = () => (h.calls.length === 1 ? awaiting : kind === 'live' ? awaiting : { expired: true, record: awaiting.record });
    const out = await runWorker(h.s, h.io);
    expect(h.calls).toHaveLength(2);
    expect(out.result).toMatchObject({ outcome: 'done', summary: 'turn 2' });
  });
  it('a NEW wait after a resume (different requestedAt) is still owed', async () => {
    const h = harness();
    h.io.awaitingVerify = () => (h.calls.length === 1 ? awaiting : { expired: true, record: awaitingTurn(h.calls.length).record });
    expect((await runWorker(h.s, h.io)).result).toMatchObject({ outcome: 'blocked', blocker: { component: 'verify-wait' } });
  });
  it('the unfinished-wait evidence redacts the fixer-typed sha and ref', async () => {
    const h = harness();
    const ref = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 @octocat `x` <!-- y -->';
    h.io.awaitingVerify = () => ({ expired: true, record: { ...awaiting.record, ref, sha: '@octocat-----' } });
    const text = (await runWorker(h.s, h.io)).result.blocker.evidence.text;
    expect(text).toContain('[redacted]');
    for (const raw of ['ghp_abcdefghijklmnopqrstuvwxyz', '<!--', '`x`']) expect(text).not.toContain(raw);
    expect(text).not.toMatch(/(^|[^​])@octocat/);
  });
  it('an intermediate turn that is not done is left as the worker said it', async () => {
    const h = harness();
    h.io.spawnToCompletionFn = async (command, argv, opts, { spawnFn }) => {
      h.calls.push({ argv, opts }); spawnFn(command, argv, opts);
      return { stdout: claudeStdout(BLOCKED('needs-ruling', { ruling: { question: 'q', options: ['a', 'b'], recommendation: 'a' } })), stderr: '' };
    };
    h.io.awaitingVerify = () => awaiting;
    h.io.sleep = async () => { h.advance(h.s.timeoutMs); };
    const out = await runWorker(h.s, h.io);
    expect(out.envelope.result.blocker.kind).toBe('needs-ruling');
  });
  it('consumes a queued resume even after the pass clears the await record', async () => {
    const h = harness();
    const sleep = h.io.sleep;
    let cleared = false;
    const poll = h.io.awaitingVerify;
    h.io.awaitingVerify = () => cleared ? null : poll();
    h.io.sleep = async (ms) => { await sleep(ms); cleared = true; };
    expect((await runWorker(h.s, h.io)).result.summary).toBe('turn 2');
  });
  it('bounds repeated verify resumes at six without resetting the wall deadline', async () => {
    const h = harness();
    h.io.awaitingVerify = () => awaitingTurn(h.calls.length);
    const out = await runWorker(h.s, h.io);
    expect(MAX_AWAIT_RESUMES).toBe(6);
    expect(h.calls).toHaveLength(1 + MAX_AWAIT_RESUMES);
    // the cap ran out while the last turn was STILL awaiting a verdict: that turn's `done` is not a completion
    expect(out.result).toMatchObject({ outcome: 'blocked', blocker: { kind: 'infra-transient', component: 'verify-wait' } });
    expect(out.result.blocker.evidence.text).toContain(`turn ${1 + MAX_AWAIT_RESUMES}`);
    expect(out.envelope.deadlineAt).toBe(new Date(start + h.s.timeoutMs).toISOString());
  });
  it('a last turn that is no longer awaiting is a normal done (the cap is not a block by itself)', async () => {
    const h = harness();
    h.io.awaitingVerify = () => h.calls.length <= MAX_AWAIT_RESUMES ? awaitingTurn(h.calls.length) : null;
    const out = await runWorker(h.s, h.io);
    expect(h.calls).toHaveLength(1 + MAX_AWAIT_RESUMES);
    expect(out.result).toMatchObject({ outcome: 'done', summary: `turn ${1 + MAX_AWAIT_RESUMES}` });
  });
  it('reads the default host await store and consumes the request after that record is cleared', async () => {
    const h = harness();
    const store = tmp();
    vi.stubEnv('WE_AWAIT_VERIFY_STORE', store);
    try {
      writeStoredAwaitVerify({ v: 1, sessionId: sid, who: h.s.session, ...awaiting.record }, { dir: store });
      delete h.io.awaitingVerify;
      const sleep = h.io.sleep;
      h.io.sleep = async (ms) => {
        await sleep(ms);
        clearStoredAwaitVerify(awaitVerifyStoreKey({ sessionId: sid }), { dir: store });
      };
      expect((await runWorker(h.s, h.io)).result.summary).toBe('turn 2');
      expect(h.writes.some((r) => r.awaitingVerify)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it('does not reuse an earlier StructuredOutput when the resumed turn omits one', async () => {
    const h = harness();
    const spawn = h.io.spawnToCompletionFn;
    h.io.spawnToCompletionFn = async (...args) => {
      const out = await spawn(...args);
      return h.calls.length === 2 ? { stdout: claudeStdout(undefined), stderr: '' } : out;
    };
    expect((await runWorker(h.s, h.io)).envelope.parse).toMatchObject({ ok: false, reason: 'no-structured-output' });
    expect(h.drafts).toHaveLength(1);
  });
  it.each(['failure', 'aborted', 'agy', 'codex-exec'])('does not wait after %s', async (mode) => {
    const h = harness();
    if (mode === 'failure') h.io.spawnToCompletionFn = async () => { throw new Error('failed'); };
    else if (mode === 'aborted') h.io.isOperatorStop = () => true;
    else h.s.launcher = mode;
    h.io.awaitingVerify = () => { throw new Error('must not inspect await store'); };
    await runWorker(h.s, h.io);
  });
});

it('resumeArgvFrom preserves flags, replaces the identity and prompt, and leaves its input unchanged', () => {
  const argv = withStructuredOutput(['-p', '--session-id', 'original', '--permission-mode', 'auto', '--model', 'sonnet', '--settings', '{}', 'old']);
  const copy = [...argv];
  const out = resumeArgvFrom(argv, { sessionId: 'same', prompt: 'next' });
  expect(out).toEqual(['-p', '--resume', 'same', ...argv.slice(3, -1), `next${STRUCTURED_OUTPUT_SUFFIX}`]);
  expect(argv).toEqual(copy);
  expect(out[out.indexOf('--json-schema') + 1]).toContain('"maxLength":280');
});

it('replays the shortened real Claude results through the ci-heal wrapper', async () => {
  const fixtures = JSON.parse(readFileSync(join(process.cwd(), 'scripts/operations/__tests__/fixtures/wrapped-worker-results-2026-10-08.json'), 'utf8'));
  for (const { structuredOutput: value } of Object.values(fixtures)) {
    const { envelope } = await runWorker(spec({ role: 'ci-heal' }), {
      spawnToCompletionFn: async () => ({ stdout: claudeStdout({ ...value, summary: value.summary.slice(0, 280) }), stderr: '' }),
    });
    expect(envelope).toMatchObject({ v: 2, parse: { ok: true } });
    expect(envelope.outcome).not.toBe('blocked');
    expect(envelope.cwd).toBeNull();
  }
});

it('tells non-interactive workers to keep work foreground and end every turn with a capped result', () => {
  for (const text of ['280 characters', '300 characters', 'FOREGROUND', 'never use run_in_background', 'very last action', 'awaiting harness verify', 'outcome "done"', 'last StructuredOutput']) {
    expect(STRUCTURED_OUTPUT_SUFFIX).toContain(text);
  }
});
