/** R804 acceptance: append-only, identity-bound operator reset for the restart counter. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T18:00:00Z');
const prHead = `${REPO}#11@${HEAD}`;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'stall-reset-r804-'));
  roots.push(root);
  const dir = join(root, 'pr-stall-sweep');
  return { dir, repo: REPO, pr: 11, head: HEAD, actor: 'human-operator', reason: 'inspected and repaired dead owner', ruling: 'R804', now: NOW };
};
const files = dir => existsSync(dir) ? readdirSync(dir).sort() : [];
const records = dir => files(dir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name))
  .flatMap(name => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
// Load inside each case: the missing step-2 implementation must produce named failures, not a collection error.
const loadReset = async () => {
  const modulePath = '../pr-stall-reset.mjs';
  const module = await import(/* @vite-ignore */ modulePath);
  expect(module.resetRestartCounter).toBeTypeOf('function');
  return module.resetRestartCounter;
};

describe('R804 operator reset acceptance', () => {
  it('R804 reset appends operator-reset bound to exact repo PR head with actor reason ruling and timestamp', async () => {
    const resetRestartCounter = await loadReset();
    const input = fixture();
    await resetRestartCounter(input);
    expect(records(input.dir)).toEqual([expect.objectContaining({ phase: 'operator-reset', repo: REPO, pr: 11, head: HEAD,
      prHead, actor: input.actor, reason: input.reason, ruling: 'R804', ts: new Date(NOW).toISOString() })]);
  });
  it('R804 reset preserves every existing audit byte across months and only appends', async () => {
    const resetRestartCounter = await loadReset();
    const input = fixture();
    mkdirSync(input.dir, { recursive: true });
    const previousMonth = '{"phase":"pass","ts":"2026-09-30T18:00:00Z"}\n';
    const currentMonth = JSON.stringify({ phase: 'intent', ts: '2026-10-21T15:00:00Z', action: 'restart-red-team',
      prHead, key: `${prHead}:red-team-pending:restart-1` }) + '\n';
    writeFileSync(join(input.dir, '2026-09.jsonl'), previousMonth);
    writeFileSync(join(input.dir, '2026-10.jsonl'), currentMonth);
    await resetRestartCounter(input);
    expect(readFileSync(join(input.dir, '2026-09.jsonl'), 'utf8')).toBe(previousMonth);
    const after = readFileSync(join(input.dir, '2026-10.jsonl'), 'utf8');
    expect(after.startsWith(currentMonth)).toBe(true);
    const appended = after.slice(currentMonth.length).trim().split('\n').map(line => JSON.parse(line));
    expect(appended).toEqual([expect.objectContaining({ phase: 'operator-reset', prHead })]);
    expect(files(input.dir)).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
  });
  it.each(['dir', 'repo', 'pr', 'head', 'actor', 'reason', 'ruling'])(
    'R804 missing required %s throws and writes nothing', async field => {
      const resetRestartCounter = await loadReset();
      const input = fixture();
      const dir = input.dir;
      delete input[field];
      await expect(async () => resetRestartCounter(input)).rejects.toThrow();
      expect(files(dir)).toEqual([]);
    });
  it.each(['actor', 'reason', 'ruling'])('R804 blank %s throws and writes nothing', async field => {
    const resetRestartCounter = await loadReset();
    const input = fixture();
    await expect(async () => resetRestartCounter({ ...input, [field]: '   ' })).rejects.toThrow();
    expect(files(input.dir)).toEqual([]);
  });
  it.each(['', 'abc123', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), `${HEAD}\n`])(
    'R804 invalid head %j throws and writes nothing', async head => {
      const resetRestartCounter = await loadReset();
      const input = fixture();
      await expect(async () => resetRestartCounter({ ...input, head })).rejects.toThrow();
      expect(files(input.dir)).toEqual([]);
    });
  it.each(['whatever', 'R805', 'r804', ' R804', 'R804 '])('R804 unknown ruling %j throws and writes nothing', async ruling => {
    const resetRestartCounter = await loadReset();
    const input = fixture();
    await expect(async () => resetRestartCounter({ ...input, ruling })).rejects.toThrow(/ruling/);
    expect(files(input.dir)).toEqual([]);
  });
  it('R804 rejected reset leaves existing audit history byte-for-byte unchanged', async () => {
    const resetRestartCounter = await loadReset();
    const input = fixture();
    mkdirSync(input.dir, { recursive: true });
    const path = join(input.dir, '2026-10.jsonl');
    const before = '{"phase":"pass","ts":"2026-10-21T15:00:00Z"}\n';
    writeFileSync(path, before);
    const { ruling, ...missingRuling } = input;
    await expect(async () => resetRestartCounter(missingRuling)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(files(input.dir)).toEqual(['2026-10.jsonl']);
  });

  const cli = (input, omit = []) => {
    const values = { repo: input.repo, pr: String(input.pr), head: input.head, actor: input.actor, reason: input.reason, ruling: input.ruling };
    const args = Object.entries(values).filter(([name]) => !omit.includes(name)).map(([name, value]) => `--${name}=${value}`);
    return spawnSync(process.execPath, ['scripts/conveyor/pr-stall-reset.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WE_PR_STALL_SWEEP_DIR: input.dir },
    });
  };
  it('R804 CLI accepts repo pr 40-hex head actor reason and ruling=R804 and appends the reset', async () => {
    await loadReset();
    const input = fixture();
    const result = cli(input);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(records(input.dir)).toEqual([expect.objectContaining({ phase: 'operator-reset', prHead,
      actor: input.actor, reason: input.reason, ruling: 'R804' })]);
  });
  it.each(['ruling', 'actor', 'reason', 'repo', 'pr', 'head'])(
    'R804 CLI missing --%s exits nonzero and writes nothing', async field => {
      await loadReset();
      const input = fixture();
      const result = cli(input, [field]);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(files(input.dir)).toEqual([]);
    });
  it('R804 CLI unknown --ruling exits nonzero and writes nothing', async () => {
    await loadReset();
    const input = { ...fixture(), ruling: 'whatever' };
    const result = cli(input);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(files(input.dir)).toEqual([]);
  });
  it('R804 CLI bad head exits nonzero and writes nothing', async () => {
    await loadReset();
    const input = { ...fixture(), head: 'not-a-sha' };
    const result = cli(input);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(files(input.dir)).toEqual([]);
  });
});
