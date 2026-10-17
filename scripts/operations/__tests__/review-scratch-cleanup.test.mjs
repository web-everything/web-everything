import { it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const roots = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const moduleUrl = pathToFileURL(resolve('scripts/operations/review-extra-seats.mjs')).href;
it('removes a checkout whose pinned fetch fails before makeScratch returns', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-failure-test-')); roots.push(tmp);
  const code = `import { createExtraSeatsIo } from ${JSON.stringify(moduleUrl)};
    try { createExtraSeatsIo().makeScratch({ lanePath: 'missing-repo', rev: 'a'.repeat(40) }); process.exitCode = 1; } catch {}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(readdirSync(tmp).filter(n => n.startsWith('we-review-seat-'))).toEqual([]);
});
it.each(['success', 'failure', 'SIGTERM', 'SIGINT', 'SIGHUP'])('removes owned checkout on %s', mode => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-cleanup-test-')); roots.push(tmp);
  const dir = join(tmp, 'checkout');
  const helper = pathToFileURL(resolve('scripts/lib/review-scratch.mjs')).href;
  const code = `import { mkdirSync } from 'node:fs'; import { ownReviewScratch } from ${JSON.stringify(helper)};
    mkdirSync(${JSON.stringify(dir)}); ownReviewScratch(${JSON.stringify(dir)});
    ${mode === 'failure' ? "throw new Error('failed seat')" : mode === 'success' ? '' : `process.kill(process.pid, '${mode}'); setTimeout(() => {}, 10000);`}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
  expect(existsSync(dir), r.stderr).toBe(false);
  if (mode === 'success') expect(r.status).toBe(0);
  else expect(r.status === 0).toBe(false);
});

