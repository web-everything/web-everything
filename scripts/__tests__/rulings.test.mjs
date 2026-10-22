import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseDigest, resolveDigestPath, selectForInjection } from '../lib/rulings-digest.mjs';
import { buildInjection, writeOutput } from '../rulings-inject.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = [];
function digest() {
  const dir = mkdtempSync(join(tmpdir(), 'rulings-test-'));
  temporary.push(dir);
  return join(dir, 'rulings.md');
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = (n, cls = 'D', rule = 'Rule') => `R${n} | standing | ${cls} | "quote" | ${rule}`;
function run(script, path, args = [], input = '') {
  return spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], {
    cwd: root, env: { ...process.env, RULINGS_DIGEST_PATH: path, PRECOMPACT_SNAPSHOT_PATH: `${path}.snapshot.json` }, input, encoding: 'utf8', timeout: 10000,
  });
}
function context(output) { return output.hookSpecificOutput.additionalContext; }

describe('rulings digest', () => {
  it('parses comments, pipe-containing quotes, pending classes and retirement tags', () => {
    const rows = parseDigest(['# comment', '', 'bad',
      'R10 | 2026-10-21 / 2026-10-22 | S:check (pending) | "a | b" | Act mem:owed review:2026-11-01',
      row(2, 'J', 'Old superseded-by:R10'), row(3, 'D', 'Done codifiedIn:docs/rule.md'),
      row(4, 'D', 'Done → enforced by gate'), row(5, 'D', 'Old retired:manual'),
    ].join('\n'));
    expect(rows[0]).toMatchObject({ id: 'R10', num: 10, cls: 'S:check', pending: true,
      quote: '"a | b"', rule: 'Act', active: true, tags: { mem: 'owed', review: '2026-11-01' } });
    const retired = rows.slice(1);
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.every((r) => !r.active)).toBe(true);
  });

  it('resolves env, declared settings ownership, tilde, and built-in fallback', () => {
    const settings = { settings: { rulings: { digestPath: '~/custom.md' } }, owners: { 'rulings.digestPath': 'settings/example.json' } };
    expect(resolveDigestPath({ env: {}, settings })).toEqual({ path: join(homedir(), 'custom.md'), source: 'settings/example.json' });
    expect(resolveDigestPath({ env: { RULINGS_DIGEST_PATH: '/tmp/env.md' }, settings })).toEqual({ path: '/tmp/env.md', source: 'env:RULINGS_DIGEST_PATH' });
    expect(resolveDigestPath({ env: {}, settings: {} }).source).toBe('built-in');
  });

  it('preserves tag-like prose in active rules', () => {
    const rule = 'Require  codifiedIn:docs/x.md before closing decisions';
    expect(parseDigest(row(1, 'D', rule))[0]).toMatchObject({ rule, active: true, tags: {} });
  });

  it('parses only trailing metadata tokens', () => {
    const rows = parseDigest([
      row(1, 'D', 'Act mem:owed'),
      row(2, 'D', 'Act superseded-by:R3 mem:owed'),
      row(3, 'D', 'Act superseded-by:later'),
    ].join('\n'));
    expect(rows[0]).toMatchObject({ rule: 'Act', active: true, tags: { mem: 'owed' } });
    expect(rows[1]).toMatchObject({ rule: 'Act', active: false, tags: { 'superseded-by': 'R3', mem: 'owed' } });
    expect(rows[2]).toMatchObject({ rule: 'Act superseded-by:later', active: true, tags: {} });
  });

  it.each([
    'Act → enforced by review:gate mem:owed',
    'Act mem:owed → enforced by review:gate',
  ])('parses enforcement markers and trailing tags in either order: %s', (rule) => {
    expect(parseDigest(row(1, 'D', rule))[0]).toMatchObject({
      rule: 'Act', active: false, tags: { enforcedBy: 'review:gate', mem: 'owed' },
    });
  });

  it('caps 41 active rows at 40 and reports DIGEST OVER CAP', () => {
    const text = Array.from({ length: 41 }, (_, n) => row(n + 1)).join('\n');
    const selected = selectForInjection(parseDigest(text));
    expect(selected.lines).toHaveLength(40);
    expect(selected).toMatchObject({ overCap: true, activeCount: 41 });
    expect(context(buildInjection({ text, path: '/tmp/test', source: 'test' }))).toContain('DIGEST OVER CAP: retire');
  });

  it('counts UTF-8 bytes and separators at the 6144-byte cap', () => {
    const first = row(1, 'D', 'é'.repeat(1500));
    const second = row(2, 'D', 'é'.repeat(1600));
    expect(selectForInjection(parseDigest(`${first}\n${second}`))).toMatchObject({ lines: [first], overCap: true });
    const exact = row(3) + 'x'.repeat(6144 - Buffer.byteLength(row(3)));
    expect(selectForInjection(parseDigest(exact)).lines).toEqual([exact]);
    expect(selectForInjection(parseDigest(`${exact}x`)).lines).toEqual([]);
  });

  it('prioritizes pending S, J, D, then non-pending S with stable file order', () => {
    const text = [row(1, 'D'), row(2, 'S:built'), row(3, 'J'), row(4, 'S:a (pending)'),
      row(5, 'S:b (pending)'), row(6, 'J'), row(7, 'D', 'old superseded-by:R1')].join('\n');
    expect(selectForInjection(parseDigest(text)).lines.map((line) => line.split(' | ')[0]))
      .toEqual(['R4', 'R5', 'R3', 'R6', 'R1', 'R2']);
  });

  it('skips oversized rows and injects a later short ruling while reporting over cap', () => {
    const oversized = row(1, 'D', 'x'.repeat(6144));
    const short = row(2);
    expect(selectForInjection(parseDigest(`${oversized}\n${short}`)))
      .toEqual({ lines: [short], overCap: true, activeCount: 2 });
  });

  it('contains synchronous output failures', () => {
    const stream = { write() { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); } };
    expect(() => writeOutput(buildInjection({ text: null, path: '/tmp/test', source: 'test' }), stream)).not.toThrow();
  });

  it('exits 0 without an uncaught stack when stdout is closed', async () => {
    const path = digest();
    writeFileSync(path, row(1));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/rulings-inject.mjs')], {
        cwd: root, env: { ...process.env, RULINGS_DIGEST_PATH: path },
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve({ status, signal, stderr }));
      child.stdout.destroy();
      child.stdin.end();
    });
    expect(result).toEqual({ status: 0, signal: null, stderr: '' });
  });

  it('emits valid JSON and a one-line missing warning with exit 0, even with invalid stdin', () => {
    const path = digest();
    const result = run('rulings-inject.mjs', path, [], '{bad');
    expect(result.status).toBe(0);
    expect(context(JSON.parse(result.stdout))).toBe(`rulings digest missing at ${path} (source env:RULINGS_DIGEST_PATH)`);
  });

  it('injects on compact and registers startup, resume, compact right after bootstrap', () => {
    const path = digest();
    writeFileSync(path, row(1));
    const result = run('rulings-inject.mjs', path, [], JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'SessionStart', additionalContext: expect.stringContaining('R1 |'),
    } });
    const entries = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks.SessionStart;
    const index = entries.findIndex((entry) => entry.hooks.some((hook) => hook.command === 'node scripts/rulings-inject.mjs'));
    expect(entries.filter((entry) => entry.hooks.some((hook) => hook.command === 'node scripts/rulings-inject.mjs'))).toHaveLength(1);
    expect(entries[index - 1].hooks[0].command).toBe('node scripts/bootstrap-session.mjs');
    for (const source of ['compact', 'startup', 'resume']) expect(new RegExp(entries[index].matcher).test(source)).toBe(true);
  });

  it('contains unexpected read errors in one warning with exit 0', () => {
    const path = digest();
    const result = run('rulings-inject.mjs', resolve(path, '..'));
    expect(result.status).toBe(0);
    expect(context(JSON.parse(result.stdout))).toMatch(/^rulings digest warning: [^\n]+$/);
  });

  it('appends only the latest matching session snapshot for compact, excluding startup and resume', () => {
    const path = digest();
    writeFileSync(path, row(1));
    writeFileSync(`${path}.snapshot.json`, JSON.stringify({ snapshots: [
      { sessionId: 'A', atEt: 'old', trigger: 'auto', pendingAsks: ['old ask'] },
      { sessionId: 'A', atEt: '2026-10-22 10:30', trigger: 'manual', agents: [{ name: 'worker', status: 'running' }], pendingAsks: ['new ask'] },
      { sessionId: 'B', atEt: '2026-10-22 10:31', trigger: 'auto', pendingAsks: ['session B ask'] },
    ] }));
    for (const source of ['compact', 'startup', 'resume']) {
      const result = run('rulings-inject.mjs', path, [], JSON.stringify({ source, session_id: 'A' }));
      expect(result.status, result.stderr).toBe(0);
      const text = context(JSON.parse(result.stdout));
      expect(text).toContain(row(1));
      if (source === 'compact') {
        expect(text).toContain(`${row(1)}\n\nPre-compaction snapshot (2026-10-22 10:30 ET, trigger manual):`);
        expect(text).toContain('worker(running)');
        expect(text).toContain('new ask');
        expect(text).not.toContain('old ask');
        expect(text).not.toContain('session B ask');
      } else expect(text).not.toContain('Pre-compaction snapshot');
    }
  });

  it('uses the remaining context budget and truncates oversized snapshots at a line boundary', () => {
    const path = digest();
    const ruling = row(1, 'D', 'é'.repeat(2900));
    writeFileSync(path, ruling);
    writeFileSync(`${path}.snapshot.json`, JSON.stringify({ snapshots: [{ sessionId: 'A', atEt: 'today', trigger: 'auto',
      pendingAsks: Array.from({ length: 100 }, (_, n) => `ask ${n} ${'é'.repeat(100)}`),
    }] }));
    const result = run('rulings-inject.mjs', path, [], JSON.stringify({ source: 'compact', session_id: 'A' }));
    expect(result.status, result.stderr).toBe(0);
    const text = context(JSON.parse(result.stdout));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(text).toContain(ruling);
    expect(text).toContain('Pre-compaction snapshot');
    expect(text).toMatch(/\n… snapshot truncated$/);
    const direct = context(buildInjection({ text: ruling, path, source: 'test', snapshotText: 'snapshot\n' + 'é'.repeat(10000) }));
    expect(Buffer.byteLength(direct)).toBeLessThanOrEqual(8192);
    expect(direct).toMatch(/\nsnapshot\n… snapshot truncated$/);
  });

  it('preserves a roughly 6.5 KB digest with a configured 7000-byte budget', () => {
    const rows = Array.from({ length: 45 }, (_, n) => row(n + 1, 'D', 'x'.repeat(110)));
    const text = rows.join('\n');
    expect(Buffer.byteLength(text)).toBeGreaterThan(6144);
    expect(Buffer.byteLength(text)).toBeLessThan(7000);
    const args = { text, path: '/tmp/digest', source: 'test', maxBytes: 7000, maxLines: 50 };
    const original = context(buildInjection(args));
    const injected = context(buildInjection({ ...args, snapshotText: 'snapshot\n' + 'é'.repeat(3000) }));
    for (const ruling of rows) expect(injected).toContain(ruling);
    expect(injected.startsWith(original + '\n\n')).toBe(true);
    expect(Buffer.byteLength(injected)).toBeLessThanOrEqual(8192);
    expect(injected).toMatch(/\n… snapshot truncated$/);
  });

  it('preserves the entire digest and appends only an omission note when it exhausts the budget', () => {
    const text = Array.from({ length: 50 }, (_, n) => row(n + 1, 'D', 'x'.repeat(180))).join('\n');
    const args = { text, path: '/tmp/digest', source: 'test', maxBytes: 15000, maxLines: 50 };
    const original = context(buildInjection(args));
    expect(Buffer.byteLength(original)).toBeGreaterThan(8192);
    expect(context(buildInjection({ ...args, snapshotText: 'private snapshot data' })))
      .toBe(original + '\n\npre-compaction snapshot omitted: digest uses the budget');
    expect(original).toContain(text);
  });

  it.each([undefined, '', 'missing'])('reports no snapshot for a missing or unmatched session ID: %s', (session_id) => {
    const path = digest();
    writeFileSync(path, row(1));
    writeFileSync(`${path}.snapshot.json`, JSON.stringify({ snapshots: [
      { sessionId: 'B', atEt: 'today', trigger: 'auto', pendingAsks: ['session B ask'] },
      { sessionId: '', atEt: 'today', trigger: 'auto', pendingAsks: ['anonymous ask'] },
    ] }));
    const result = run('rulings-inject.mjs', path, [], JSON.stringify({ source: 'compact', session_id }));
    expect(result.status, result.stderr).toBe(0);
    const text = context(JSON.parse(result.stdout));
    expect(text).toContain('no pre-compaction snapshot for this session');
    expect(text).not.toContain('session B ask');
    expect(text).not.toContain('anonymous ask');
  });

  it('reports missing, invalid or malformed snapshot files on compact', () => {
    const path = digest();
    writeFileSync(path, row(1));
    for (const content of [null, '{bad', 'null', '{"snapshots":{}}', '{"snapshots":[{"sessionId":"A","agents":[null]}]}']) {
      if (content !== null) writeFileSync(`${path}.snapshot.json`, content);
      const result = run('rulings-inject.mjs', path, [], '{"source":"compact","session_id":"A"}');
      expect(result.status).toBe(0);
      expect(context(JSON.parse(result.stdout))).toContain(row(1));
      expect(context(JSON.parse(result.stdout))).not.toContain('Pre-compaction snapshot');
      expect(context(JSON.parse(result.stdout))).toContain('no pre-compaction snapshot for this session');
    }
  });

  it('adds and retires atomically, excludes retired rows, and honors --digest', () => {
    const path = digest();
    for (let n = 1; n <= 3; n++) {
      const result = run('rulings.mjs', `${path}.unused`, ['add', `--digest=${path}`, '--class=D', '--quote=Operator said', '--rule=Do it', '--tags=mem:owed,review:2026-11-01']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^R${n} \\| \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\|`));
      expect(result.stderr).toContain('source cli:--digest');
    }
    expect(run('rulings.mjs', path, ['retire', 'R1', '--by=gate']).status).toBe(0);
    expect(run('rulings.mjs', path, ['retire', 'R2', '--superseded-by=R3']).status).toBe(0);
    const active = run('rulings.mjs', path, ['list', '--active', '--json']);
    expect(JSON.parse(active.stdout).map((r) => r.id)).toEqual(['R3']);
    expect(run('rulings.mjs', path, ['retire', 'R3', '--codified-in=docs/rule.md']).status).toBe(0);
    expect(run('rulings.mjs', path, ['retire', 'R1', '--by=gate']).status).toBe(1);
    expect(run('rulings.mjs', path, ['retire', 'R99', '--by=gate']).status).toBe(1);
    expect(run('rulings.mjs', path, ['retire', 'R3', '--by=gate', '--codified-in=x']).status).toBe(1);
  });

  it('recovers an abandoned stale lock', () => {
    const path = digest();
    writeFileSync(`${path}.lock`, '');
    const old = new Date(Date.now() - 31000);
    utimesSync(`${path}.lock`, old, old);
    expect(run('rulings.mjs', path, ['add', '--class=J', '--quote=q', '--rule=r']).status).toBe(0);
  });

  it('round trips retirement by a colon-containing check after existing tags', () => {
    const path = digest();
    writeFileSync(path, `${row(1, 'D', 'Act mem:owed')}\n`);
    const result = run('rulings.mjs', path, ['retire', 'R1', '--by=review:gate']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd()).toBe(`${row(1, 'D', 'Act mem:owed')} → enforced by review:gate`);
    expect(parseDigest(readFileSync(path, 'utf8'))[0]).toMatchObject({
      rule: 'Act', active: false, tags: { mem: 'owed', enforcedBy: 'review:gate' },
    });
  });

  it.each(['review gate', 'review\tgate', ' review:gate', 'review:gate ', 'review\ngate'])(
    'refuses retirement checks containing whitespace: %j', (check) => {
      const path = digest();
      const original = `${row(1)}\n`;
      writeFileSync(path, original);
      const result = run('rulings.mjs', path, ['retire', 'R1', `--by=${check}`]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('invalid retirement marker');
      expect(readFileSync(path, 'utf8')).toBe(original);
    },
  );

  it('allocates distinct ids for concurrent writers', async () => {
    const path = digest();
    const statuses = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/rulings.mjs'), 'add', '--class=D', '--quote=q', '--rule=r'], {
        env: { ...process.env, RULINGS_DIGEST_PATH: path }, stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('close', resolve);
    })));
    expect(statuses).toEqual(Array(6).fill(0));
    expect(parseDigest(readFileSync(path, 'utf8')).map((r) => r.num)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
