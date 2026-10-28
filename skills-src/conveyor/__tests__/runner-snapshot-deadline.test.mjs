// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b from '../../../scripts/conveyor/soak/breaks/runner-snapshot-blocks-deadlines.mjs';
import { makeCliMechanicalPasses, makeCliTickOnce, MECHANICAL_PASS_NAMES } from '../runner.mjs';
import { writeOpenPrSnapshot } from '../../../scripts/conveyor/open-pr-snapshot.mjs';

it('keeps the runner responsive and enforces an existing deadline during blocking snapshot discovery', async () => {
  const report = await b.run({ log: console.log });
  expect(b.judge(report)).toEqual([]);
});

it('shares only pending snapshots while overlapping ticks rerun independent passes and retain files through all consumers', async () => {
  const held = Promise.withResolvers();
  const heldConsumer = Promise.withResolvers();
  const calls = [];
  const files = [];
  const batches = [];
  let failFirst = true;
  let holdFirstConsumer = true;
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const runPass = vi.fn(async pass => {
    calls.push(pass);
    if (pass.passName === 'open-pr-snapshot') {
      const output = pass.entry.args.find(arg => arg.startsWith('--output=')).slice(9);
      files.push(output);
      if (pass.repo === 'web-everything/web-everything' && failFirst) {
        await held.promise;
        failFirst = false;
        return { code: 1, signal: null, stderr: 'discovery failed' };
      }
      writeOpenPrSnapshot({ repo: pass.repo, output }, { fetchOpenPrs: () => [{ number: 7 }] });
    } else {
      const flag = pass.entry.args.find(arg => arg.startsWith('--prs-file='));
      if (flag) expect(JSON.parse(readFileSync(flag.slice(11), 'utf8'))).toEqual([{ number: 7 }]);
      if (flag && pass.passName === 'parked-pr-progress-watch' && holdFirstConsumer) {
        holdFirstConsumer = false;
        await heldConsumer.promise;
        expect(JSON.parse(readFileSync(flag.slice(11), 'utf8'))).toEqual([{ number: 7 }]);
      }
    }
    return { code: 0, signal: null };
  });
  const passes = makeCliMechanicalPasses({
    scriptsDir: '/scripts', runPass,
    repos: { we: { slug: 'web-everything/web-everything' }, frontierui: { slug: 'frontier-ui/frontierui' } },
    skipPasses: new Set(MECHANICAL_PASS_NAMES.filter(name =>
      !['ci-queue-watch', 'duplicate-pr-watch', 'parked-pr-progress-watch'].includes(name))),
  });
  try {
    const pending = passes();
    const overlapping = passes();
    batches.push(pending, overlapping);
    expect(overlapping).not.toBe(pending);
    await vi.waitFor(() => expect(calls.some(pass =>
      pass.passName === 'parked-pr-progress-watch' && pass.repo === 'frontier-ui/frontierui')).toBe(true));
    expect(calls.filter(pass => pass.passName === 'ci-queue-watch')).toHaveLength(4);
    expect(calls.filter(pass => pass.passName === 'open-pr-snapshot')).toHaveLength(2);
    held.resolve();
    // The overlapping batch can finish without deleting the first batch's live file.
    await overlapping;
    const frontierFile = files[1];
    expect(existsSync(frontierFile)).toBe(true);
    heldConsumer.resolve();
    await Promise.all([pending, overlapping]);
    const duplicate = calls.filter(pass => pass.passName === 'duplicate-pr-watch');
    expect(duplicate).toHaveLength(2); // one per invocation, never an extra pre-fetch fallback
    for (const pass of duplicate) expect(pass.entry.args.some(arg => arg.startsWith('--prs-file='))).toBe(false);
    expect(warn.mock.calls.flat().join('')).toContain('open-pr-snapshot.mjs [we] failed');
    for (const file of files) expect(existsSync(file)).toBe(false);
    await passes();
    expect(calls.filter(pass => pass.passName === 'open-pr-snapshot')).toHaveLength(4);
    expect(new Set(files).size).toBe(4);
    for (const file of files) expect(existsSync(file)).toBe(false);
  } finally {
    held.resolve();
    heldConsumer.resolve();
    await Promise.allSettled(batches);
    warn.mockRestore();
  }
});

it('writes a private snapshot only after successful discovery and refuses overwriting one', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-pr-snapshot-'));
  const output = join(root, 'prs.json');
  const options = { repo: 'fixture/repo', output };
  try {
    expect(() => writeOpenPrSnapshot(options, { fetchOpenPrs: () => { throw new Error('offline'); } })).toThrow('offline');
    expect(existsSync(output)).toBe(false);
    writeOpenPrSnapshot(options, { fetchOpenPrs: () => [{ number: 42 }] });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(() => writeOpenPrSnapshot(options, { fetchOpenPrs: () => [] })).toThrow();
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([{ number: 42 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps deadline timers responsive while a later tick-core subprocess blocks and round-trips its input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-tick-deadline-'));
  const script = join(root, 'tick.mjs');
  writeFileSync(script, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const until = Date.now() + 400;
    while (Date.now() < until) {}
    process.stdout.write(JSON.stringify({ payload: JSON.parse(input), repo: process.argv[2] }));
  `);
  const started = Date.now();
  let timer;
  try {
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(Date.now() - started), 30); });
    const pending = makeCliTickOnce({ tickCorePath: script, repo: 'fixture/repo' })({ bookkeeping: { tick: 7 } });
    expect(await deadline).toBeLessThan(200);
    await expect(pending).resolves.toEqual({ payload: { bookkeeping: { tick: 7 } }, repo: '--repo=fixture/repo' });
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
});
