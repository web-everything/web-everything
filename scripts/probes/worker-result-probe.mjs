#!/usr/bin/env node
/**
 * worker-result-probe.mjs — slice S0 of item 117 (worker JSON output contract).
 *
 * Runs one tiny live request per launcher and reports, for each, whether a JSON schema was HONORED and WHERE the
 * structured result landed: `{launcher, honored, resultLocation, resumeKeepsSchema, failureShape, notes}`.
 * Launchers: `claude -p`, `claude --bg`, `claude --bg --resume`, `codex exec`, `codex exec resume`, `agy`.
 *
 *   node scripts/probes/worker-result-probe.mjs [--json] [--only=claude-p,codex-exec,...]
 *
 * Spend is small on purpose: haiku for Claude, one-line prompts, a throwaway schema (NOT the real
 * we.worker-result schema, which S1 owns). Every probe is isolated: a missing CLI, an auth failure or a timeout
 * becomes `honored: null` with the reason in `notes`, never a crash, so the script exits 0 whenever it finished.
 * The two `claude --bg` sessions it starts are stopped by their own id at the end (never a blanket kill).
 *
 * Findings recorded in the S0 PR (CLI versions: claude 2.1.293, codex-cli 0.155.1, agy 1.3.1):
 *   - `codex exec` waits forever on stdin when stdin is not a TTY and inherits no EOF: always spawn it with
 *     stdin = /dev/null (or a piped prompt). Without it a launcher hangs ("Reading additional input from stdin...").
 *   - Codex strict schema: a `required` that omits a property is rejected by the API (400 invalid_json_schema,
 *     `turn.failed`, exit 1, and NO -o file is written).
 *   - agy `--output-format json` puts `structured_output` at the TOP level (the stream-json route nests it under
 *     `result`); when a tool is auto-denied the key is ABSENT and the response is empty.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A throwaway strict-mode schema (all keys required, additionalProperties:false) that all three CLIs accept. */
export const PROBE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['outcome', 'note'],
  properties: { outcome: { type: 'string', enum: ['done', 'blocked'] }, note: { type: 'string' } },
});
const SCHEMA_JSON = JSON.stringify(PROBE_SCHEMA);
const PROMPT = 'Reply with outcome done and note hello. Use no tools.';
const PROMPT2 = 'Now reply with outcome blocked and note again. Use no tools.';

/** Pure: does a parsed value match the probe schema's shape? */
export function matchesProbeShape(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join() === 'note,outcome'
    && ['done', 'blocked'].includes(v.outcome) && typeof v.note === 'string';
}