const waitFor = async (predicate, detail = () => '') => {
  const until = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`subprocess did not reach expected state: ${detail()}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

// Use the real seat launcher and both providers' real exec/signal handlers, with a local
// inert model substituted at the spawn boundary. No provider CLI, quota or network access.
it.each(['codex', 'agy-gemini'].flatMap(provider =>
  ['SIGTERM', 'SIGINT', 'SIGHUP', 'repeated-signals', 'outer-wall', 'exit'].map(mode => [provider, mode])))
('stops the detached %s model before checkout cleanup on %s', async (provider, mode) => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-model-cleanup-')); roots.push(tmp);
  const dir = join(tmp, 'checkout'); mkdirSync(dir);
  const scripts = join(tmp, 'scripts'); mkdirSync(scripts);
  const pidFile = join(tmp, 'model-pid');
  const heartbeat = join(tmp, 'model-heartbeat');
  const termCheckout = join(tmp, 'term-checkout-present');
  const wrapperReady = join(tmp, 'wrapper-ready');
  const helper = pathToFileURL(resolve('scripts/lib/review-scratch.mjs')).href;
  const providerFile = provider === 'codex' ? 'codex-direct-task.mjs' : 'gemini-direct-task.mjs';
  const providerUrl = pathToFileURL(resolve('scripts', providerFile)).href;
  const execName = provider === 'codex' ? 'runCodexDirectExec' : 'runAgyDirectExec';
  const modelCode = `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); let n = 0;
    writeFileSync(${JSON.stringify(heartbeat)}, String(n));
    setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(++n)), 20);
    setTimeout(() => process.exit(0), 30000);`;
  writeFileSync(join(scripts, providerFile), `
    import { spawn } from 'node:child_process';
    import { writeFileSync, existsSync } from 'node:fs';
    import { ${execName} } from ${JSON.stringify(providerUrl)};
    // Delay the provider's handler so the test detects premature checkout removal too.
    process.prependListener('SIGTERM', () => {
      const until = Date.now() + 150; while (Date.now() < until) {}
      writeFileSync(${JSON.stringify(termCheckout)}, String(existsSync(${JSON.stringify(dir)})));
    });
    const work = ${execName}({ dir: ${JSON.stringify(dir)}, task: 'inert test',
      model: ${JSON.stringify(provider === 'codex' ? 'gpt-5.4' : 'gemini-3.1-pro')}, effort: 'high',
      review: true, timeoutMs: 60000, stream: false, logFile: ${JSON.stringify(join(tmp, 'model.log'))},
      spawnFn: (_cli, _argv, opts) => spawn(process.execPath,
        ['--input-type=module', '-e', ${JSON.stringify(modelCode)}], opts) });
    writeFileSync(${JSON.stringify(wrapperReady)}, String(process.pid)); await work;
  `);
  const code = `import { createExtraSeatsIo, killActiveSeats } from ${JSON.stringify(moduleUrl)};
    import { ownReviewScratch } from ${JSON.stringify(helper)};
    ownReviewScratch(${JSON.stringify(dir)}, killActiveSeats);
    const work = createExtraSeatsIo({ root: ${JSON.stringify(tmp)} }).runSeat({
      provider: ${JSON.stringify(provider)}, dir: ${JSON.stringify(dir)}, taskFile: 'unused',
      model: 'unused', effort: 'high', timeoutMs: ${mode === 'outer-wall' ? -85000 : 60000} });
    ${mode === 'exit' ? `const { existsSync } = await import('node:fs');
      const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(1); }, 20);` : ''}
    await work;
  `;
  let stderr = '';
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  launcher.stderr.on('data', d => { stderr += d; });
  let modelPid;
  try {
    await waitFor(() => existsSync(pidFile) && existsSync(wrapperReady) && existsSync(heartbeat), () => stderr);
    modelPid = Number(readFileSync(pidFile, 'utf8'));
    if (mode.startsWith('SIG')) launcher.kill(mode);
    if (mode === 'repeated-signals') {
      launcher.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 50));
      launcher.kill('SIGINT');
      launcher.kill('SIGHUP');
    }
    await waitFor(() => launcher.exitCode !== null || launcher.signalCode !== null, () => stderr);
    // An explicit synchronous exit may leave scratch for the TTL sweeper, but must
    // still stop the model. Signal and timeout paths finish cleanup before exiting.
    await waitFor(() => existsSync(termCheckout), () => `wrapper never received SIGTERM; ${stderr}`);
    expect(readFileSync(termCheckout, 'utf8'), stderr).toBe('true');
    await new Promise(r => setTimeout(r, 100));
    const beat = readFileSync(heartbeat, 'utf8');
    await new Promise(r => setTimeout(r, 200));
    expect(readFileSync(heartbeat, 'utf8'), `model survived launcher termination; ${stderr}`).toBe(beat);
    if (mode !== 'exit') expect(existsSync(dir), stderr).toBe(false);
  } finally {
    if (modelPid) { try { process.kill(-modelPid, 'SIGKILL'); } catch {} }
    if (existsSync(wrapperReady)) { try { process.kill(-Number(readFileSync(wrapperReady, 'utf8')), 'SIGKILL'); } catch {} }
    launcher.kill('SIGKILL');
  }
}, 45000);

it('stops a tool-free recheck even after the last owned checkout was released', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-recheck-cleanup-')); roots.push(tmp);
  const dir = join(tmp, 'checkout'); mkdirSync(dir);
  const helper = pathToFileURL(resolve('scripts/lib/review-scratch.mjs')).href;
  const ready = join(tmp, 'ready');
  const beat = join(tmp, 'heartbeat');
  const model = `import { writeFileSync } from 'node:fs'; let n = 0;
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    writeFileSync(${JSON.stringify(beat)}, String(n));
    setInterval(() => writeFileSync(${JSON.stringify(beat)}, String(++n)), 20);
    setTimeout(() => process.exit(), 30000);`;
  const code = `import { createRedTeamIo, killActiveSeats } from ${JSON.stringify(moduleUrl)};
    import { ownReviewScratch, removeReviewScratch } from ${JSON.stringify(helper)};
    ownReviewScratch(${JSON.stringify(dir)}, killActiveSeats); removeReviewScratch(${JSON.stringify(dir)});
    const io = createRedTeamIo({ spawnRecheck: async ({ spawnFn }) => {
      const child = spawnFn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(model)}], { stdio: 'ignore' });
      await new Promise(r => child.once('close', r)); return { value: { checks: [] } };
    }});
    await io.runRecheck({ pr: 1, readsRepo: false, mandate: 'test', input: 'test', shape: {} });`;
  let stderr = '';
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  launcher.stderr.on('data', d => { stderr += d; });
  try {
    await waitFor(() => existsSync(ready) && existsSync(beat), () => stderr);
    launcher.kill('SIGTERM');
    await waitFor(() => launcher.signalCode !== null || launcher.exitCode !== null, () => stderr);
    const before = readFileSync(beat, 'utf8');
    await new Promise(r => setTimeout(r, 200));
    expect(readFileSync(beat, 'utf8'), stderr).toBe(before);
    expect(launcher.signalCode).toBe('SIGTERM');
  } finally {
    if (existsSync(ready)) { try { process.kill(-Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch {} }
    launcher.kill('SIGKILL');
  }
}, 30000);

it('retains scratch through caller finally when the outer-wall stop cannot close the wrapper', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-stuck-cleanup-')); roots.push(tmp);
  const dir = join(tmp, 'checkout'); mkdirSync(dir);
  mkdirSync(join(tmp, 'scripts'));
  const ready = join(tmp, 'ready');
  const result = join(tmp, 'result');
  writeFileSync(join(tmp, 'scripts', 'codex-direct-task.mjs'), `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000);
  `);
  const helper = pathToFileURL(resolve('scripts/lib/review-scratch.mjs')).href;
  const code = `import { createExtraSeatsIo, killActiveSeats } from ${JSON.stringify(moduleUrl)};
    import { ownReviewScratch, removeReviewScratch } from ${JSON.stringify(helper)};
    import { writeFileSync } from 'node:fs';
    ownReviewScratch(${JSON.stringify(dir)}, killActiveSeats);
    let r;
    try { r = await createExtraSeatsIo({ root: ${JSON.stringify(tmp)} }).runSeat({
      provider: 'codex', dir: ${JSON.stringify(dir)}, taskFile: 'unused', model: 'unused', effort: 'high', timeoutMs: -85000 });
    } finally { removeReviewScratch(${JSON.stringify(dir)}); }
    writeFileSync(${JSON.stringify(result)}, JSON.stringify(r)); process.exit(0);`;
  let stderr = '';
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  launcher.stderr.on('data', d => { stderr += d; });
  try {
    await waitFor(() => launcher.exitCode !== null, () => stderr);
    expect(launcher.exitCode, stderr).toBe(0);
    expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({ timedOut: true, error: 'review seat did not close after stop' });
    expect(existsSync(dir)).toBe(true);
  } finally {
    if (existsSync(ready)) { try { process.kill(-Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch {} }
    launcher.kill('SIGKILL');
  }
}, 30000);
