// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, redact, auditLines } from '../agent-command-audit.mjs';

const queue = 'node scripts/readiness/heavy-admission.mjs run -- ';
const claude = (command, timestamp = '2026-07-02T04:30:00Z') => JSON.stringify({ timestamp, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const codex = (args, name = 'exec_command') => JSON.stringify({ timestamp: '2026-07-02T04:30:00Z', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });

describe('agent command audit', () => {
  it.each(['pnpm exec playwright test a', 'yarn playwright test a'])('classifies package runner %s', command => {
    expect(classifyCommand(command)).toEqual([expect.objectContaining({ category: 'playwright', queued: false })]);
  });
  it.each(['npm run check:standards-extra', 'npm run test:unit-extra'])('does not admit a script-name prefix: %s', command => {
    expect(classifyCommand(command).some(row => row.queued)).toBe(false);
  });
  it('CLI includes requested-day commands from a resumed session in an earlier date directory', () => {
    const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'agent-command-audit-'));
    try {
      mkdirSync(join(home, '.claude/projects'), { recursive: true });
      const sessionDir = join(home, '.codex/sessions/2026/06/15');
      mkdirSync(sessionDir, { recursive: true });
      const earlier = JSON.parse(codex({ cmd: 'npm ci' }));
      earlier.timestamp = '2026-06-15T12:00:00Z';
      const later = JSON.parse(codex({ cmd: 'npm ci' }));
      later.timestamp = '2026-07-03T04:00:00Z';
      writeFileSync(join(sessionDir, 'resumed.jsonl'), [
        JSON.stringify(earlier),
        codex({ cmd: 'npx vitest run resumed.test.mjs' }),
        codex({ cmd: queue + 'npx playwright test resumed.spec.mjs' }),
        JSON.stringify(later),
      ].join('\n') + '\n');
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../agent-command-audit.mjs', import.meta.url)),
        '--date=2026-07-02', `--home=${home}`, '--json',
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.files).toBe(1);
      expect(report.rows).toHaveLength(2);
      expect(report.byCategory).toEqual({
        vitest: { queued: 0, bypassed: 1 },
        playwright: { queued: 1, bypassed: 0 },
      });
      expect(report.bySource).toEqual({
        'codex:.codex/sessions/2026/06/15/resumed.jsonl': { queued: 1, bypassed: 1 },
      });
      expect(report.invalidLines).toBe(0);
      expect(report.errors).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.each([
    ['for f in a b; do npx vitest run "$f"; done', 'vitest'],
    ['while read f; do npx vitest run $f; done < l', 'vitest'],
    ['if true; then npx vitest run a; fi', 'vitest'],
    ['gtimeout 5 npx vitest run a', 'vitest'],
    ['env -i X=1 timeout 5 npx vitest run a', 'vitest'],
    ["bash -lc 'npx vitest run a'", 'vitest'],
    ['timeout 290 npx vitest run a.test.mjs 2>&1 | tail -15', 'vitest'],
    ['timeout 5 npx playwright test a', 'playwright'],
    ['timeout 5 node --test a', 'node --test'],
    ['gtimeout 5 node scripts/check-standards.mjs', 'check:standards'],
    ['npm test -- a', 'npm test/check'], ['npm ci', 'install/ci'],
    ['git fetch origin', 'git fetch/clone/wt/gc'], ['rg needle .', 'repo-wide find/grep'],
  ])('classifies bypass %s', (cmd, category) => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category, queued: false })]);
  });
  it('keeps admission local to a segment, including inside a loop', () => {
    expect(classifyCommand(`for f in a; do ${queue}npx vitest run "$f"; done; npx vitest run b`).map(r => r.queued)).toEqual([true, false]);
    expect(classifyCommand('npm run test:unit -- a')[0].queued).toBe(true);
    expect(classifyCommand('npm run check:standards')[0].queued).toBe(true);
    expect(classifyCommand(queue + "bash -c 'npx vitest run a | tail -15'")[0].queued).toBe(true);
  });
  it.each(['echo npx vitest run', 'grep vitest x', 'rg needle scripts', 'rg --files scripts', 'find ./src -name x', 'npx vitest --version', 'git commit -m "npx vitest run"'])('ignores harmless mention %s', cmd => {
    expect(classifyCommand(cmd)).toEqual([]);
  });
  it('counts Claude and Codex JSONL by category and source, redacting output', () => {
    const fake = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = auditLines([
      claude(`npx vitest run a --token=${fake}`),
      codex({ cmd: queue + 'npx playwright test a' }),
      codex({ command: ['node', '--test', 'a'] }, 'local_shell'),
      JSON.stringify({ timestamp: '2026-07-02T04:30:00Z', payload: { type: 'custom_tool_call', name: 'functions.exec', input: 'await tools.exec_command({cmd: "npm ci"})' } }),
    ], { date: '2026-07-02' });
    expect(result.byCategory.vitest).toEqual({ queued: 0, bypassed: 1 });
    expect(result.byCategory.playwright).toEqual({ queued: 1, bypassed: 0 });
    expect(result.bySource).toEqual({ claude: { queued: 0, bypassed: 1 }, codex: { queued: 1, bypassed: 2 } });
    expect(JSON.stringify(result)).not.toContain(fake);
  });
  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz', 'github_pat_abcdefghijklmnopqrstuvwxyz',
    'sk-abcdefghijklmnopqrstuvwxyz', 'xoxb-abcdefghijklmnopqrstuvwxyz', 'Bearer fake.credentials',
    'API_KEY="short value"', 'TOKEN=short', "SECRET='short value'", 'tokenSensitive',
    '0123456789abcdef0123456789abcdef', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcdEFGH==',
  ])('redacts credential form %s', value => expect(redact(value)).toBe('[REDACTED]'));
  // Red-team #6461: a credential option's separate value must not survive when only the name is redacted.
  const fakeGl = 'glpat-12345678901234567890';
  it.each([
    `--token ${fakeGl}`, `--token=${fakeGl}`, `--token "${fakeGl}"`, `--token '${fakeGl}'`, `--token\t${fakeGl}`,
    `--auth-token ${fakeGl}`, `--access-token ${fakeGl}`, `--api-key ${fakeGl}`, `--apikey ${fakeGl}`,
    `--password ${fakeGl}`, `--passwd ${fakeGl}`, `--secret ${fakeGl}`, `--client-secret ${fakeGl}`,
    `--credentials ${fakeGl}`, `--private-key ${fakeGl}`, `--"token" ${fakeGl}`, `--to''ken ${fakeGl}`,
    `PASSWORD=${fakeGl}`, `GITLAB_AUTH=${fakeGl}`, fakeGl, 'gho_abcdefghijklmnopqrstuvwxyz', 'ghs_abcdefghijklmnopqrstuvwxyz',
    'npm_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP',
    `-H 'Authorization: token ${fakeGl}'`, `--header "Authorization: Basic ${fakeGl}"`,
    `https://user:${fakeGl}@example.com/x.git`,
  ])('redacts the value of credential form %s', value => {
    const out = redact(`npx vitest run a.test.mjs ${value}`);
    expect(out).not.toMatch(/glpat|1234567890|abcdefghij|ABCDEFGHIJ/);
    expect(out).toContain('[REDACTED]');
  });
  it('redacts a space-separated credential option through auditLines', () => {
    const report = JSON.stringify(auditLines([claude(`npx vitest run a.test.mjs --token ${fakeGl}`)], { date: '2026-07-02' }));
    expect(report).not.toContain('12345678901234567890');
    expect(report).toContain('vitest');
  });
  it('keeps ordinary flags readable', () => {
    expect(redact('npx vitest run a.test.mjs --run --bail=1')).toBe('npx vitest run a.test.mjs --run --bail=1');
  });
  it('uses ET boundaries in both winter and summer', () => {
    expect(auditLines([claude('npm ci', '2026-11-06T04:59:59Z')], { date: '2026-11-06' }).rows).toEqual([]);
    expect(auditLines([claude('npm ci', '2026-07-02T03:59:59Z')], { date: '2026-07-02' }).rows).toEqual([]);
    expect(auditLines([claude('npm ci', '2026-07-02T04:00:00Z')], { date: '2026-07-02' }).rows).toHaveLength(1);
  });
  it('reports malformed evidence and rejects invalid dates', () => {
    expect(auditLines(['{', 'null', claude('npm ci', 'bad')]).invalidLines).toBe(3);
    expect(() => auditLines([], { date: '2026-02-30' })).toThrow('Invalid --date');
  });
});