/** Pure: safe JSON.parse → value or null. */
export function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function run(cmd, args, { cwd, timeoutMs = 120000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: r.error.code === 'ENOENT' ? `${cmd} not installed` : String(r.error.message), stdout: '', stderr: '', status: null };
  return { ok: true, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const skip = (launcher, reason) => ({ launcher, honored: null, resultLocation: null, notes: reason });

function probeClaudeP(dir) {
  const sid = randomUUID();
  const base = ['-p', '--model', 'haiku', '--json-schema', SCHEMA_JSON, '--output-format', 'json', '--max-budget-usd', '0.3'];
  const r = run('claude', [PROMPT, ...base, '--session-id', sid]);
  if (!r.ok) return skip('claude -p', r.reason);
  const j = tryParse(r.stdout);
  const honored = !!j && j.subtype === 'success' && matchesProbeShape(j.structured_output);
  const r2 = run('claude', [PROMPT2, ...base, '--resume', sid]);
  const j2 = tryParse(r2.stdout);
  const budget = run('claude', [PROMPT, ...base.slice(0, -1), '0.00001', '--no-session-persistence']);
  const jb = tryParse(budget.stdout);
  return {
    launcher: 'claude -p', honored, resultLocation: 'stdout JSON field `structured_output` (the `result` field is the same JSON as a string)',
    resumeKeepsSchema: !!j2 && matchesProbeShape(j2.structured_output),
    failureShape: { budgetKill: jb ? { subtype: jb.subtype, is_error: jb.is_error, terminal_reason: jb.terminal_reason, structured_output: jb.structured_output ?? null, exit: budget.status } : 'unparseable stdout',
      invalidSchemaArg: 'exit 1, stderr "--json-schema is not valid JSON", empty stdout' },
    notes: `subtype=${j?.subtype}; --resume with the schema works but the resumed turn reports a new session_id (${j2?.session_id && j2.session_id !== sid ? 'forked' : 'same'}).`,
  };
}

function bgStateFile(id) { return join(homedir(), '.claude', 'jobs', id, 'state.json'); }
function readState(id) { try { return JSON.parse(readFileSync(bgStateFile(id), 'utf8')); } catch { return null; } }
function waitForStructured(id, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = readState(id);
    if (s && s.structuredResult && (s.state === 'done' || s.tempo === 'idle')) return s;
    sleepMs(1500);
  }
  return readState(id);
}

function probeClaudeBg(cwd) {
  const spawned = [];
  const start = (args) => {
    const r = run('claude', ['--bg', ...args], { cwd, timeoutMs: 60000 });
    if (!r.ok) return { err: r.reason };
    const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(r.stdout + r.stderr);
    if (!m) return { err: `no session id in output: ${(r.stdout + r.stderr).slice(0, 160).replace(/\s+/g, ' ')}` };
    spawned.push(m[1]);
    return { id: m[1], out: r.stdout };
  };
  try {
    const a = start(['-n', 'probe117-bg', PROMPT, '--model', 'haiku', '--json-schema', SCHEMA_JSON]);
    if (a.err) return [skip('claude --bg', a.err), skip('claude --bg --resume', a.err)];
    const sa = waitForStructured(a.id);
    const honored = !!sa && matchesProbeShape(sa.structuredResult);
    const bg = {
      launcher: 'claude --bg', honored, resultLocation: '~/.claude/jobs/<id>/state.json field `structuredResult` (also the last `StructuredOutput` tool_use in the transcript)',
      notes: `state=${sa?.state}; \`--json-schema\` stays in respawnFlags: ${JSON.stringify(sa?.respawnFlags ?? []).includes('--json-schema')}. Idle session stays state=working until stopped or finished.`,
    };
    const b = start(['--resume', sa?.sessionId ?? a.id, '--json-schema', SCHEMA_JSON, PROMPT2]);
    let resume;
    if (b.err) resume = skip('claude --bg --resume', b.err);
    else {
      const sb = waitForStructured(b.id);
      resume = {
        launcher: 'claude --bg --resume', honored: !!sb && matchesProbeShape(sb.structuredResult),
        resultLocation: 'state.json `structuredResult` of the NEW session id (resume starts a copy when the original is still running)',
        notes: `--resume accepts --json-schema (2.1.293); new id ${b.id} vs ${a.id}; state=${sb?.state}.`,
      };
    }
    bg.failureShape = 'operator `claude stop <id>`: state.json state=stopped; structuredResult stays whatever was last set (null if none).';
    return [bg, resume];
  } finally {
    for (const id of spawned) run('claude', ['stop', id], { cwd, timeoutMs: 30000 });
  }
}

function probeCodex(dir) {
  const schema = join(dir, 'codex-schema.json'); writeFileSync(schema, SCHEMA_JSON);
  const out1 = join(dir, 'c1.txt'); const out2 = join(dir, 'c2.txt'); const out3 = join(dir, 'c3.txt');
  const common = ['--json', '--skip-git-repo-check', '--output-schema', schema];
  const r = run('codex', ['exec', ...common, '-o', out1, '-s', 'read-only', PROMPT], { cwd: dir });
  if (!r.ok) return [skip('codex exec', r.reason), skip('codex exec resume', r.reason)];
  const tid = /"thread_id":"([^"]+)"/.exec(r.stdout)?.[1];
  const v1 = existsSync(out1) ? tryParse(readFileSync(out1, 'utf8')) : null;
  const bad = join(dir, 'codex-bad.json');
  writeFileSync(bad, JSON.stringify({ ...PROBE_SCHEMA, required: ['outcome'] }));
  const f = run('codex', ['exec', '--json', '--skip-git-repo-check', '--output-schema', bad, '-o', out3, '-s', 'read-only', 'hi'], { cwd: dir });
  const exec = {
    launcher: 'codex exec', honored: matchesProbeShape(v1), resultLocation: 'the `-o <file>` (last agent message) and the `agent_message` item in the --json stream; the file is the JSON text',
    failureShape: { nonStrictSchema: `exit ${f.status}; ${/invalid_json_schema/.test(f.stdout) ? '400 invalid_json_schema in a `turn.failed` event' : 'see stdout'}; -o file written: ${existsSync(out3)}` },
    notes: 'stdin MUST be closed (spawn with stdio ignore) or codex blocks on "Reading additional input from stdin...".',
  };
  let resume;
  if (!tid) resume = skip('codex exec resume', 'no thread_id in --json stream');
  else {
    const r2 = run('codex', ['exec', 'resume', tid, ...common, '-o', out2, PROMPT2], { cwd: dir });
    const v2 = existsSync(out2) ? tryParse(readFileSync(out2, 'utf8')) : null;
    resume = { launcher: 'codex exec resume', honored: r2.ok && matchesProbeShape(v2), resultLocation: 'same: `-o <file>`', notes: '`resume` takes --output-schema and -o; the schema applies to the resumed turn.' };
  }
  return [exec, resume];
}

