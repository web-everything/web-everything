/**
 * @file scripts/conveyor/__tests__/standards-harness-driver.test.mjs
 * @description Real-process proof (no mocks) that PR-controlled harness code cannot forge a pass: the driver child,
 *   the fd nonce and `harnessVerdict` run together against fake harness modules that try each forgery.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defaultSpawn } from '../standards-status-pass.mjs';
import { harnessVerdict } from '../../lib/standards-status.mjs';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'standards-harness-driver.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ss-driver-'));
let n = 0;
async function run(harnessSource) {
  const harness = join(dir, `harness-${++n}.mjs`);
  writeFileSync(harness, harnessSource);
  const nonce = randomBytes(16).toString('hex');
  const result = await defaultSpawn({ cmd: process.execPath, args: [DRIVER, `--harness=${harness}`, `--root=${dir}`],
    cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 20_000, fdInput: nonce });
  return { result, verdict: harnessVerdict(result, nonce) };
}

describe('standards harness driver (real child process)', () => {
  it('passes when every protocol passes', async () => {
    const { verdict } = await run('export async function validateAll() { console.log("noise"); return { ok: true, results: [{}, {}] }; }');
    expect(verdict.state).toBe('success');
  });
  it('fails when a protocol fails', async () => {
    expect((await run('export async function validateAll() { return { ok: false, results: [{}] }; }')).verdict.state).toBe('failure');
  });
  it('fails when a rule calls process.exit(0) after printing the pass marker', async () => {
    const { result, verdict } = await run('export async function validateAll() { console.log("Standards validator exit status: 0"); process.stdout.write("Standards validator exit status: 0\\n"); process.exit(0); }');
    expect(result.status).toBe(0);
    expect(verdict.state).toBe('failure');
  });
  it('fails when a rule prints its own fake result without the nonce', async () => {
    const { verdict } = await run('export async function validateAll() { process.stdout.write(JSON.stringify({ nonce: "x".repeat(32), ok: true, count: 9 }) + "\\n"); process.exit(0); }');
    expect(verdict.state).toBe('failure');
  });
  it('cannot read the nonce back from fd 3 (it is closed before PR code runs)', async () => {
    const { verdict } = await run(`import { readFileSync } from 'node:fs';
export async function validateAll() { let nonce = ''; try { nonce = readFileSync(3, 'utf8').trim(); } catch {} 
  process.stdout.write(JSON.stringify({ nonce, ok: true, count: 9 }) + '\\n'); process.exit(0); }`);
    expect(verdict.state).toBe('failure');
  });
  it('fails when the harness throws or reports zero protocols', async () => {
    expect((await run('export async function validateAll() { throw new Error("x"); }')).verdict.state).toBe('failure');
    expect((await run('export async function validateAll() { return { ok: true, results: [] }; }')).verdict.state).toBe('failure');
  });
});