function probeAgy(dir) {
  const schema = join(dir, 'agy-schema.json'); writeFileSync(schema, SCHEMA_JSON);
  const base = ['--output-format', 'json', '--json-schema', schema, '--print-timeout', '90s'];
  const r = run('agy', ['--print', PROMPT, ...base], { cwd: dir });
  if (!r.ok) return skip('agy', r.reason);
  const j = tryParse(r.stdout);
  const denied = run('agy', ['--print', 'Run the shell command: echo hi > x.txt , then report.', ...base], { cwd: dir });
  const jd = tryParse(denied.stdout);
  const r2 = j?.conversation_id ? run('agy', ['--print', PROMPT2, '--conversation', j.conversation_id, ...base], { cwd: dir }) : null;
  const j2 = r2 ? tryParse(r2.stdout) : null;
  return {
    launcher: 'agy', honored: !!j && j.status === 'SUCCESS' && matchesProbeShape(j.structured_output),
    resultLocation: 'stdout JSON top-level `structured_output` (json mode; nested under `result` only in stream-json mode)',
    resumeKeepsSchema: !!j2 && matchesProbeShape(j2.structured_output),
    failureShape: { toolAutoDenied: jd ? { status: jd.status, structured_output_key_present: 'structured_output' in jd, response: jd.response ?? null } : 'unparseable stdout', stderrHint: denied.stderr.slice(0, 120) },
    notes: 'a missing `structured_output` key (not null) is the failure signal; status stays SUCCESS.',
  };
}

const PROBES = {
  'claude-p': (c) => probeClaudeP(c.dir), 'claude-bg': (c) => probeClaudeBg(c.cwd),
  codex: (c) => probeCodex(c.dir), agy: (c) => probeAgy(c.dir),
};

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), 'worker-result-probe-'));
  const ctx = { dir, cwd: process.cwd() };
  const results = [];
  try {
    for (const [name, fn] of Object.entries(PROBES)) {
      if (only.length && !only.includes(name)) continue;
      try { results.push(...[].concat(fn(ctx))); } catch (e) { results.push(skip(name, `probe crashed: ${e.message}`)); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (json) process.stdout.write(`${JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2)}\n`);
  else for (const r of results) console.log(`${r.launcher.padEnd(22)} honored=${r.honored}  at: ${r.resultLocation ?? '-'}  ${r.notes ?? ''}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
